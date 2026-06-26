//! Tier 2: 실제 셸 컨텍스트 메뉴(IContextMenu) 호스팅 — Explorer/TC 와 동일하게 셸에
//! 위임해 이름·필터·COM 핸들러(7-Zip 등)·서브메뉴를 정확히 가져온다.
//!
//! **핫 스레드**: COM STA 전용 스레드를 *하나만* 앱 수명 내내 살려둔다(CoUninitialize 안
//! 함). 그래야 셸 확장 핸들러가 메모리에 따뜻하게 남아, 탐색기처럼 둘째 우클릭부터 빠르다.
//! (매 클릭마다 스레드+COM 을 차갑게 재로딩하던 게 느림의 근본 원인이었다.)
//!
//! 흐름: 명령은 Build/Invoke/Close 요청을 채널로 워커에 보낸다. 워커가 IContextMenu+HMENU
//! 를 만들어 token 으로 보관(COM 객체는 이 스레드에 affinity), Build 응답으로 enumerate 한
//! items 를 돌려준다. 프론트가 항목 클릭 시 Invoke(token, id), 메뉴 닫힘 시 Close(token).
//!
//! 모든 COM 호출은 unsafe — platform/ 한정(§8). 의존성 `windows`(§6 승인).

use std::collections::{HashMap, VecDeque};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;

use windows::core::{PCSTR, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::HBITMAP;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    IContextMenu, IShellFolder, SHBindToParent, SHParseDisplayName, CMF_NORMAL, CMINVOKECOMMANDINFO,
};
use windows::Win32::UI::WindowsAndMessaging::HMENU;
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, GetMenuItemCount, GetMenuItemInfoW, MENUITEMINFOW, MFS_DISABLED,
    MFS_GRAYED, MFT_SEPARATOR, MIIM_BITMAP, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING,
    MIIM_SUBMENU, SW_SHOWNORMAL,
};

use crate::platform::{ShellMenuItem, ShellScope};

const ID_FIRST: u32 = 1;
const ID_LAST: u32 = 0x7FFF;
const MAX_DEPTH: u32 = 6;
/// 보관 중인 열린 메뉴 상한 — 정상엔 1개지만, Close 누락 대비 누수 방지(초과 시 오래된 것 파기).
const MAX_OPEN: usize = 8;

/// 워커로 보내는 요청.
enum Req {
    Build {
        token: u64,
        hwnd: isize,
        path: PathBuf,
        scope: ShellScope,
        reply: tokio::sync::oneshot::Sender<Vec<ShellMenuItem>>,
    },
    Invoke {
        token: u64,
        cmd_id: u32,
    },
    Close {
        token: u64,
    },
    /// 핸들러 예열 — 메뉴를 만들었다 바로 버린다(셸 확장 COM 을 메모리에 로드만).
    Prewarm {
        hwnd: isize,
        path: PathBuf,
    },
}

/// 핫 COM 스레드 핸들 — 명령 레이어가 Build/Invoke/Close 를 보낸다. 첫 사용 시 lazy 생성.
pub struct Worker {
    tx: mpsc::Sender<Req>,
}

impl Worker {
    /// COM STA 워커 스레드 spawn (앱 수명 내내 유지). 한 번만 호출(레지스트리 OnceLock).
    pub fn start() -> Worker {
        let (tx, rx) = mpsc::channel::<Req>();
        std::thread::spawn(move || worker_loop(rx));
        Worker { tx }
    }

    /// token 으로 메뉴 빌드 요청 후 enumerate 된 항목을 받는다(채널 끊기면 빈 벡터).
    pub async fn build(
        &self,
        token: u64,
        hwnd: isize,
        path: PathBuf,
        scope: ShellScope,
    ) -> Vec<ShellMenuItem> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        if self
            .tx
            .send(Req::Build {
                token,
                hwnd,
                path,
                scope,
                reply,
            })
            .is_err()
        {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    pub fn invoke(&self, token: u64, cmd_id: u32) {
        let _ = self.tx.send(Req::Invoke { token, cmd_id });
    }

    pub fn close(&self, token: u64) {
        let _ = self.tx.send(Req::Close { token });
    }

    /// 시작 시 호출 — 셸 핸들러를 백그라운드로 예열(첫 우클릭도 빠르게).
    pub fn prewarm(&self, hwnd: isize, path: PathBuf) {
        let _ = self.tx.send(Req::Prewarm { hwnd, path });
    }
}

/// 워커 루프 — COM 한 번 초기화(끝까지 유지), 요청을 직렬 처리. IContextMenu 는 이 스레드에만.
fn worker_loop(rx: mpsc::Receiver<Req>) {
    // SAFETY: 이 스레드용 STA COM 초기화. CoUninitialize 안 함(핸들러 warm 유지가 목적).
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };

