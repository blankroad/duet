//! sync-compare R1 backend evidence. All paths and caches stay inside TempDir.
use async_trait::async_trait;
use duet_lib::core::compare::{
    compare_dirs, compare_dirs_progress, export_plan, CompareRules, CompareStatus,
};
use duet_lib::core::copy_progress::{
    parse_rsync_itemize_created_file, parse_rsync_itemize_delete, parse_rsync_itemize_transfer_file,
};
use duet_lib::core::ops::{
    detect_renames, merge_bidir, sync_execute, sync_plan, sync_preview, verify_compare, OpCtx,
};
use duet_lib::core::search::{LocalContentSearch, LocalFilenameSearch, SearchBackend, SearchOpts};
use duet_lib::fs::{FileSystem, LocalFs};
use duet_lib::services::file_index::{index_key, FileIndex, IndexedPath};
use duet_lib::services::frecency::FrecencyStore;
use duet_lib::services::journal::{Journal, UndoAction};
use duet_lib::services::settings::SettingsStore;
use duet_lib::types::{
    ChecksumAlgo, DuetError, Entry, EntryKind, EntryMeta, Location, SourceId, TrashLocation,
};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::{Duration, UNIX_EPOCH};
use tempfile::{tempdir, TempDir};
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

fn loc(path: &Path) -> Location {
    Location {
        source: SourceId::Local,
        path: path.into(),
    }
}
fn trees() -> (TempDir, PathBuf, PathBuf) {
    let t = tempdir().unwrap();
    let l = t.path().join("left");
    let r = t.path().join("right");
    std::fs::create_dir(&l).unwrap();
    std::fs::create_dir(&r).unwrap();
    (t, l, r)
}
fn write_at(path: &Path, bytes: &[u8], millis: u64) {
    std::fs::write(path, bytes).unwrap();
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_millis(millis)),
        )
        .unwrap();
}
async fn ctx(root: &Path) -> OpCtx {
    OpCtx {
        journal: Journal::load_from(&root.join("j.jsonl")).await.unwrap(),
        settings: SettingsStore::load_from(&root.join("s.toml"))
            .await
            .unwrap(),
        pool: None,
        app: None,
    }
}

// Inject list failures without any OS trash access; every mutation delegates to temp paths.
struct ListFailureFs {
    blocked: PathBuf,
    trash_dir: Option<PathBuf>,
}
impl ListFailureFs {
    fn new(blocked: PathBuf) -> Self {
        Self {
            blocked,
            trash_dir: None,
        }
    }
}
#[async_trait]
impl FileSystem for ListFailureFs {
    fn source_id(&self) -> SourceId {
        SourceId::Local
    }
    async fn list(&self, p: &Path) -> Result<Vec<Entry>, DuetError> {
        if p == self.blocked {
            Err(DuetError::PermissionDenied("review fixture".into()))
        } else {
            LocalFs.list(p).await
        }
    }
    async fn metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
        LocalFs.metadata(p).await
    }
    async fn rename(&self, f: &Path, t: &Path) -> Result<(), DuetError> {
        LocalFs.rename(f, t).await
    }
    async fn mkdir(&self, p: &Path) -> Result<(), DuetError> {
        LocalFs.mkdir(p).await
    }
    async fn trash(&self, p: &Path, _: &str) -> Result<TrashLocation, DuetError> {
        let root = self
            .trash_dir
            .as_ref()
            .expect("OS trash forbidden: temp trash fixture required");
        let to = root.join(p.file_name().unwrap());
        LocalFs.rename(p, &to).await?;
        Ok(TrashLocation::Remote { trash_path: to })
    }
    async fn remove(&self, _: &Path) -> Result<(), DuetError> {
        panic!("fixture permanent removal forbidden")
    }
    async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
        panic!("OS trash forbidden")
    }
    async fn read_full(&self, p: &Path) -> Result<Vec<u8>, DuetError> {
        LocalFs.read_full(p).await
    }
    async fn write_full(&self, p: &Path, b: &[u8]) -> Result<(), DuetError> {
        LocalFs.write_full(p, b).await
    }
    async fn open_read(
        &self,
        p: &Path,
        o: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
        LocalFs.open_read(p, o).await
    }
    async fn open_write(
        &self,
        p: &Path,
        o: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
        LocalFs.open_write(p, o).await
    }
}

