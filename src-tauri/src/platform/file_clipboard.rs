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

/// 파일 경로들을 OS 클립보드에 올린다. 미지원 OS 는 `NotSupported`.
pub fn set(paths: &[PathBuf]) -> Result<(), DuetError> {
    if paths.is_empty() {
        return Err(DuetError::Io("no paths to copy".into()));
    }
    #[cfg(target_os = "macos")]
    {
        super::macos::set_file_clipboard(paths)
    }
    #[cfg(windows)]
    {
        set_windows(paths)
    }
    #[cfg(target_os = "linux")]
    {
        set_linux(paths)
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        Err(DuetError::NotSupported("os file clipboard".into()))
    }
}

/// Windows `CF_HDROP` 쓰기.
///
/// 클립보드는 전역 자원이라 열고 나면 반드시 닫아야 한다 — 실패 경로에서도 닫히도록 가드를 쓴다.
/// `SetClipboardData` 성공 시 메모리 소유권이 시스템으로 넘어가므로 우리가 해제하지 않는다.
#[cfg(windows)]
fn set_windows(paths: &[PathBuf]) -> Result<(), DuetError> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::DROPFILES;

    /// Drop 에서 CloseClipboard — 중간 실패에도 클립보드를 잠근 채로 남기지 않는다.
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            // SAFETY: OpenClipboard 성공 뒤에만 이 가드를 만든다(§8).
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    let list = wide_file_list(paths);
    let header = std::mem::size_of::<DROPFILES>();
    let total = header
        .checked_add(std::mem::size_of_val(&list[..]))
        .ok_or_else(|| DuetError::Io("clipboard payload too large".into()))?;

    // SAFETY(§8): 아래 unsafe 블록은 Win32 클립보드 API 규약을 그대로 따른다 —
    // (1) OpenClipboard 성공 후에만 Empty/Set 호출, (2) GlobalLock 이 준 포인터에만 쓰고
    // 할당 크기(total) 안에서만 복사, (3) SetClipboardData 성공 시 해제하지 않음.
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
    }
    Ok(())
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

    #[test]
    fn empty_selection_is_an_error() {
        assert!(set(&[]).is_err());
    }
}
