//! OS 파일 클립보드 쓰기 — 인앱 Ctrl+C 큐를 시스템 클립보드에도 반영한다.
//!
//! 이게 없으면 duet 의 복사는 duet 안에서만 유효하다(Finder/탐색기·클립보드 동기화 도구가
//! 볼 수 없다). 각 OS 의 "파일 목록" 표현은 서로 달라 여기서 흡수한다:
//!
//! | OS | 표현 | 방법 |
//! |---|---|---|
//! | macOS | `NSFilenamesPboardType`(경로 배열 plist) → OS 가 `public.file-url` 로 브리지 | osascript(JXA) |
//! | Windows | `CF_HDROP`(DROPFILES + UTF-16 이중 널 목록) | Win32 API |
//! | Linux | `text/uri-list`(file:// URI 줄바꿈 구분) | `wl-copy`/`xclip` (있으면) |
//!
//! 순수 변환 함수(`wide_file_list`, `uri_list`)는 OS 와 무관하게 테스트한다 — 가장 틀리기 쉬운
//! 부분이 바이트 레이아웃과 인코딩이기 때문이다.

use crate::types::DuetError;
use std::path::{Path, PathBuf};

/// `CF_HDROP` 페이로드의 경로 목록 부분 — UTF-16, 각 경로 뒤 널, 목록 끝에 널 하나 더.
///
/// Windows 전용 형식이지만 순수 변환이라 모든 OS 에서 테스트한다.
#[cfg_attr(not(windows), allow(dead_code))]
fn wide_file_list(paths: &[PathBuf]) -> Vec<u16> {
    let mut out = Vec::new();
    for p in paths {
        out.extend(encode_wide(p));
        out.push(0);
    }
    out.push(0); // 목록 종료(이중 널)
    out
}

/// 경로 → UTF-16 코드 유닛. Windows 는 OS 문자열이 이미 UTF-16 이라 무손실이고,
/// 다른 OS 에서는 테스트를 위해 문자 단위로 변환한다(§7 — 경로 문자열 조작 아님).
#[cfg_attr(not(windows), allow(dead_code))]
fn encode_wide(path: &Path) -> Vec<u16> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().collect()
    }
    #[cfg(not(windows))]
    {
        path.as_os_str().to_string_lossy().encode_utf16().collect()
    }
}

/// `text/uri-list` 본문 — `file://` + percent-encoded 절대경로, CRLF 구분(RFC 2483).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn uri_list(paths: &[PathBuf]) -> String {
    let mut s = String::new();
    for p in paths {
        s.push_str("file://");
        s.push_str(&percent_encode_path(&p.to_string_lossy()));
        s.push_str("\r\n");
    }
    s
}

/// URI 경로 구획용 최소 percent-encoding — unreserved + `/` 만 그대로 두고 나머지는 %XX.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '/') {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// duet 이 마지막으로 OS 클립보드에 파일 목록과 **함께 실은 소유 표식**(nonce). None = 클립보드에
/// 우리 것이 없거나 표식을 실을 수 없는 OS(Linux).
///
/// 이 잠금은 OS 쓰기·지우기 **전체**를 감싼다 — duet 의 Ctrl+C 들이 `spawn_blocking` 으로 동시에
/// 돌아도 "쓰기 → 표식 기록" 순서가 뒤바뀌어 낡은 표식이 남는 일이 없게.
static OWNED: std::sync::Mutex<Option<u64>> = std::sync::Mutex::new(None);

/// 쓰기마다 새 표식 — 시각(ns)과 증가 카운터를 섞는다. 0 은 쓰지 않는다.
fn new_nonce() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    (t ^ SEQ.fetch_add(1, Ordering::Relaxed).rotate_left(32)) | 1
}

/// 파일 경로들을 OS 클립보드에 올린다. 미지원 OS 는 `NotSupported`.
pub fn set(paths: &[PathBuf]) -> Result<(), DuetError> {
    if paths.is_empty() {
        return Err(DuetError::Io("no paths to copy".into()));
    }
    set_with(&OWNED, new_nonce(), |nonce| set_os(paths, nonce))
}

/// OS 클립보드가 **아직 duet 이 마지막으로 올린 파일 목록이면** 비운다. 비웠으면 true.
///
/// 원격(SSH) 항목 Ctrl+C 처럼 OS 클립보드에 올릴 수 없는 복사가 일어났을 때 쓴다 — 안 그러면
/// 예전 로컬 복사가 남아 Finder/탐색기 붙여넣기가 엉뚱한 파일을 붙인다(fileops-36).
///
/// 판정은 파일 목록과 같이 실은 소유 표식으로 한다 — 그사이 다른 앱이 무언가를 복사했다면 표식이
/// 없어지므로 건드리지 않는다. Windows 는 클립보드를 연(다른 앱이 못 쓰는) 상태에서 표식 확인과
/// 비우기를 하므로 끼어들 틈이 없다. macOS 는 pasteboard 잠금 API 가 없어, 한 osascript 안의
/// 확인과 비우기 사이(수 ms 미만)에 다른 앱이 쓰면 그 내용이 지워질 수 있다 — 최선 노력.
pub fn clear_if_owned() -> Result<bool, DuetError> {
    clear_with(&OWNED, clear_os_if)
}