#[tokio::test]
async fn compare_precision_and_content_verification() {
    let (_t, l, r) = trees();
    for delta in [1, 999, 1000, 1999, 2000] {
        write_at(&l.join("a"), b"same", 1_700_000_000_000 + delta);
        write_at(&r.join("a"), b"same", 1_700_000_000_000);
        let p = compare_dirs(&LocalFs, loc(&l), &LocalFs, loc(&r))
            .await
            .unwrap();
        assert_eq!(p.entries[0].status, CompareStatus::NewerLeft);
        let p = compare_dirs_progress(
            &LocalFs,
            loc(&l),
            &LocalFs,
            loc(&r),
            &CompareRules {
                mtime_tolerance_ms: 2000,
                ..Default::default()
            },
            &CancellationToken::new(),
            &|_| {},
        )
        .await
        .unwrap();
        assert_eq!(p.entries[0].status, CompareStatus::Same);
    }
    write_at(&l.join("a"), b"AAAA", 1_700_000_000_000);
    write_at(&r.join("a"), b"BBBB", 1_700_000_000_000);
    assert_eq!(
        compare_dirs(&LocalFs, loc(&l), &LocalFs, loc(&r))
            .await
            .unwrap()
            .same,
        1
    );
    let v = verify_compare(
        &LocalFs,
        &loc(&l),
        &LocalFs,
        &loc(&r),
        vec!["a".into()],
        None,
    )
    .await
    .unwrap();
    assert_eq!(v[0].equal, Some(false));
}

#[tokio::test]
async fn compare_case_split_merge_preserves_both_original_contents() {
    let (t, l, r) = trees();
    std::fs::write(l.join("Foo.txt"), b"LEFT").unwrap();
    std::fs::write(r.join("foo.txt"), b"RIGHT").unwrap();
    let p = compare_dirs(&LocalFs, loc(&l), &LocalFs, loc(&r))
        .await
        .unwrap();
    assert_eq!((p.left_only, p.right_only), (1, 1));
    merge_bidir(
        &LocalFs,
        loc(&l),
        &LocalFs,
        loc(&r),
        false,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(l.join("Foo.txt")).unwrap(), b"LEFT");
    assert_eq!(std::fs::read(r.join("foo.txt")).unwrap(), b"RIGHT");
}

#[tokio::test]
async fn compare_nfc_nfd_names_are_one_pair() {
    let (_t, l, r) = trees();
    std::fs::write(l.join("한글.txt"), b"same").unwrap();
    let nfd: String = "한글.txt".nfd().collect();
    std::fs::write(r.join(nfd), b"same").unwrap();
    let p = compare_dirs(&LocalFs, loc(&l), &LocalFs, loc(&r))
        .await
        .unwrap();
    assert_eq!(
        p.entries.len(),
        1,
        "canonically equivalent names must form one pair"
    );
}

#[tokio::test]
async fn compare_same_rows_consume_cap_and_late_difference_is_flagged() {
    let (_t, l, r) = trees();
    for i in 0..5000 {
        let n = format!("a{i:04}");
        write_at(&l.join(&n), b"x", 1_700_000_000_000);
        write_at(&r.join(n), b"x", 1_700_000_000_000);
    }
    std::fs::write(l.join("z_late_difference"), b"new").unwrap();
    let p = compare_dirs(&LocalFs, loc(&l), &LocalFs, loc(&r))
        .await
        .unwrap();
    assert_eq!(p.same, 5000);
    assert_eq!(p.left_only, 0);
    assert!(p.truncated);
    assert!(!p.entries.iter().any(|e| e.rel == "z_late_difference"));
}

