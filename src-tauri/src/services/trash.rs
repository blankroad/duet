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
pub fn remote_trash_base(remote_home: &Path) -> PathBuf {
    remote_home.join(".duet-trash")
}

/// 원본 절대경로 → trash 안의 위치.
/// 예: `/home/u/foo.txt` + batch `20260509-...` → `<base>/<batch>/home/u/foo.txt`
pub fn remote_trash_path_for(base: &Path, batch_id: &str, original_abs: &Path) -> PathBuf {
    let mut out = base.join(batch_id);
    // original_abs 의 첫 `/` 만 제거하고 그 뒤를 그대로 붙임
    for comp in original_abs.components() {
        match comp {
            std::path::Component::RootDir => continue,
            std::path::Component::Normal(s) => out.push(s),
            std::path::Component::CurDir | std::path::Component::ParentDir => {
                out.push(comp.as_os_str());
            }
            std::path::Component::Prefix(_) => {
                out.push(comp.as_os_str());
            }
        }
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
}