/// `set` 의 상태 규칙 — 잠금을 쥔 채 OS 쓰기를 하고, 표식을 실었으면(`Ok(true)`) 기록한다.
/// 쓰기가 실패하면 이전 표식을 그대로 둔다(클립보드가 그대로면 여전히 우리 것, 비워졌으면
/// 다음 확인에서 표식이 없어 아무것도 안 지운다).
fn set_with(
    owned: &std::sync::Mutex<Option<u64>>,
    nonce: u64,
    write: impl FnOnce(u64) -> Result<bool, DuetError>,
) -> Result<(), DuetError> {
    let mut g = owned
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let marked = write(nonce)?;
    *g = marked.then_some(nonce);
    Ok(())
}

/// `clear_if_owned` 의 상태 규칙 — 잠금을 쥔 채 확인·비우기. OS 오류(클립보드 사용 중 등)면
/// 표식을 **남겨** 다음 원격 복사 때 다시 시도한다. 비웠거나 이미 우리 것이 아니면 표식을 버린다.
fn clear_with(
    owned: &std::sync::Mutex<Option<u64>>,
    clear: impl FnOnce(u64) -> Result<bool, DuetError>,
) -> Result<bool, DuetError> {
    let mut g = owned
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(nonce) = *g else {
        return Ok(false);
    };
    let cleared = clear(nonce)?;
    *g = None;
    Ok(cleared)
}

#[cfg(target_os = "macos")]
fn set_os(paths: &[PathBuf], nonce: u64) -> Result<bool, DuetError> {
    super::macos::set_file_clipboard(paths, nonce).map(|()| true)
}
#[cfg(target_os = "macos")]
fn clear_os_if(nonce: u64) -> Result<bool, DuetError> {
    super::macos::clear_file_clipboard_if(nonce)
}

#[cfg(windows)]
fn set_os(paths: &[PathBuf], nonce: u64) -> Result<bool, DuetError> {
    set_windows(paths, nonce)
}
#[cfg(windows)]
fn clear_os_if(nonce: u64) -> Result<bool, DuetError> {
    clear_windows_if(nonce)
}

#[cfg(target_os = "linux")]
fn set_os(paths: &[PathBuf], _nonce: u64) -> Result<bool, DuetError> {
    set_linux(paths).map(|()| false)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn clear_os_if(_nonce: u64) -> Result<bool, DuetError> {
    Ok(false)
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn set_os(_paths: &[PathBuf], _nonce: u64) -> Result<bool, DuetError> {
    Err(DuetError::NotSupported("os file clipboard".into()))
}

/// Drop 에서 CloseClipboard — 중간 실패에도 클립보드를 잠근 채로 남기지 않는다.
#[cfg(windows)]
struct ClipboardGuard;

#[cfg(windows)]
impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        // SAFETY: OpenClipboard 성공 뒤에만 이 가드를 만든다(§8).
        unsafe {
            let _ = windows::Win32::System::DataExchange::CloseClipboard();
        }
    }
}

/// duet 소유 표식용 등록 클립보드 형식 id (실패 시 0).
#[cfg(windows)]
fn owner_format() -> u32 {
    // SAFETY(§8): 상수 와이드 문자열 하나를 넘기는 등록 호출 — 같은 이름이면 같은 id.
    unsafe {
        windows::Win32::System::DataExchange::RegisterClipboardFormatW(windows::core::w!(
            "DuetClipboardOwner"
        ))
    }
}

