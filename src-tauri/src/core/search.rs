//! 파일명/내용 검색 backend.
//!
//! v1 (MVP-5): 파일명 substring 검색만.
//! - LocalFilenameSearch: `ignore::WalkBuilder` (.gitignore 자동 존중)
//! - SshFilenameSearch: russh exec 채널로 `find -iname` 실행 (Task 7)
//!
//! v2 후속: GrepSearch (ripgrep), result streaming (event 기반).

use crate::types::{DuetError, EntryKind, Location, SourceId};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SearchOpts {
    pub case_sensitive: bool,
    pub include_hidden: bool,
    pub max_results: usize,
}

impl Default for SearchOpts {
    fn default() -> Self {
        Self {
            case_sensitive: false,
            include_hidden: false,
            max_results: 500,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SearchHit {
    /// 항목의 부모 디렉토리 (클릭 시 navigate 대상).
    pub location: Location,
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified_ms: Option<i64>,
}

#[async_trait]
pub trait SearchBackend: Send + Sync {
    async fn search(
        &self,
        root: &Path,
        pattern: &str,
        opts: &SearchOpts,
        cancel: CancellationToken,
    ) -> Result<Vec<SearchHit>, DuetError>;
}

/// 로컬 파일시스템 검색 — `ignore::WalkBuilder` 사용.
pub struct LocalFilenameSearch;

#[async_trait]
impl SearchBackend for LocalFilenameSearch {
    async fn search(
        &self,
        root: &Path,
        pattern: &str,
        opts: &SearchOpts,
        cancel: CancellationToken,
    ) -> Result<Vec<SearchHit>, DuetError> {
        use ignore::WalkBuilder;
        let root = root.to_path_buf();
        let pattern = pattern.to_string();
        let opts = opts.clone();

        tokio::task::spawn_blocking(move || -> Result<Vec<SearchHit>, DuetError> {
            let walker = WalkBuilder::new(&root)
                .hidden(!opts.include_hidden)
                .git_ignore(true)
                .git_exclude(true)
                .build();
            let mut hits = Vec::new();
            for entry in walker {
                if cancel.is_cancelled() {
                    return Err(DuetError::Cancelled);
                }
                if hits.len() >= opts.max_results {
                    break;
                }
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue, // permission denied 등 skip
                };
                let path = entry.path();
                if path == root {
                    continue;
                }
                let name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if !matches_substring(&name, &pattern, opts.case_sensitive) {
                    continue;
                }
                let parent = match path.parent() {
                    Some(p) => p.to_path_buf(),
                    None => continue,
                };
                let meta = entry.metadata().ok();
                let kind = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    EntryKind::Dir
                } else if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
                    EntryKind::Symlink
                } else if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    EntryKind::File
                } else {
                    EntryKind::Other
                };
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified_ms = meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64);
                hits.push(SearchHit {
                    location: Location {
                        source: SourceId::Local,
                        path: parent,
                    },
                    name,
                    kind,
                    size,
                    modified_ms,
                });
            }
            Ok(hits)
        })
        .await
        .map_err(|e| DuetError::Io(format!("search join: {e}")))?
    }
}

fn matches_substring(name: &str, pattern: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        name.contains(pattern)
    } else {
        name.to_lowercase().contains(&pattern.to_lowercase())
    }
}

/// SSH 호스트의 `find` 명령으로 파일명 검색.
/// pattern 은 shell-escape 후 `-iname '*<p>*'` 로 사용.
pub struct SshFilenameSearch {
    pub conn: std::sync::Arc<crate::services::connection_pool::ActiveConnection>,
}

#[async_trait]
impl SearchBackend for SshFilenameSearch {
    async fn search(
        &self,
        root: &Path,
        pattern: &str,
        opts: &SearchOpts,
        cancel: CancellationToken,
    ) -> Result<Vec<SearchHit>, DuetError> {
        use crate::core::copy_strategy::shell_escape_path;
        use crate::ssh::remote_exec::exec;

        let root_arg = shell_escape_path(root)?;
        let pat_escaped = pattern.replace('\\', "\\\\").replace('\'', "\\'");
        let name_flag = if opts.case_sensitive {
            "-name"
        } else {
            "-iname"
        };
        let hidden_clause = if opts.include_hidden {
            ""
        } else {
            r"-not -path '*/.*'"
        };
        let cmd = format!(
            "find {root_arg} {hidden_clause} \\( -type f -o -type d -o -type l \\) {name_flag} '*{pat_escaped}*' 2>/dev/null | head -n {max}",
            max = opts.max_results
        );

        let session_mutex = self
            .conn
            .session
            .as_ref()
            .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;
        if cancel.is_cancelled() {
            return Err(DuetError::Cancelled);
        }
        let result = {
            let handle = session_mutex.lock().await;
            exec(&handle, &cmd).await?
        };
        if cancel.is_cancelled() {
            return Err(DuetError::Cancelled);
        }
        let stdout = String::from_utf8_lossy(&result.stdout);
        let conn_id = self.conn.id.clone();
        Ok(parse_find_output(
            &stdout,
            &conn_id,
            self.conn.host_ip,
            &self.conn.user,
        ))
    }
}