    // token → (IContextMenu, HMENU, owner hwnd). cm 은 invoke 까지 살아 있어야 함.
    let mut open: HashMap<u64, (IContextMenu, HMENU, isize)> = HashMap::new();
    let mut order: VecDeque<u64> = VecDeque::new();

    let destroy = |open: &mut HashMap<u64, (IContextMenu, HMENU, isize)>, token: u64| {
        if let Some((_cm, hmenu, _)) = open.remove(&token) {
            // SAFETY: 우리가 만든 HMENU 파기. cm 은 drop 시 Release(이 스레드).
            unsafe {
                let _ = DestroyMenu(hmenu);
            }
        }
    };

    while let Ok(req) = rx.recv() {
        match req {
            Req::Build {
                token,
                hwnd,
                path,
                scope,
                reply,
            } => {
                // SAFETY: 셸 객체 생성/열거는 이 스레드에서만.
                let items = match unsafe { build_menu(HWND(hwnd as *mut _), &path, scope) } {
                    Ok((cm, hmenu)) => {
                        let items = unsafe { enumerate(hmenu, 0) };
                        open.insert(token, (cm, hmenu, hwnd));
                        order.push_back(token);
                        while order.len() > MAX_OPEN {
                            if let Some(old) = order.pop_front() {
                                destroy(&mut open, old);
                            }
                        }
                        items
                    }
                    Err(_) => Vec::new(),
                };
                let _ = reply.send(items);
            }
            Req::Invoke { token, cmd_id } => {
                if let Some((cm, _, hwnd)) = open.get(&token) {
                    if (ID_FIRST..=ID_LAST).contains(&cmd_id) {
                        // SAFETY: cm 은 이 스레드에서 만든 살아있는 IContextMenu.
                        let _ = unsafe { invoke(cm, HWND(*hwnd as *mut _), cmd_id) };
                    }
                }
                order.retain(|t| *t != token);
                destroy(&mut open, token);
            }
            Req::Close { token } => {
                order.retain(|t| *t != token);
                destroy(&mut open, token);
            }
            Req::Prewarm { hwnd, path } => {
                // 메뉴를 만들었다 즉시 버린다 — 핸들러 COM 만 메모리에 로드(warm).
                // SAFETY: 셸 객체 생성/파기 전부 이 스레드에서.
                if let Ok((_cm, hmenu)) =
                    unsafe { build_menu(HWND(hwnd as *mut _), &path, scope_dir()) }
                {
                    unsafe {
                        let _ = DestroyMenu(hmenu);
                    }
                }
            }
        }
    }
}

/// prewarm 용 더미 scope (build_menu 는 scope 를 안 쓰지만 시그니처상 필요).
fn scope_dir() -> ShellScope {
    ShellScope::Directory
}

/// 경로 → IContextMenu + 채워진 HMENU. (모든 호출 unsafe COM)
unsafe fn build_menu(
    hwnd: HWND,
    path: &Path,
    _scope: ShellScope,
) -> windows::core::Result<(IContextMenu, HMENU)> {
    // 경로 → 절대 PIDL.
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
    SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None)?;

    // 부모 IShellFolder + 자식(상대) PIDL. (riid/ppv 는 제네릭 반환으로 접힘 — windows 0.58)
    let mut child: *mut ITEMIDLIST = std::ptr::null_mut();
    let parent: IShellFolder = SHBindToParent(pidl, Some(&mut child))?;

    // IContextMenu 획득.
    let cm: IContextMenu = parent.GetUIObjectOf(hwnd, &[child as *const ITEMIDLIST], None)?;

    // 절대 PIDL 해제(자식 PIDL 은 부모 소유라 해제 X).
    CoTaskMemFree(Some(pidl as *const _));

    // HMENU 구성.
    let hmenu = CreatePopupMenu()?;
    cm.QueryContextMenu(hmenu, 0, ID_FIRST, ID_LAST, CMF_NORMAL)?;
    Ok((cm, hmenu))
}