/// Windows: 클립보드를 **연 채로** duet 표식이 `nonce` 인지 확인하고, 맞으면 비운다.
/// 열려 있는 동안 다른 앱은 쓸 수 없어 확인과 비우기 사이에 끼어들 수 없다.
#[cfg(windows)]
fn clear_windows_if(nonce: u64) -> Result<bool, DuetError> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{EmptyClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    let fmt = owner_format();
    if fmt == 0 {
        return Ok(false);
    }
    // SAFETY(§8): Open 성공 뒤에만 가드 생성(Close 보장). GetClipboardData 핸들은 시스템 소유라
    // 해제하지 않고 Lock/Unlock 만 하며, GlobalSize 로 확인한 크기 안에서만 8바이트를 읽는다.
    unsafe {
        OpenClipboard(None).map_err(|e| DuetError::Io(format!("OpenClipboard: {e}")))?;
        let _guard = ClipboardGuard;
        let Ok(h) = GetClipboardData(fmt) else {
            return Ok(false); // 표식 없음 — 다른 앱 내용이거나 이미 비워짐.
        };
        let hmem = HGLOBAL(h.0);
        let p = GlobalLock(hmem) as *const u8;
        if p.is_null() {
            return Ok(false);
        }
        let ours = GlobalSize(hmem) >= 8
            && std::ptr::read_unaligned(p as *const [u8; 8]) == nonce.to_le_bytes();
        let _ = GlobalUnlock(hmem);
        if !ours {
            return Ok(false);
        }
        EmptyClipboard().map_err(|e| DuetError::Io(format!("EmptyClipboard: {e}")))?;
    }
    Ok(true)
}

/// Windows `CF_HDROP` 쓰기 + duet 소유 표식(`nonce`, 등록 형식) 을 **같은 열림 안에서** 올린다.
///
/// 클립보드는 전역 자원이라 열고 나면 반드시 닫아야 한다 — 실패 경로에서도 닫히도록 가드를 쓴다.
/// `SetClipboardData` 성공 시 메모리 소유권이 시스템으로 넘어가므로 우리가 해제하지 않는다.
/// 반환: 표식까지 실었으면 true(파일만 올라갔으면 false — 그땐 나중에 비우지 않는다).
#[cfg(windows)]
fn set_windows(paths: &[PathBuf], nonce: u64) -> Result<bool, DuetError> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::DROPFILES;

    let list = wide_file_list(paths);
    let header = std::mem::size_of::<DROPFILES>();
    let total = header
        .checked_add(std::mem::size_of_val(&list[..]))
        .ok_or_else(|| DuetError::Io("clipboard payload too large".into()))?;

    // SAFETY(§8): 아래 unsafe 블록은 Win32 클립보드 API 규약을 그대로 따른다 —
    // (1) OpenClipboard 성공 후에만 Empty/Set 호출, (2) GlobalLock 이 준 포인터에만 쓰고
    // 할당 크기(total / 8) 안에서만 복사, (3) SetClipboardData 성공 시 해제하지 않음.
    unsafe {
        OpenClipboard(None).map_err(|e| DuetError::Io(format!("OpenClipboard: {e}")))?;
        let _guard = ClipboardGuard;
        EmptyClipboard().map_err(|e| DuetError::Io(format!("EmptyClipboard: {e}")))?;

        let hmem = GlobalAlloc(GMEM_MOVEABLE, total)
            .map_err(|e| DuetError::Io(format!("GlobalAlloc: {e}")))?;
        let base = GlobalLock(hmem) as *mut u8;
        if base.is_null() {
            return Err(DuetError::Io("GlobalLock returned null".into()));
        }

        // DROPFILES 헤더: 경로 목록 오프셋 + 와이드 문자 여부. 나머지 필드는 0.
        let df = base as *mut DROPFILES;
        std::ptr::write(
            df,
            DROPFILES {
                pFiles: header as u32,
                fWide: true.into(),
                ..Default::default()
            },
        );
        std::ptr::copy_nonoverlapping(
            list.as_ptr() as *const u8,
            base.add(header),
            std::mem::size_of_val(&list[..]),
        );
        let _ = GlobalUnlock(hmem);

        SetClipboardData(CF_HDROP.0 as u32, HANDLE(hmem.0))
            .map_err(|e| DuetError::Io(format!("SetClipboardData: {e}")))?;

        // 소유 표식 — 실패해도 파일 복사는 성공(그땐 나중에 비우지 않을 뿐).
        let fmt = owner_format();
        if fmt == 0 {
            return Ok(false);
        }
        let Ok(mark) = GlobalAlloc(GMEM_MOVEABLE, 8) else {
            return Ok(false);
        };
        let mp = GlobalLock(mark) as *mut u8;
        if mp.is_null() {
            return Ok(false);
        }
        std::ptr::copy_nonoverlapping(nonce.to_le_bytes().as_ptr(), mp, 8);
        let _ = GlobalUnlock(mark);
        Ok(SetClipboardData(fmt, HANDLE(mark.0)).is_ok())
    }
}