#[tokio::test]
async fn compare_unreadable_subtree_is_not_merge_work() {
    let (t, l, r) = trees();
    std::fs::create_dir(l.join("private")).unwrap();
    std::fs::create_dir(r.join("private")).unwrap();
    std::fs::write(r.join("private/only_right"), b"safe").unwrap();
    let f = ListFailureFs::new(l.join("private"));
    let p = compare_dirs(&f, loc(&l), &LocalFs, loc(&r)).await.unwrap();
    assert_eq!(p.entries.len(), 1);
    assert_eq!(p.entries[0].status, CompareStatus::Unreadable);
    merge_bidir(
        &f,
        loc(&l),
        &LocalFs,
        loc(&r),
        false,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(!l.join("private/only_right").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn compare_directory_symlink_follows_target_and_broken_links_differ() {
    use std::os::unix::fs::symlink;
    let (t, l, r) = trees();
    let target = t.path().join("target");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("outside"), b"x").unwrap();
    symlink(&target, l.join("alias")).unwrap();
    std::fs::create_dir(r.join("alias")).unwrap();
    symlink("missing", l.join("broken")).unwrap();
    symlink("missing", r.join("broken")).unwrap();
    let p = compare_dirs(&LocalFs, loc(&l), &LocalFs, loc(&r))
        .await
        .unwrap();
    assert!(p
        .entries
        .iter()
        .any(|e| e.rel == "alias/outside" && e.status == CompareStatus::LeftOnly));
    assert!(p
        .entries
        .iter()
        .any(|e| e.rel == "broken" && e.status == CompareStatus::Differ));
}

#[tokio::test]
async fn verify_large_files_returns_unknown_and_ambiguous_renames_remain() {
    let (_t, l, r) = trees();
    for root in [&l, &r] {
        std::fs::File::create(root.join("big"))
            .unwrap()
            .set_len(64 * 1024 * 1024 + 1)
            .unwrap();
    }
    let v = verify_compare(
        &LocalFs,
        &loc(&l),
        &LocalFs,
        &loc(&r),
        vec!["big".into()],
        None,
    )
    .await
    .unwrap();
    assert_eq!(v[0].equal, None);
    for n in ["left1", "left2"] {
        std::fs::write(l.join(n), b"duplicate").unwrap();
    }
    std::fs::write(r.join("right1"), b"duplicate").unwrap();
    let mut p = compare_dirs(&LocalFs, loc(&l), &LocalFs, loc(&r))
        .await
        .unwrap();
    assert!(detect_renames(&mut p, &LocalFs, &LocalFs, None)
        .await
        .unwrap()
        .is_empty());
    assert!(p.moves.is_empty());
}

#[tokio::test]
async fn csv_escapes_multiline_quote_comma_and_preserves_korean() {
    let (_t, l, r) = trees();
    let n = "한글,\"줄\n끝";
    std::fs::write(l.join("safe"), b"x").unwrap();
    let mut p = compare_dirs(&LocalFs, loc(&l), &LocalFs, loc(&r))
        .await
        .unwrap();
    // Export is a pure serializer; avoid creating Windows-forbidden names on disk.
    p.entries[0].rel = n.into();
    let csv = export_plan(&p, false).unwrap();
    assert!(csv.contains("\"한글,\"\"줄\n끝\""));
    assert!(csv.starts_with('\u{feff}'));
    assert!(export_plan(&p, true).unwrap().contains("한글"));
}

#[tokio::test]
async fn csv_formula_names_are_neutralized() {
    let (_t, l, r) = trees();
    std::fs::write(l.join("=1+1"), b"x").unwrap();
    let p = compare_dirs(&LocalFs, loc(&l), &LocalFs, loc(&r))
        .await
        .unwrap();
    let csv = export_plan(&p, false).unwrap();
    assert!(
        !csv.contains(",=1+1,"),
        "untrusted filename must remain spreadsheet text"
    );
}

#[tokio::test]
#[ignore = "sync-compare repro: F-sol-01 nested destination accepted"]
async fn sync_rejects_destination_below_source() {
    let (_t, l, _r) = trees();
    let child = l.join("child");
    std::fs::create_dir(&child).unwrap();
    assert!(
        sync_plan(&LocalFs, &LocalFs, loc(&l), loc(&child))
            .await
            .is_err(),
        "nested destination permits recursive self-copy"
    );
}

#[tokio::test]
#[ignore = "sync-compare repro: F-sol-01 nested source accepted"]
async fn sync_rejects_source_below_destination() {
    let (_t, l, _r) = trees();
    let child = l.join("child");
    std::fs::create_dir(&child).unwrap();
    assert!(
        sync_plan(&LocalFs, &LocalFs, loc(&child), loc(&l))
            .await
            .is_err(),
        "prune may remove its source subtree"
    );
}

#[tokio::test]
#[ignore = "sync-compare repro: F-sol-03 unreadable preview succeeds"]
async fn sync_preview_propagates_unreadable_source_subtree() {
    let (t, l, r) = trees();
    std::fs::create_dir(l.join("private")).unwrap();
    let f = ListFailureFs::new(l.join("private"));
    let preview = sync_preview(&f, &loc(&l), &LocalFs, &loc(&r), None).await;
    let plan = sync_plan(&f, &LocalFs, loc(&l), loc(&r)).await.unwrap();
    let execute = sync_execute(
        &f,
        &LocalFs,
        plan,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await;
    assert!(execute.is_err());
    assert!(
        preview.is_err(),
        "preview must expose the unreadable subtree, not an empty successful plan"
    );
}

#[tokio::test]
async fn sync_newer_destination_is_backed_up_and_undo_restores_files() {
    let (t, l, r) = trees();
    write_at(&l.join("edit"), b"older source", 1_700_000_000_000);
    write_at(
        &r.join("edit"),
        b"newer destination edit",
        1_700_000_010_000,
    );
    std::fs::write(l.join("new"), b"fresh").unwrap();
    let p = sync_preview(&LocalFs, &loc(&l), &LocalFs, &loc(&r), None)
        .await
        .unwrap();
    assert!(p.copy.contains(&"edit".into()));
    let plan = sync_plan(&LocalFs, &LocalFs, loc(&l), loc(&r))
        .await
        .unwrap();
    let e = sync_execute(
        &LocalFs,
        &LocalFs,
        plan,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(r.join("edit")).unwrap(), b"older source");
    match &e.undo {
        UndoAction::UndoSync {
            backups_to_restore, ..
        } => {
            assert_eq!(backups_to_restore.len(), 1);
            assert_eq!(
                std::fs::read(&backups_to_restore[0].backup_path).unwrap(),
                b"newer destination edit"
            );
        }
        _ => panic!("expected UndoSync"),
    }
    let outcome = duet_lib::core::undo::execute_undo(
        &e,
        &duet_lib::services::connection_pool::ConnectionPool::new(),
    )
    .await;
    assert!(matches!(outcome.kind, duet_lib::core::undo::UndoKind::Ok));
    assert_eq!(
        std::fs::read(r.join("edit")).unwrap(),
        b"newer destination edit"
    );
    assert!(!r.join("new").exists());
}

#[test]
fn rsync_plain_names_and_arrows_preserved() {
    for n in ["hello world.txt", "한글.txt", "literal -> name.txt"] {
        assert_eq!(
            parse_rsync_itemize_created_file(&format!(">f+++++++++ {n}")),
            Some(n.into())
        );
        assert_eq!(
            parse_rsync_itemize_transfer_file(&format!(">f.st...... {n}")),
            Some(n.into())
        );
        assert_eq!(
            parse_rsync_itemize_delete(&format!("*deleting   {n}")),
            Some(n.into())
        );
    }
}

#[test]
#[ignore = "sync-compare repro: F-sol-09 leading filename whitespace is removed"]
fn rsync_leading_space_name_is_preserved() {
    assert_eq!(
        parse_rsync_itemize_created_file(">f+++++++++  leading.txt"),
        Some(" leading.txt".into())
    );
}

#[test]
#[ignore = "sync-compare repro: F-sol-09 rsync filename escapes are not decoded"]
fn rsync_escaped_newline_name_is_decoded() {
    assert_eq!(
        parse_rsync_itemize_created_file(r">f+++++++++ line\#012break.txt"),
        Some("line\nbreak.txt".into())
    );
}

#[tokio::test]
async fn checksum_known_abc_all_supported_algorithms_and_directory_error() {
    let t = tempdir().unwrap();
    let p = t.path().join("a");
    std::fs::write(&p, b"abc").unwrap();
    assert_eq!(
        LocalFs.checksum(&p, ChecksumAlgo::Sha256).await.unwrap(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(LocalFs.checksum(&p,ChecksumAlgo::Sha512).await.unwrap(),"ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
    assert!(LocalFs
        .checksum(t.path(), ChecksumAlgo::Sha256)
        .await
        .is_err());
}

#[tokio::test]
#[ignore = "sync-compare repro: F-sol-04 content metadata filters ignored"]
async fn content_search_honors_metadata_filters() {
    let t = tempdir().unwrap();
    std::fs::write(t.path().join("a"), b"needle").unwrap();
    let opts = SearchOpts {
        content: true,
        min_size: Some(100),
        only_kind: Some(EntryKind::Dir),
        modified_after_ms: Some(i64::MAX),
        ..Default::default()
    };
    let hits = LocalContentSearch
        .search(t.path(), "needle", &opts, CancellationToken::new())
        .await
        .unwrap();
    assert!(
        hits.is_empty(),
        "content mode must apply the same metadata filters as filename mode"
    );
}

#[tokio::test]
#[ignore = "sync-compare repro: F-sol-05 filename search misses NFD"]
async fn filename_search_matches_canonically_equivalent_korean() {
    let t = tempdir().unwrap();
    std::fs::write(t.path().join("한글.txt".nfd().collect::<String>()), b"x").unwrap();
    let hits = LocalFilenameSearch
        .search(
            t.path(),
            "한글",
            &SearchOpts::default(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(hits.len(), 1, "NFC query must find decomposed Hangul");
}

#[tokio::test]
async fn content_large_binary_and_cancel_are_bounded() {
    let t = tempdir().unwrap();
    let p = t.path().join("large");
    let mut text = vec![b'a'; 8 * 1024 * 1024 + 1];
    text[..6].copy_from_slice(b"needle");
    std::fs::write(&p, text).unwrap();
    std::fs::write(t.path().join("binary"), b"needle\0binary").unwrap();
    let hits = LocalContentSearch
        .search(
            t.path(),
            "needle",
            &SearchOpts::default(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(hits.is_empty());
    let c = CancellationToken::new();
    c.cancel();
    assert!(matches!(
        LocalFilenameSearch
            .search(t.path(), "a", &SearchOpts::default(), c)
            .await,
        Err(DuetError::Cancelled)
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn filename_and_index_do_not_follow_symlink_cycle() {
    let t = tempdir().unwrap();
    std::fs::create_dir(t.path().join("a")).unwrap();
    std::fs::write(t.path().join("a/needle"), b"x").unwrap();
    std::os::unix::fs::symlink("..", t.path().join("a/loop")).unwrap();
    let hits = LocalFilenameSearch
        .search(
            t.path(),
            "needle",
            &SearchOpts::default(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    let cache = tempdir().unwrap();
    let idx = FileIndex::new(cache.path().into());
    let n = idx.build_local(t.path()).await.unwrap();
    assert_eq!(n, 3);
}

#[tokio::test]
#[ignore = "sync-compare repro: F-sol-05 indexed search misses NFD"]
async fn index_matches_canonically_equivalent_korean() {
    let t = tempdir().unwrap();
    let cache = tempdir().unwrap();
    let idx = FileIndex::new(cache.path().into());
    idx.store(
        index_key(&SourceId::Local, t.path()),
        vec![IndexedPath {
            path: t.path().join("한글.txt".nfd().collect::<String>()),
            kind: EntryKind::File,
            size: 1,
            modified_ms: None,
        }],
    )
    .await
    .unwrap();
    let hits = idx
        .query(&SourceId::Local, t.path(), "한글", &SearchOpts::default())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hits.len(), 1);
}

#[tokio::test]
#[ignore = "sync-compare repro: F-sol-11 index ignores hidden exclusion"]
async fn index_respects_hidden_exclusion() {
    let t = tempdir().unwrap();
    std::fs::write(t.path().join(".hidden_needle"), b"x").unwrap();
    let cache = tempdir().unwrap();
    let idx = FileIndex::new(cache.path().into());
    idx.build_local(t.path()).await.unwrap();
    let hits = idx
        .query(&SourceId::Local, t.path(), "needle", &SearchOpts::default())
        .await
        .unwrap()
        .unwrap();
    assert!(hits.is_empty());
}

#[tokio::test]
async fn index_freshness_and_invalid_json_cache_fall_back() {
    let t = tempdir().unwrap();
    let cache = tempdir().unwrap();
    let idx = FileIndex::new(cache.path().into());
    assert!(!idx.is_fresh(&SourceId::Local, t.path(), 60_000).await);
    idx.build_local(t.path()).await.unwrap();
    assert!(idx.is_fresh(&SourceId::Local, t.path(), 60_000).await);
    assert!(!idx.is_fresh(&SourceId::Local, t.path(), 0).await);
    let cache_file = std::fs::read_dir(cache.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::write(cache_file, b"{broken").unwrap();
    let reloaded = FileIndex::new(cache.path().into());
    assert!(reloaded
        .query(&SourceId::Local, t.path(), "q", &SearchOpts::default())
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn index_structurally_corrupt_json_does_not_panic() {
    let t = tempdir().unwrap();
    let cache = tempdir().unwrap();
    let idx = FileIndex::new(cache.path().into());
    idx.build_local(t.path()).await.unwrap();
    let cache_file = std::fs::read_dir(cache.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::write(cache_file,br#"{"built_at_ms":0,"paths":"","path_off":[],"names_lower":"","name_off":[],"kinds":[0],"sizes":[0],"mtimes":[0]}"#).unwrap();
    let reloaded = FileIndex::new(cache.path().into());
    let _ = reloaded
        .query(&SourceId::Local, t.path(), "q", &SearchOpts::default())
        .await;
}

#[tokio::test]
async fn frecency_corrupt_file_and_thousand_entry_eviction() {
    let t = tempdir().unwrap();
    let p = t.path().join("f.json");
    std::fs::write(&p, b"{broken").unwrap();
    let f = FrecencyStore::load_from(&p).await.unwrap();
    assert!(f.query("", 2000, 1000).await.is_empty());
    // Seed 1000 entries in one cache write, then record one new visit to exercise eviction.
    let entries:Vec<_>=(0..1000).map(|i|serde_json::json!({"location":loc(&t.path().join(format!("p{i}"))),"host_alias":null,"count":1,"last_visit_ms":1})).collect();
    std::fs::write(&p, serde_json::to_vec(&entries).unwrap()).unwrap();
    let f = FrecencyStore::load_from(&p).await.unwrap();
    let recent = t.path().join("recent");
    f.record(loc(&recent), None, 86_400_000_000).await.unwrap();
    let hits = f.query("", 2000, 86_400_000_000).await;
    assert_eq!(hits.len(), 1000);
    assert_eq!(hits[0].location.path, recent);
}

#[tokio::test]
async fn compare_ignore_glob_backend_matrix() {
    let (_t, l, r) = trees();
    for n in ["trace.log", "my_node_modules_cache", "a", "x"] {
        std::fs::write(l.join(n), b"x").unwrap();
    }
    for (pattern, name, excluded) in [
        ("*.log", "trace.log", true),
        ("*.LOG", "trace.log", false),
        ("node_modules", "my_node_modules_cache", false),
        ("a/b", "a", false),
        ("**/x", "x", false),
        ("[abc]", "a", false),
    ] {
        let p = compare_dirs_progress(
            &LocalFs,
            loc(&l),
            &LocalFs,
            loc(&r),
            &CompareRules {
                ignore_globs: vec![pattern.into()],
                ..Default::default()
            },
            &CancellationToken::new(),
            &|_| {},
        )
        .await
        .unwrap();
        assert_eq!(
            !p.entries.iter().any(|e| e.rel == name),
            excluded,
            "pattern {pattern} / {name}"
        );
    }
    std::fs::create_dir(l.join("src")).unwrap();
    std::fs::create_dir(r.join("src")).unwrap();
    std::fs::write(l.join("src/a.ts"), b"x").unwrap();
    let p = compare_dirs_progress(
        &LocalFs,
        loc(&l),
        &LocalFs,
        loc(&r),
        &CompareRules {
            ignore_globs: vec!["src/*.ts".into()],
            ..Default::default()
        },
        &CancellationToken::new(),
        &|_| {},
    )
    .await
    .unwrap();
    assert!(p.entries.iter().any(|e| e.rel == "src/a.ts"));
}

#[tokio::test]
#[ignore = "sync-compare repro: F-sol-08 cache filenames alias roots"]
async fn index_cache_names_do_not_alias_different_roots() {
    let t = tempdir().unwrap();
    let cache = tempdir().unwrap();
    let idx = FileIndex::new(cache.path().into());
    let l = t.path().join("a-b");
    let r = t.path().join("a_b");
    for root in [&l, &r] {
        idx.store(
            index_key(&SourceId::Local, root),
            vec![IndexedPath {
                path: root.join("needle"),
                kind: EntryKind::File,
                size: 1,
                modified_ms: None,
            }],
        )
        .await
        .unwrap();
    }
    let reloaded = FileIndex::new(cache.path().into());
    let hits = reloaded
        .query(&SourceId::Local, &l, "needle", &SearchOpts::default())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        hits[0].location.path, l,
        "cache must not serve a different folder's index"
    );
}

#[tokio::test]
#[ignore = "sync-compare repro: F-sol-02 prune moves the active overwrite backup"]
async fn sync_prune_preserves_its_own_overwrite_backup() {
    let (t, l, r) = trees();
    write_at(&l.join("edit"), b"new source", 1_700_000_010_000);
    write_at(&r.join("edit"), b"old", 1_700_000_000_000);
    let trash = t.path().join("fixture-trash");
    std::fs::create_dir(&trash).unwrap();
    let f = ListFailureFs {
        blocked: t.path().join("never"),
        trash_dir: Some(trash),
    };
    let mut plan = sync_plan(&LocalFs, &f, loc(&l), loc(&r)).await.unwrap();
    plan.prune = true;
    let e = sync_execute(
        &LocalFs,
        &f,
        plan,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    match e.undo {
        UndoAction::UndoSync {
            backups_to_restore,
            pruned,
            ..
        } => {
            assert_eq!(backups_to_restore.len(), 1);
            assert!(
                backups_to_restore[0].backup_path.exists(),
                "successful prune must not remove the backup needed by UndoSync; pruned={pruned:?}"
            );
        }
        _ => panic!("expected UndoSync"),
    }
}

#[tokio::test]
#[ignore = "sync-compare repro: F-sol-01 prune moves original source"]
async fn sync_prune_never_moves_its_source_subtree() {
    let t = tempdir().unwrap();
    let dst = t.path().join("dst");
    let src = dst.join("source");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("only"), b"original").unwrap();
    let trash = t.path().join("fixture-trash");
    std::fs::create_dir(&trash).unwrap();
    let f = ListFailureFs {
        blocked: t.path().join("never"),
        trash_dir: Some(trash),
    };
    let mut plan = sync_plan(&f, &f, loc(&src), loc(&dst)).await.unwrap();
    plan.prune = true;
    sync_execute(
        &f,
        &f,
        plan,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(
        src.join("only").exists(),
        "sync must never prune its own original source"
    );
}

#[tokio::test]
#[ignore = "sync-compare repro: F-sol-01 recursive self creation"]
async fn sync_nested_destination_does_not_recursively_create_itself() {
    let (t, l, _r) = trees();
    let dst = l.join("child");
    std::fs::create_dir(&dst).unwrap();
    // Stop the real recursive implementation after four levels, keeping the repro bounded.
    let f = ListFailureFs::new(l.join("child/child/child/child"));
    let plan = sync_plan(&f, &f, loc(&l), loc(&dst)).await.unwrap();
    let _ = sync_execute(
        &f,
        &f,
        plan,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await;
    assert!(
        !dst.join("child").exists(),
        "destination was recursively copied into itself"
    );
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "sync-compare repro: F-sol-13 destination link mutates external target"]
async fn sync_does_not_write_through_destination_directory_symlink() {
    let (t, l, r) = trees();
    let external = t.path().join("external");
    std::fs::create_dir(&external).unwrap();
    std::fs::create_dir(l.join("sub")).unwrap();
    write_at(&l.join("sub/edit"), b"new content", 1_700_000_010_000);
    write_at(&external.join("edit"), b"old", 1_700_000_000_000);
    std::os::unix::fs::symlink(&external, r.join("sub")).unwrap();
    let plan = sync_plan(&LocalFs, &LocalFs, loc(&l), loc(&r))
        .await
        .unwrap();
    sync_execute(
        &LocalFs,
        &LocalFs,
        plan,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(external.join("edit")).unwrap(),
        b"old",
        "sync must not mutate a directory outside the selected target through a link"
    );
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "sync-compare repro: F-sol-09 actual rsync names do not round trip"]
async fn rsync_actual_itemize_round_trips_special_names() {
    let (_t, l, r) = trees();
    let names = ["한글.txt", "line\nbreak.txt", " leading.txt"];
    for name in names {
        std::fs::write(l.join(name), b"x").unwrap();
    }
    let out = match std::process::Command::new("rsync")
        .env("LC_ALL", "C")
        .args(["-ain", "--"])
        .arg(l.join(""))
        .arg(&r)
        .output()
    {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => panic!("rsync fixture: {e}"),
    };
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let created: Vec<_> = stdout
        .lines()
        .filter_map(parse_rsync_itemize_created_file)
        .collect();
    for name in names {
        assert!(
            created.contains(&name.to_string()),
            "missing name {name:?}; stdout={stdout:?}; parsed={created:?}"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn compare_chmod_zero_subtree_is_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    let (_t, l, r) = trees();
    let blocked = l.join("private");
    std::fs::create_dir(&blocked).unwrap();
    std::fs::create_dir(r.join("private")).unwrap();
    std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let inaccessible = std::fs::read_dir(&blocked).is_err();
    let result = compare_dirs(&LocalFs, loc(&l), &LocalFs, loc(&r)).await;
    // Restore before assertions so TempDir can clean up even when the assertion fails.
    std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        inaccessible,
        "chmod fixture requires a non-privileged test user"
    );
    assert!(result
        .unwrap()
        .entries
        .iter()
        .any(|e| e.rel == "private" && e.status == CompareStatus::Unreadable));
}

#[test]
#[ignore = "sync-compare repro: F-sol-14 shell path replaces literal backslash"]
fn remote_shell_path_preserves_literal_posix_backslash() {
    let path = Path::new(r"/srv/a\b");
    assert_eq!(
        duet_lib::core::copy_strategy::shell_escape_path(path).unwrap(),
        r"'/srv/a\b'",
        "remote filename backslash is a literal character, not a separator"
    );
}
