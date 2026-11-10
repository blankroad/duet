//! Paths R2: a recording filesystem deliberately uses a different child-path rule.
//! Virtual paths never reach the host filesystem; only journals use TempDir.
use super::*;
use crate::types::{ConnectionId, Entry, EntryKind, EntryMeta, ServerEndpoint};
use std::collections::HashMap;
use std::path::Path;
use std::pin::Pin;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

struct ProbeFs {
    source: SourceId,
    port: u16,
    exists: bool,
    entries: HashMap<PathBuf, Vec<Entry>>,
    seen: Mutex<Vec<PathBuf>>,
}
impl ProbeFs {
    fn new(conn: &str, port: u16) -> Self {
        Self {
            source: SourceId::Ssh {
                connection_id: ConnectionId(conn.into()),
                host_ip: "127.0.0.1".parse().unwrap(),
                user: "fixture".into(),
            },
            port,
            exists: false,
            entries: HashMap::new(),
            seen: Mutex::new(Vec::new()),
        }
    }
    fn loc(&self, path: &str) -> Location {
        Location {
            source: self.source.clone(),
            path: path.into(),
        }
    }
    fn record(&self, path: &Path) {
        self.seen.lock().unwrap().push(path.into());
    }
    fn saw(&self, path: &Path) -> bool {
        self.seen.lock().unwrap().iter().any(|p| p == path)
    }
}
fn absent() -> DuetError {
    DuetError::NotFound("record-only fixture".into())
}
#[async_trait::async_trait]
impl FileSystem for ProbeFs {
    fn source_id(&self) -> SourceId {
        self.source.clone()
    }
    fn endpoint(&self) -> Option<ServerEndpoint> {
        Some(ServerEndpoint::new(
            "127.0.0.1".parse().unwrap(),
            self.port,
            &[],
        ))
    }
    fn join(&self, base: &Path, name: &str) -> PathBuf {
        crate::fs::posix_join(&crate::fs::posix_join(base, "__fs"), name)
    }
    async fn list(&self, p: &Path) -> Result<Vec<Entry>, DuetError> {
        self.record(p);
        Ok(self.entries.get(p).cloned().unwrap_or_default())
    }
    async fn metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
        self.record(p);
        if self.exists {
            Ok(EntryMeta {
                kind: EntryKind::Dir,
                size: None,
                modified_ms: None,
                permissions: None,
            })
        } else {
            Err(absent())
        }
    }
    async fn rename(&self, _: &Path, _: &Path) -> Result<(), DuetError> {
        panic!("unexpected rename")
    }
    async fn mkdir(&self, _: &Path) -> Result<(), DuetError> {
        panic!("unexpected mkdir")
    }
    async fn trash(&self, p: &Path, _: &str) -> Result<TrashLocation, DuetError> {
        self.record(p);
        Err(absent())
    }
    async fn remove(&self, _: &Path) -> Result<(), DuetError> {
        panic!("permanent removal forbidden")
    }
    async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
        panic!("unexpected restore")
    }
    async fn read_full(&self, p: &Path) -> Result<Vec<u8>, DuetError> {
        self.record(p);
        Err(absent())
    }
    async fn write_full(&self, _: &Path, _: &[u8]) -> Result<(), DuetError> {
        panic!("unexpected write")
    }
    async fn open_read(
        &self,
        _: &Path,
        _: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
        panic!("unexpected open")
    }
    async fn open_write(
        &self,
        _: &Path,
        _: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
        panic!("unexpected open")
    }
}
fn entry(name: &str, kind: EntryKind) -> Entry {
    Entry {
        name: name.into(),
        kind,
        size: Some(0),
        modified_ms: Some(0),
        permissions: None,
        hidden: false,
    }
}
async fn ctx(path: &Path) -> OpCtx {
    OpCtx {
        journal: Journal::load_from(&path.join("j.jsonl")).await.unwrap(),
        settings: SettingsStore::load_from(&path.join("s.toml"))
            .await
            .unwrap(),
        pool: None,
        app: None,
    }
}
fn item(fs: &ProbeFs) -> EntryRef {
    EntryRef {
        location: fs.loc("/src"),
        name: "file".into(),
    }
}

