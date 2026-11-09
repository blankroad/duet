//! Remote POSIX path operations, independent of the client's native separators.
//!
//! Only `/` separates remote components; backslashes remain part of their names.

use crate::types::SourceId;
use std::path::{Path, PathBuf};

/// Parent before the final `/`, ignoring trailing slashes. Root has no parent;
/// a bare relative name has the empty relative parent. Non-UTF8 paths return None.
pub fn parent(path: &Path) -> Option<PathBuf> {
    let path = path.to_str()?.trim_end_matches('/');
    if path.is_empty() {
        return None;
    }
    Some(match path.rsplit_once('/') {
        Some((parent, _)) if parent.trim_end_matches('/').is_empty() => PathBuf::from("/"),
        Some((parent, _)) => PathBuf::from(parent.trim_end_matches('/')),
        None => PathBuf::new(),
    })
}

/// Last `/`-separated name, ignoring trailing slashes. Root, empty and non-UTF8
/// paths have no name. Backslashes and drive-looking text are preserved.
/// This is lexical: `"/a/.."` returns `".."` without resolving it.
pub fn file_name(path: &Path) -> Option<&str> {
    let path = path.to_str()?.trim_end_matches('/');
    if path.is_empty() {
        return None;
    }
    path.rsplit('/').next()
}

/// Join with native separators for local files and POSIX separators for SSH.
pub fn join_for(source: &SourceId, base: &Path, name: &str) -> PathBuf {
    match source {
        SourceId::Local => base.join(name),
        SourceId::Ssh { .. } => super::posix_join(base, name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ConnectionId;

    #[test]
    fn posix_parent_and_name_preserve_backslashes() {
        let path = Path::new(r"/srv/a\b/한글\name.txt");
        assert_eq!(parent(path), Some(PathBuf::from(r"/srv/a\b")));
        assert_eq!(file_name(path), Some(r"한글\name.txt"));
        assert_eq!(
            file_name(Path::new(r"C:\remote\name")),
            Some(r"C:\remote\name")
        );
        assert_eq!(parent(Path::new(r"C:\remote\name")), Some(PathBuf::new()));
    }

    #[test]
    fn posix_roots_and_trailing_slashes() {
        for root in ["", "/", "///"] {
            assert_eq!(parent(Path::new(root)), None);
            assert_eq!(file_name(Path::new(root)), None);
        }
        assert_eq!(parent(Path::new("/srv///")), Some(PathBuf::from("/")));
        assert_eq!(file_name(Path::new("/srv///")), Some("srv"));
        assert_eq!(
            parent(Path::new("relative/name/")),
            Some(PathBuf::from("relative"))
        );
        assert_eq!(file_name(Path::new("relative/name/")), Some("name"));
        assert_eq!(parent(Path::new("name")), Some(PathBuf::new()));
    }

    #[test]
    fn posix_join_for_uses_source_separators() {
        let ssh = SourceId::Ssh {
            connection_id: ConnectionId("fixture".into()),
            host_ip: "127.0.0.1".parse().unwrap(),
            user: "u".into(),
        };
        assert_eq!(
            join_for(&ssh, Path::new("/srv///"), r"a\b").to_str(),
            Some(r"/srv/a\b")
        );
        assert_eq!(join_for(&ssh, Path::new("/"), "x").to_str(), Some("/x"));
        let base = Path::new(r"C:\local");
        assert_eq!(join_for(&SourceId::Local, base, "x"), base.join("x"));
    }
}