/// Linux `text/uri-list` 쓰기 — Wayland `wl-copy`, X11 `xclip` 중 있는 것을 쓴다.
///
/// 둘 다 없으면 `NotSupported`(설치 안내). 라이브러리 의존성을 새로 들이지 않는 선택이다.
#[cfg(target_os = "linux")]
fn set_linux(paths: &[PathBuf]) -> Result<(), DuetError> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let body = uri_list(paths);
    let candidates: [(&str, Vec<&str>); 2] = [
        ("wl-copy", vec!["--type", "text/uri-list"]),
        (
            "xclip",
            vec!["-selection", "clipboard", "-t", "text/uri-list"],
        ),
    ];
    for (bin, args) in candidates {
        let mut child = match Command::new(bin)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => continue, // 미설치 — 다음 후보
        };
        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(body.as_bytes())
                .map_err(|e| DuetError::Io(format!("{bin} stdin: {e}")))?;
        }
        let status = child
            .wait()
            .map_err(|e| DuetError::Io(format!("{bin}: {e}")))?;
        if status.success() {
            return Ok(());
        }
    }
    Err(DuetError::NotSupported(
        "file clipboard on Linux needs wl-clipboard(wl-copy) or xclip".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_list_is_utf16_with_double_null_terminator() {
        let list = wide_file_list(&[PathBuf::from("C:\\a"), PathBuf::from("C:\\b")]);
        // "C:\a\0C:\b\0\0"
        let expect: Vec<u16> = "C:\\a\0C:\\b\0\0".encode_utf16().collect();
        assert_eq!(list, expect);
        assert_eq!(list.last(), Some(&0));
        assert_eq!(list[list.len() - 2], 0, "이중 널로 끝나야 한다");
    }

    #[test]
    fn wide_list_keeps_non_ascii_names() {
        let list = wide_file_list(&[PathBuf::from("C:\\보고서.pdf")]);
        let expect: Vec<u16> = "C:\\보고서.pdf\0\0".encode_utf16().collect();
        assert_eq!(list, expect);
    }

    #[test]
    fn uri_list_encodes_spaces_and_keeps_separators() {
        let body = uri_list(&[PathBuf::from("/tmp/a b.md"), PathBuf::from("/tmp/c.md")]);
        assert_eq!(body, "file:///tmp/a%20b.md\r\nfile:///tmp/c.md\r\n");
    }

    #[test]
    fn uri_list_percent_encodes_non_ascii() {
        let body = uri_list(&[PathBuf::from("/tmp/문서.md")]);
        assert!(body.starts_with("file:///tmp/%"), "{body}");
        assert!(body.ends_with(".md\r\n"), "{body}");
        // 슬래시는 구분자로 남아야 한다.
        assert_eq!(body.matches('/').count(), 4);
    }

    use std::sync::Mutex;

    fn io(msg: &str) -> DuetError {
        DuetError::Io(msg.into())
    }

    #[test]
    fn marked_write_is_recorded_and_unmarked_write_forgets_ownership() {
        let owned = Mutex::new(Some(7));
        set_with(&owned, 42, |n| {
            assert_eq!(n, 42);
            Ok(true)
        })
        .unwrap();
        assert_eq!(*owned.lock().unwrap(), Some(42));
        // Linux 처럼 표식을 못 실으면 — 지금 클립보드는 우리 표식이 없으니 비울 대상도 없다.
        set_with(&owned, 43, |_| Ok(false)).unwrap();
        assert_eq!(*owned.lock().unwrap(), None);
    }

    #[test]
    fn failed_write_keeps_previous_marker() {
        let owned = Mutex::new(Some(7));
        assert!(set_with(&owned, 42, |_| Err(io("busy"))).is_err());
        assert_eq!(*owned.lock().unwrap(), Some(7));
    }

    #[test]
    fn clear_checks_the_recorded_marker_then_forgets_it() {
        let owned = Mutex::new(Some(42));
        assert!(clear_with(&owned, |n| {
            assert_eq!(n, 42);
            Ok(true)
        })
        .unwrap());
        assert_eq!(*owned.lock().unwrap(), None);
        // 다시 불러도 OS 를 건드리지 않는다.
        assert!(!clear_with(&owned, |_| panic!("no marker, no OS call")).unwrap());
    }

    #[test]
    fn someone_elses_clipboard_is_kept_and_marker_dropped() {
        let owned = Mutex::new(Some(42));
        assert!(!clear_with(&owned, |_| Ok(false)).unwrap());
        assert_eq!(*owned.lock().unwrap(), None);
    }

    #[test]
    fn failed_clear_keeps_marker_for_retry() {
        let owned = Mutex::new(Some(42));
        assert!(clear_with(&owned, |_| Err(io("clipboard busy"))).is_err());
        assert_eq!(
            *owned.lock().unwrap(),
            Some(42),
            "다음 원격 복사 때 다시 시도"
        );
        assert!(clear_with(&owned, |_| Ok(true)).unwrap());
    }

    #[test]
    fn nonces_differ_and_are_nonzero() {
        let a = new_nonce();
        let b = new_nonce();
        assert_ne!(a, b);
        assert_ne!(a, 0);
    }

    #[test]
    fn empty_selection_is_an_error() {
        assert!(set(&[]).is_err());
    }
}