/// HMENU 를 재귀 열거 → ShellMenuItem 트리. (unsafe Win32)
unsafe fn enumerate(hmenu: HMENU, depth: u32) -> Vec<ShellMenuItem> {
    if depth > MAX_DEPTH {
        return Vec::new();
    }
    let count = GetMenuItemCount(hmenu);
    if count <= 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for i in 0..count {
        let mut buf = [0u16; 260];
        let mut mii = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_STRING | MIIM_ID | MIIM_SUBMENU | MIIM_FTYPE | MIIM_STATE | MIIM_BITMAP,
            dwTypeData: windows::core::PWSTR(buf.as_mut_ptr()),
            cch: buf.len() as u32,
            ..Default::default()
        };
        if GetMenuItemInfoW(hmenu, i as u32, true, &mut mii).is_err() {
            continue;
        }
        let is_sep = (mii.fType.0 & MFT_SEPARATOR.0) != 0;
        if is_sep {
            out.push(ShellMenuItem {
                id: 0,
                label: String::new(),
                separator: true,
                disabled: false,
                children: Vec::new(),
                icon: None,
            });
            continue;
        }
        let label = strip_accelerator(&String::from_utf16_lossy(&buf[..mii.cch as usize]));
        if label.trim().is_empty() {
            continue;
        }
        let disabled = (mii.fState.0 & (MFS_DISABLED.0 | MFS_GRAYED.0)) != 0;
        let children = if !mii.hSubMenu.0.is_null() {
            enumerate(mii.hSubMenu, depth + 1)
        } else {
            Vec::new()
        };
        // 항목 아이콘 — hbmpItem 이 실제 HBITMAP 이면(HBMMENU_* 센티넬 1..=13 / CALLBACK(-1) /
        // null 제외) PNG 로. 셸 확장이 set 한 16px 비트맵.
        let addr = mii.hbmpItem.0 as usize;
        let icon = if addr > 13 && addr != usize::MAX {
            hbitmap_to_png(mii.hbmpItem)
        } else {
            None
        };
        out.push(ShellMenuItem {
            id: mii.wID,
            label,
            separator: false,
            disabled,
            children,
            icon,
        });
    }
    out
}

/// 메뉴 항목 HBITMAP(보통 16px, 셸 확장 set) → PNG 바이트. 알파 보존(없으면 불투명).
///
/// SAFETY: `hbitmap` 은 유효한 GDI 비트맵 핸들이어야 한다.
unsafe fn hbitmap_to_png(hbitmap: HBITMAP) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HGDIOBJ,
    };

    let mut bmp = BITMAP::default();
    let got = GetObjectW(
        HGDIOBJ(hbitmap.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bmp as *mut _ as *mut c_void),
    );
    // 메뉴 아이콘은 작음 — 비정상/거대 비트맵은 스킵.
    if got == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 || bmp.bmWidth > 256 || bmp.bmHeight > 256
    {
        return None;
    }
    let w = bmp.bmWidth;
    let h = bmp.bmHeight;

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
    let hdc = GetDC(None);
    let scan = GetDIBits(
        hdc,
        hbitmap,
        0,
        h as u32,
        Some(buf.as_mut_ptr() as *mut c_void),
        &mut info,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);
    if scan == 0 {
        return None;
    }

    // BGRA → RGBA. 알파 채널이 전부 0(24bpp 비트맵 등)이면 불투명 처리, 있으면
    // premultiplied 로 보고 straight 로 환산.
    let has_alpha = buf.chunks_exact(4).any(|p| p[3] != 0);
    let mut rgba = Vec::with_capacity(buf.len());
    for p in buf.chunks_exact(4) {
        let (b, g, r, a) = (p[0], p[1], p[2], p[3]);
        if has_alpha {
            let a = a as u32;
            let un = |c: u8| {
                if a > 0 {
                    ((c as u32 * 255 / a).min(255)) as u8
                } else {
                    0
                }
            };
            rgba.push(un(r));
            rgba.push(un(g));
            rgba.push(un(b));
            rgba.push(a as u8);
        } else {
            rgba.push(r);
            rgba.push(g);
            rgba.push(b);
            rgba.push(255);
        }
    }
    let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba)?;
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut out, image::ImageFormat::Png)
        .ok()?;
    Some(out.into_inner())
}

/// 선택한 명령 실행. cmd_id 는 절대 id → InvokeCommand 는 offset(id-ID_FIRST) 필요.
unsafe fn invoke(cm: &IContextMenu, hwnd: HWND, cmd_id: u32) -> windows::core::Result<()> {
    let offset = cmd_id - ID_FIRST;
    let info = CMINVOKECOMMANDINFO {
        cbSize: std::mem::size_of::<CMINVOKECOMMANDINFO>() as u32,
        hwnd,
        lpVerb: PCSTR(offset as usize as *const u8), // MAKEINTRESOURCEA(offset)
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    cm.InvokeCommand(&info)
}

/// 메뉴 라벨에서 `&` 가속기 제거 ("E&dit" → "Edit", "&&" → "&").
fn strip_accelerator(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                out.push('&');
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out
}
