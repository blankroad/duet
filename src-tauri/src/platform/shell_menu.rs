//! Tier 2: 실제 셸 컨텍스트 메뉴(IContextMenu) 호스팅 — Explorer/TC 와 동일하게 셸에
//! 위임해 이름·필터·COM 핸들러(7-Zip 등)·서브메뉴를 정확히 가져온다.
//!
//! 흐름: COM STA 전용 스레드에서 IContextMenu + HMENU 를 만들고, HMENU 를 재귀
//! 열거해 프론트로 보낸 뒤, 그 스레드를 **살려둔 채** 프론트 선택을 기다렸다가 같은
//! 스레드에서 InvokeCommand 한다(COM 객체는 만든 스레드에 affinity 가 있음).
//!
//! 모든 COM 호출은 unsafe — platform/ 한정(§8). 새 의존성 `windows`(§6 승인).

use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use windows::core::{PCSTR, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    IContextMenu, IShellFolder, SHBindToParent, SHParseDisplayName, CMINVOKECOMMANDINFO, CMF_NORMAL,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, GetMenuItemCount, GetMenuItemInfoW, MENUITEMINFOW, MFS_DISABLED,
    MFS_GRAYED, MFT_SEPARATOR, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING, MIIM_SUBMENU,
    SW_SHOWNORMAL,
};

use crate::platform::{
    strip_accelerator, ShellMenu, ShellMenuAction, ShellMenuItem, ShellMenuRegistry, ShellScope,
};
use crate::types::DuetError;

const ID_FIRST: u32 = 1;
const ID_LAST: u32 = 0x7FFF;
const MAX_DEPTH: u32 = 6;

/// 셸 메뉴 세션 시작 — STA 스레드 spawn, HMENU 열거 결과를 받아 반환. 세션은 token 으로
/// 살아 있으며 invoke/close 를 기다린다.
pub async fn open(
    registry: Arc<ShellMenuRegistry>,
    hwnd: isize,
    path: std::path::PathBuf,
    scope: ShellScope,
) -> Result<ShellMenu, DuetError> {
    let token = registry.alloc();
    let (action_tx, action_rx) = mpsc::channel::<ShellMenuAction>();
    registry.register(token, action_tx);
    let (items_tx, items_rx) = tokio::sync::oneshot::channel::<Vec<ShellMenuItem>>();

    let reg2 = registry.clone();
    std::thread::spawn(move || {
        run_session(reg2, token, hwnd, &path, scope, items_tx, action_rx);
    });

    let items = items_rx
        .await
        .map_err(|_| DuetError::Io("shell menu: session aborted before items".into()))?;
    Ok(ShellMenu { token, items })
}

/// STA 세션 스레드 — COM init → 메뉴 구성 → items 송신 → 선택 대기 → invoke → 정리.
fn run_session(
    registry: Arc<ShellMenuRegistry>,
    token: u64,
    hwnd: isize,
    path: &Path,
    scope: ShellScope,
    items_tx: tokio::sync::oneshot::Sender<Vec<ShellMenuItem>>,
    action_rx: mpsc::Receiver<ShellMenuAction>,
) {
    // SAFETY: 이 스레드용 STA COM 초기화. 짝으로 CoUninitialize.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };

    // SAFETY: 셸 객체 생성/열거/실행은 전부 이 스레드에서만.
    let built = unsafe { build_menu(HWND(hwnd as *mut _), path, scope) };
    match built {
        Ok((cm, hmenu)) => {
            let items = unsafe { enumerate(hmenu, 0) };
            let _ = items_tx.send(items);
            // 프론트 선택 대기(닫힘/타임아웃 안전장치 120s).
            if let Ok(ShellMenuAction::Invoke(cmd_id)) =
                action_rx.recv_timeout(Duration::from_secs(120))
            {
                if (ID_FIRST..=ID_LAST).contains(&cmd_id) {
                    // SAFETY: cm 는 이 스레드에서 만든 살아있는 IContextMenu.
                    let _ = unsafe { invoke(&cm, HWND(hwnd as *mut _), cmd_id) };
                }
            }
            // SAFETY: 우리가 만든 HMENU 해제. cm 은 스코프 종료 시 Release.
            unsafe {
                let _ = DestroyMenu(hmenu);
            }
        }
        Err(_) => {
            let _ = items_tx.send(Vec::new());
        }
    }

    registry.remove(token);
    // SAFETY: 위 CoInitializeEx 와 짝.
    unsafe { CoUninitialize() };
}

/// 경로 → IContextMenu + 채워진 HMENU. (모든 호출 unsafe COM)
unsafe fn build_menu(
    hwnd: HWND,
    path: &Path,
    _scope: ShellScope,
) -> windows::core::Result<(IContextMenu, HMENU_)> {
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
unsafe fn enumerate(hmenu: HMENU_, depth: u32) -> Vec<ShellMenuItem> {
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
            fMask: MIIM_STRING | MIIM_ID | MIIM_SUBMENU | MIIM_FTYPE | MIIM_STATE,
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
            });
            continue;
        }
        let label = strip_accelerator(&String::from_utf16_lossy(&buf[..mii.cch as usize]));
        if label.trim().is_empty() {
            continue;
        }
        let disabled = (mii.fState.0 & (MFS_DISABLED.0 | MFS_GRAYED.0)) != 0;
        let children = if mii.hSubMenu.0 != std::ptr::null_mut() {
            enumerate(mii.hSubMenu, depth + 1)
        } else {
            Vec::new()
        };
        out.push(ShellMenuItem {
            id: mii.wID,
            label,
            separator: false,
            disabled,
            children,
        });
    }
    out
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

// HMENU 별칭 — windows 0.58 의 HMENU 타입.
use windows::Win32::UI::WindowsAndMessaging::HMENU as HMENU_;