#[tokio::test]
async fn remote17_keep_both_candidate_uses_destination_join() {
    let fs = ProbeFs::new("dst", 22);
    let p = dedup_dst_name(&fs, Path::new("/dst"), r"a\b.txt").await;
    assert_eq!(p, fs.join(Path::new("/dst"), r"a\b (1).txt"));
}
#[tokio::test]
async fn remote17_timestamp_fallback_uses_destination_join() {
    let mut fs = ProbeFs::new("dst", 22);
    fs.exists = true;
    let p = dedup_dst_name(&fs, Path::new("/dst"), "x.txt").await;
    assert_eq!(p.parent(), Some(Path::new("/dst/__fs")));
    assert_eq!(fs.seen.lock().unwrap().len(), 9999);
}
#[tokio::test]
async fn relay_count_and_preview_walks_use_each_filesystem() {
    let mut left = ProbeFs::new("left", 22);
    let mut right = ProbeFs::new("right", 23);
    left.entries
        .insert("/src".into(), vec![entry("sub", EntryKind::Dir)]);
    left.entries
        .insert("/src/__fs/sub".into(), vec![entry("leaf", EntryKind::File)]);
    right
        .entries
        .insert("/dst".into(), vec![entry("extra", EntryKind::File)]);
    assert_eq!(count_files(&left, Path::new("/src")).await, 1);
    let mut out = SyncPreview {
        copy: Vec::new(),
        prune: Vec::new(),
        truncated: false,
    };
    preview_copy_walk(
        &left,
        Path::new("/src"),
        &right,
        Path::new("/dst"),
        "",
        &mut out,
    )
    .await
    .unwrap();
    preview_prune_walk(
        &left,
        Path::new("/src"),
        &right,
        Path::new("/dst"),
        "",
        &mut out,
    )
    .await
    .unwrap();
    assert_eq!(out.copy, ["sub/leaf"]);
    assert_eq!(out.prune, ["extra"]);
    assert!(right.saw(Path::new("/dst/__fs/sub/__fs/leaf")));
    assert!(left.saw(Path::new("/src/__fs/extra")));
}
#[tokio::test]
async fn relay_apply_verify_trash_and_signatures_use_each_filesystem() {
    let left = ProbeFs::new("left", 22);
    let right = ProbeFs::new("right", 23);
    let l = left.loc("/L");
    let r = right.loc("/R");
    for direction in [ApplyDirection::ToLeft, ApplyDirection::ToRight] {
        let mut st = ApplyState::default();
        // 원본이 없는 fixture — SC-08 이후 받는 쪽을 건드리기 전에 "원본 없음"으로 건너뛴다.
        // 원본 확인은 원본 쪽 fs 의 결합 규칙으로 한다(방향마다 한쪽씩 기록).
        assert!(matches!(
            apply_one_relay(
                &direction,
                Path::new("sub/x"),
                &left,
                &l,
                &right,
                &r,
                &mut st
            )
            .await,
            Ok(RowApplied::SourceMissing)
        ));
    }
    assert!(left.saw(Path::new("/L/__fs/sub/x")));
    assert!(right.saw(Path::new("/R/__fs/sub/x")));
    left.seen.lock().unwrap().clear();
    right.seen.lock().unwrap().clear();
    verify_relay(&left, &l, &right, &r, vec!["sub/x".into()])
        .await
        .unwrap();
    assert!(left.saw(Path::new("/L/__fs/sub/x")));
    assert!(right.saw(Path::new("/R/__fs/sub/x")));
    assert!(
        trash_rel(&left, &l, Path::new("trash"), "batch", &mut Vec::new())
            .await
            .is_err()
    );
    assert!(left.saw(Path::new("/L/__fs/trash")));
    compute_sigs(&right, &r, &[("sig".into(), 0)], false, None)
        .await
        .unwrap();
    assert!(right.saw(Path::new("/R/__fs/sig")));
}
#[tokio::test]
async fn relay_merge_uses_each_filesystem() {
    use crate::core::compare::CompareStatus;
    let left = ProbeFs::new("left", 22);
    let right = ProbeFs::new("right", 23);
    let t = tempfile::tempdir().unwrap();
    let c = ctx(t.path()).await;
    let out = merge_relay(
        &left,
        left.loc("/L"),
        &right,
        right.loc("/R"),
        vec![
            (CompareStatus::LeftOnly, "a".into()),
            (CompareStatus::RightOnly, "b".into()),
        ],
        &c,
        CancellationToken::new(),
        None,
    )
    .await;
    assert!(out.is_err());
    assert!(left.saw(Path::new("/L/__fs/a")));
    assert!(right.saw(Path::new("/R/__fs/a")));
}
#[tokio::test]
async fn endpoints_route_planning_and_read_only_operations_to_relay() {
    let mut left = ProbeFs::new("left", 22);
    left.exists = true;
    let mut right = ProbeFs::new("right", 23);
    right.exists = true;
    let p = copy_plan(&left, &right, vec![item(&left)], right.loc("/dst"))
        .await
        .unwrap();
    assert_eq!(p.strategy, CopyStrategy::Relay);
    let p = move_plan(&left, &right, vec![item(&left)], right.loc("/dst"))
        .await
        .unwrap();
    assert_eq!(p.strategy, CopyStrategy::Relay);
    assert!(matches!(
        sync_plan(&left, &right, left.loc("/src"), right.loc("/dst")).await,
        Err(DuetError::NotSupported(_))
    ));
    assert!(
        sync_preview(&left, &left.loc("/src"), &right, &right.loc("/dst"), None)
            .await
            .is_ok()
    );
    assert!(verify_compare(
        &left,
        &left.loc("/src"),
        &right,
        &right.loc("/dst"),
        Vec::new(),
        None
    )
    .await
    .is_ok());
}
#[tokio::test]
async fn endpoints_route_merge_and_apply_to_relay() {
    let mut left = ProbeFs::new("left", 22);
    left.exists = true;
    let mut right = ProbeFs::new("right", 23);
    right.exists = true;
    let t = tempfile::tempdir().unwrap();
    let c = ctx(t.path()).await;
    assert!(merge_bidir(
        &left,
        left.loc("/src"),
        &right,
        right.loc("/dst"),
        false,
        &c,
        CancellationToken::new(),
        None
    )
    .await
    .is_ok());
    assert!(apply_compare(
        &left,
        left.loc("/src"),
        &right,
        right.loc("/dst"),
        Vec::new(),
        &c,
        CancellationToken::new(),
        None
    )
    .await
    .is_ok());
}
#[tokio::test]
async fn endpoint_changes_reject_same_host_execute_before_io() {
    let left = ProbeFs::new("left", 22);
    let right = ProbeFs::new("right", 23);
    let t = tempfile::tempdir().unwrap();
    let c = ctx(t.path()).await;
    let cp = CopyPlan {
        src_source: left.source.clone(),
        dst: right.loc("/dst"),
        items: vec![item(&left)],
        conflicts: Vec::new(),
        total_size_bytes: 0,
        strategy: CopyStrategy::SshSameHost,
    };
    let mp = MovePlan {
        src_source: left.source.clone(),
        dst: right.loc("/dst"),
        items: vec![item(&left)],
        conflicts: Vec::new(),
        total_size_bytes: 0,
        strategy: CopyStrategy::SshSameHost,
        is_same_fs: false,
    };
    let sp = SyncPlan {
        src: left.loc("/src"),
        dst: right.loc("/dst"),
        strategy: CopyStrategy::SshSameHost,
        prune: false,
    };
    for out in [
        copy_execute(
            &left,
            &right,
            cp,
            ConflictPolicy::Skip,
            &c,
            CancellationToken::new(),
            None,
        )
        .await,
        move_execute(
            &left,
            &right,
            mp,
            ConflictPolicy::Skip,
            &c,
            CancellationToken::new(),
            None,
        )
        .await,
        sync_execute(&left, &right, sp, &c, CancellationToken::new(), None).await,
    ] {
        assert!(
            matches!(out, Err(DuetError::Io(ref s)) if s.contains("server endpoints")),
            "{out:?}"
        );
    }
    assert!(left.seen.lock().unwrap().is_empty());
    assert!(right.seen.lock().unwrap().is_empty());
    assert!(c.journal.history(10).await.is_empty());
}
#[tokio::test]
async fn endpoint_guard_allows_nested_paths_on_distinct_servers_only() {
    let left = ProbeFs::new("left", 22);
    for (port, conn, reject) in [
        (23, "right", false),
        (22, "right", true),
        (23, "left", true),
    ] {
        let right = ProbeFs::new(conn, port);
        let result = copy_plan(
            &left,
            &right,
            vec![item(&left)],
            right.loc("/src/__fs/file/child"),
        )
        .await;
        assert_eq!(
            matches!(result, Err(DuetError::IntoItself(_))),
            reject,
            "port={port} conn={conn}: {result:?}"
        );
    }
}
#[tokio::test]
async fn compare_uses_endpoint_aware_strategy() {
    let mut left = ProbeFs::new("left", 22);
    left.exists = true;
    let mut right = ProbeFs::new("right", 23);
    right.exists = true;
    let p = crate::core::compare::compare_dirs(&left, left.loc("/src"), &right, right.loc("/dst"))
        .await
        .unwrap();
    assert_eq!(p.strategy, CopyStrategy::Relay);
}
#[tokio::test]
async fn endpoints_skip_same_host_rename_detection_for_distinct_servers() {
    let mut left = ProbeFs::new("left", 22);
    left.exists = true;
    let mut right = ProbeFs::new("right", 23);
    right.exists = true;
    left.entries
        .insert("/src".into(), vec![entry("old", EntryKind::File)]);
    right
        .entries
        .insert("/dst".into(), vec![entry("new", EntryKind::File)]);
    let mut p =
        crate::core::compare::compare_dirs(&left, left.loc("/src"), &right, right.loc("/dst"))
            .await
            .unwrap();
    assert!(detect_renames(&mut p, &left, &right, None)
        .await
        .unwrap()
        .is_empty());
    assert!(p.moves.is_empty());
}
#[tokio::test]
async fn endpoint_guard_allows_nested_sync_preview_on_distinct_servers() {
    let left = ProbeFs::new("left", 22);
    for (port, reject) in [(23, false), (22, true)] {
        let right = ProbeFs::new("right", port);
        let result = sync_preview(
            &left,
            &left.loc("/vagrant"),
            &right,
            &right.loc("/vagrant/x"),
            None,
        )
        .await;
        assert_eq!(
            matches!(result, Err(DuetError::IntoItself(_))),
            reject,
            "{result:?}"
        );
    }
}

#[test]
fn progress_remote_names_and_backup_parents_preserve_backslashes() {
    let fs = ProbeFs::new("ssh", 22);
    let path = Path::new(r"/srv/a\b/c\d");
    assert_eq!(
        file_name_for(&fs.source, path),
        Some(std::ffi::OsStr::new(r"c\d"))
    );
    assert_eq!(
        parent_for(&fs.source, path),
        Some(PathBuf::from(r"/srv/a\b"))
    );
}
