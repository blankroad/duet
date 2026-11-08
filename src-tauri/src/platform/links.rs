//! 심볼릭 링크 생성과 "링크를 만들 권한 없음" 판정 — OS 별 API·오류 번호를 이 안에 가둔다.

use std::io;
use std::path::Path;

/// `link` 위치에 `target` 을 가리키는 심볼릭 링크를 만든다. `target` 은 해석하지 않고
/// 그대로 기록한다(상대 경로면 링크 위치 기준). Windows 는 파일 링크로 만든다
/// (tar 와 같은 선택 — 대상이 폴더인지 알 수 없다).
pub fn create_symlink(target: &Path, link: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(target, link)
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (target, link);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "symbolic links are not supported on this OS",
        ))
    }
}

/// 링크를 만들 수 없는 환경 때문에 실패했는지 — 아카이브 해제는 이 경우 링크만 건너뛴다.
/// - Windows: ERROR_PRIVILEGE_NOT_HELD(1314). 관리자도 개발자 모드도 아니면 이렇게 실패한다.
/// - Unix: EPERM(1). FAT/exFAT 처럼 링크를 지원하지 않는 파일시스템.
/// - 그 밖: `Unsupported`.
pub fn is_link_not_permitted(e: &io::Error) -> bool {
    #[cfg(windows)]
    const CODE: i32 = 1314;
    #[cfg(not(windows))]
    const CODE: i32 = 1;
    e.raw_os_error() == Some(CODE) || e.kind() == io::ErrorKind::Unsupported
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privilege_error_is_recognised() {
        #[cfg(windows)]
        let code = 1314;
        #[cfg(not(windows))]
        let code = 1;
        assert!(is_link_not_permitted(&io::Error::from_raw_os_error(code)));
        assert!(!is_link_not_permitted(&io::Error::from_raw_os_error(2)));
    }

    #[cfg(unix)]
    #[test]
    fn creates_relative_symlink() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("real.txt"), b"x").unwrap();
        let link = dir.path().join("link.txt");
        create_symlink(Path::new("real.txt"), &link).unwrap();
        assert_eq!(std::fs::read(&link).unwrap(), b"x");
    }
}