/// `find` stdout 라인을 SearchHit 으로. 절대경로 한 줄 = 한 항목.
/// metadata (size/mtime) 는 별도 stat 비용 비싸 placeholder (0/None).
pub fn parse_find_output(
    stdout: &str,
    conn_id: &crate::types::ConnectionId,
    host_ip: std::net::IpAddr,
    user: &str,
) -> Vec<SearchHit> {
    stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let path = PathBuf::from(line);
            let name = path.file_name().and_then(|n| n.to_str())?.to_string();
            let parent = path.parent()?.to_path_buf();
            Some(SearchHit {
                location: Location {
                    source: SourceId::Ssh {
                        connection_id: conn_id.clone(),
                        host_ip,
                        user: user.to_string(),
                    },
                    path: parent,
                },
                name,
                // find 는 type 정보 stdout 에 없음 — file 가정
                kind: EntryKind::File,
                size: 0,
                modified_ms: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;
    use tokio_util::sync::CancellationToken;

    fn write_file(dir: &Path, name: &str) {
        fs::write(dir.join(name), b"x").unwrap();
    }

    #[tokio::test]
    async fn local_filename_basic_match() {
        let dir = tempdir().unwrap();
        write_file(dir.path(), "alpha.txt");
        write_file(dir.path(), "beta.md");
        write_file(dir.path(), "gamma_alpha.rs");
        let s = LocalFilenameSearch;
        let hits = s
            .search(
                dir.path(),
                "alpha",
                &SearchOpts::default(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"alpha.txt"));
        assert!(names.contains(&"gamma_alpha.rs"));
        assert!(!names.contains(&"beta.md"));
    }

    #[tokio::test]
    async fn local_filename_case_insensitive_default() {
        let dir = tempdir().unwrap();
        write_file(dir.path(), "ALPHA.txt");
        let s = LocalFilenameSearch;
        let hits = s
            .search(
                dir.path(),
                "alpha",
                &SearchOpts::default(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[tokio::test]
    async fn local_filename_case_sensitive_opt() {
        let dir = tempdir().unwrap();
        // Use distinct names so they don't collide on case-insensitive filesystems (macOS HFS+).
        write_file(dir.path(), "UPPER_file.txt");
        write_file(dir.path(), "lower_file.txt");
        let s = LocalFilenameSearch;
        let hits = s
            .search(
                dir.path(),
                "lower",
                &SearchOpts {
                    case_sensitive: true,
                    ..SearchOpts::default()
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        // Only "lower_file.txt" should match; "UPPER_file.txt" does not contain "lower".
        assert_eq!(names, vec!["lower_file.txt"]);
    }

    #[tokio::test]
    async fn local_hidden_excluded_by_default() {
        let dir = tempdir().unwrap();
        write_file(dir.path(), ".hidden_alpha");
        write_file(dir.path(), "visible_alpha");
        let s = LocalFilenameSearch;
        let hits = s
            .search(
                dir.path(),
                "alpha",
                &SearchOpts::default(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, vec!["visible_alpha"]);
    }

    #[tokio::test]
    async fn local_hidden_included_with_opt() {
        let dir = tempdir().unwrap();
        write_file(dir.path(), ".hidden_alpha");
        write_file(dir.path(), "visible_alpha");
        let s = LocalFilenameSearch;
        let hits = s
            .search(
                dir.path(),
                "alpha",
                &SearchOpts {
                    include_hidden: true,
                    ..SearchOpts::default()
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[tokio::test]
    async fn local_max_results_caps() {
        let dir = tempdir().unwrap();
        for i in 0..20 {
            write_file(dir.path(), &format!("alpha_{i}"));
        }
        let s = LocalFilenameSearch;
        let hits = s
            .search(
                dir.path(),
                "alpha",
                &SearchOpts {
                    max_results: 5,
                    ..SearchOpts::default()
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(hits.len(), 5);
    }

    #[tokio::test]
    async fn local_cancel_returns_err() {
        let dir = tempdir().unwrap();
        for i in 0..1000 {
            write_file(dir.path(), &format!("alpha_{i}"));
        }
        let cancel = CancellationToken::new();
        cancel.cancel();
        let s = LocalFilenameSearch;
        let res = s
            .search(dir.path(), "alpha", &SearchOpts::default(), cancel)
            .await;
        assert!(matches!(res, Err(DuetError::Cancelled)));
    }

    #[test]
    fn parse_find_basic() {
        use std::net::Ipv4Addr;
        let conn_id = crate::types::ConnectionId("test".into());
        let ip = std::net::IpAddr::V4(Ipv4Addr::new(192, 168, 0, 1));
        let stdout = "/home/u/alpha.txt\n/home/u/sub/beta.md\n\n/home/u/gamma.rs\n";
        let hits = parse_find_output(stdout, &conn_id, ip, "u");
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].name, "alpha.txt");
        assert_eq!(hits[0].location.path, std::path::PathBuf::from("/home/u"));
        assert_eq!(hits[1].name, "beta.md");
        assert_eq!(
            hits[1].location.path,
            std::path::PathBuf::from("/home/u/sub")
        );
    }

    #[test]
    fn parse_find_skips_empty_lines() {
        use std::net::Ipv4Addr;
        let conn_id = crate::types::ConnectionId("t".into());
        let ip = std::net::IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
        let stdout = "\n\n\n";
        let hits = parse_find_output(stdout, &conn_id, ip, "x");
        assert_eq!(hits.len(), 0);
    }
}
