//! 휴지통 헬퍼 — batch ID 발급 + 원격 trash path 계산.
//!
//! 로컬 휴지통은 trash crate 위임 (`fs/local.rs`). 원격은 SFTP `mv` 로
//! `~/.duet-trash/<batch>/<original-absolute-path>` 위치로 보냄.

use chrono::Utc;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// 한 delete op 가 한 batch ID 사용. 같은 op 안 여러 항목은 같은 batch dir 안에.
/// 형식: `<UTC YYYYMMDD-HHMMSS>-<uuid v7 short>`
pub fn new_batch_id() -> String {
    let ts = Utc::now().format("%Y%m%d-%H%M%S");
    let id = Uuid::now_v7();
    let short: String = id.simple().to_string().chars().take(12).collect();
    format!("{ts}-{short}")
}

/// 원격 trash 의 base — `<remote_home>/.duet-trash`.
///
/// 원격 경로는 항상 POSIX(`/`). `PathBuf::join` 은 Windows 클라이언트에서 `\` 를 섞어
/// SSH 레이어 invariant(`remote_path_str`)를 깨므로 `posix_join` 으로 결합한다.
pub fn remote_trash_base(remote_home: &Path) -> PathBuf {
    crate::fs::posix_join(remote_home, ".duet-trash")
}

/// 원본 절대경로 → trash 안의 위치.
/// 예: `/home/u/foo.txt` + batch `20260509-...` → `<base>/<batch>/home/u/foo.txt`
///
/// **Windows 클라이언트 주의**: `PathBuf::push`/`components()` 는 `\` 를 구분자로 섞어
/// 넣어 POSIX 원격에 잘못된 경로를 보낸다(SSH 삭제가 Windows 에서만 실패하던 버그).
/// 따라서 원격 경로 문자열을 `/` 로 분해해 `posix_join` 으로만 결합한다.
pub fn remote_trash_path_for(base: &Path, batch_id: &str, original_abs: &Path) -> PathBuf {
    let mut out = crate::fs::posix_join(base, batch_id);
    let s = original_abs.to_string_lossy();
    for seg in s.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        out = crate::fs::posix_join(&out, seg);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_id_has_expected_shape() {
        let id = new_batch_id();
        assert!(id.len() > 15, "got: {id}");
        // 첫 8자 = YYYYMMDD
        assert!(id.chars().take(8).all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn remote_path_preserves_absolute_structure() {
        let base = Path::new("/home/u/.duet-trash");
        let p = remote_trash_path_for(base, "BATCH", Path::new("/etc/foo/bar.txt"));
        assert_eq!(
            p,
            PathBuf::from("/home/u/.duet-trash/BATCH/etc/foo/bar.txt")
        );
    }

    #[test]
    fn remote_trash_base_appends_dot_dir() {
        assert_eq!(
            remote_trash_base(Path::new("/home/u")),
            PathBuf::from("/home/u/.duet-trash")
        );
    }

    #[test]
    fn trash_paths_are_posix_only_no_backslash() {
        // Windows 클라이언트에서 PathBuf::push/join 이 `\` 를 섞어 SSH 삭제가 깨지던
        // 회귀 방지 — 결과는 항상 forward-slash POSIX 여야 한다.
        let base = remote_trash_base(Path::new("/home/u"));
        assert!(!base.to_string_lossy().contains('\\'));
        let p = remote_trash_path_for(&base, "B", Path::new("/a/b/c.txt"));
        let s = p.to_string_lossy();
        assert!(!s.contains('\\'), "trash path must be POSIX: {s}");
        assert_eq!(s, "/home/u/.duet-trash/B/a/b/c.txt");
    }
}
