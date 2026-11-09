//! sync-compare R2 교차 검토(opus-2) — sol/lead 발견을 사용자 흐름의 다른 각도로 재확인.
//! 모든 파일 작업은 TempDir 안. OS 휴지통은 부르지 않는다(휴지통은 fixture 폴더로 rename).
//! `#[ignore = "sync-compare repro: …"]` = 기대 동작 단언, 현재 실패.
//! 실행: `cargo test --manifest-path src-tauri/Cargo.toml --test review_sync_compare_xcheck_opus -- --include-ignored`

use std::path::{Path, PathBuf};
use std::pin::Pin;

use async_trait::async_trait;
use duet_lib::core::ops::{merge_bidir, sync_execute, sync_plan, OpCtx};
use duet_lib::core::undo::execute_undo;
use duet_lib::fs::{FileSystem, LocalFs};
use duet_lib::services::connection_pool::ConnectionPool;
use duet_lib::services::journal::{Journal, UndoAction};
use duet_lib::services::settings::SettingsStore;
use duet_lib::types::{DuetError, Entry, EntryMeta, Location, SourceId, TrashLocation};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

async fn mk_ctx(dir: &Path) -> OpCtx {
    std::fs::create_dir_all(dir).unwrap();
    OpCtx {
        settings: SettingsStore::load_from(&dir.join("s.toml")).await.unwrap(),
        journal: Journal::load_from(&dir.join("j.jsonl")).await.unwrap(),
        pool: None,
        app: None,
    }
}

fn loc(p: &Path) -> Location {
    Location {
        source: SourceId::Local,
        path: p.to_path_buf(),
    }
}

fn write_at(p: &Path, bytes: &[u8], secs: u64) {
    std::fs::write(p, bytes).unwrap();
    std::fs::File::options()
        .write(true)
        .open(p)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs))
        .unwrap();
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

/// LocalFs 위임 fixture. 휴지통은 `trash_dir` 로 rename, 영구 삭제·OS 휴지통 복원은 panic.
/// `cancel_on_nth_rename`: n 번째 rename(=덮어쓰기 전 백업) 직후 토큰 취소.
/// `blocked_list`: 이 경로 list 는 PermissionDenied (재귀 폭주를 유한하게 끊는 용도).
struct Fixture {
    trash_dir: Option<PathBuf>,
    cancel_on_nth_rename: Option<(usize, CancellationToken)>,
    renames: std::sync::atomic::AtomicUsize,
    blocked_list: Option<PathBuf>,
}

impl Fixture {
    fn new() -> Self {
        Self {
            trash_dir: None,
            cancel_on_nth_rename: None,
            renames: std::sync::atomic::AtomicUsize::new(0),
            blocked_list: None,
        }
    }
}

#[async_trait]
impl FileSystem for Fixture {
    fn source_id(&self) -> SourceId {
        SourceId::Local
    }
    async fn list(&self, p: &Path) -> Result<Vec<Entry>, DuetError> {
        if self.blocked_list.as_deref() == Some(p) {
            return Err(DuetError::PermissionDenied("review fixture".into()));
        }
        LocalFs.list(p).await
    }
    async fn metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
        LocalFs.metadata(p).await
    }
    async fn rename(&self, f: &Path, t: &Path) -> Result<(), DuetError> {
        let r = LocalFs.rename(f, t).await;
        let n = self
            .renames
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        if let Some((nth, tok)) = &self.cancel_on_nth_rename {
            if n == *nth {
                tok.cancel();
            }
        }
        r
    }
    async fn mkdir(&self, p: &Path) -> Result<(), DuetError> {
        LocalFs.mkdir(p).await
    }
    async fn trash(&self, p: &Path, _: &str) -> Result<TrashLocation, DuetError> {
        let root = self
            .trash_dir
            .as_ref()
            .expect("OS trash forbidden: fixture trash_dir required");
        let to = root.join(format!(
            "{}-{}",
            self.renames
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst),
            p.file_name().unwrap().to_string_lossy()
        ));
        LocalFs.rename(p, &to).await?;
        Ok(TrashLocation::Remote { trash_path: to })
    }
    async fn remove(&self, _: &Path) -> Result<(), DuetError> {
        panic!("fixture: permanent removal forbidden")
    }
    async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
        panic!("fixture: OS trash forbidden")
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

// ─── SC-01: 취소 경로 ────────────────────────────────────────────────────

/// 사용자가 동기화 도중 [취소]. 취소 전에 a 는 새로 생기고 b 는 덮어써졌다(.bak 생성).
/// 기대: 이미 반영된 변경이 journal 에 남아 Ctrl+Z 로 되돌릴 수 있다.
#[tokio::test]
#[ignore = "sync-compare repro: SC-01 cancelled sync leaves applied changes without a journal entry"]
async fn sync_cancel_midway_journals_what_was_already_applied() {
    let t = TempDir::new().unwrap();
    let (src, dst) = (t.path().join("src"), t.path().join("dst"));
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::write(src.join("a_new.txt"), b"fresh").unwrap();
    std::fs::write(src.join("b_changed.txt"), b"NEW-content").unwrap();
    std::fs::write(dst.join("b_changed.txt"), b"old").unwrap();
    std::fs::write(src.join("c_later.txt"), b"later").unwrap();
    let tok = CancellationToken::new();
    let mut dst_fs = Fixture::new();
    // b_changed 의 백업 rename 직후 취소 → b 복사는 끝나고 c 앞에서 Cancelled.
    dst_fs.cancel_on_nth_rename = Some((1, tok.clone()));
    let ctx = mk_ctx(&t.path().join("ctx")).await;
    let plan = sync_plan(&LocalFs, &dst_fs, loc(&src), loc(&dst))
        .await
        .unwrap();
    let r = sync_execute(&LocalFs, &dst_fs, plan, &ctx, tok, None).await;
    assert!(matches!(r, Err(DuetError::Cancelled)), "got {r:?}");
    let after = names(&dst);
    // list 순서는 OS 의존 — 순서와 무관하게 "b 는 덮어써졌고(.bak 생성) 일부는 안 됐다" 만 고정.
    assert_eq!(
        std::fs::read(dst.join("b_changed.txt")).unwrap(),
        b"NEW-content"
    );
    assert!(after.iter().any(|n| n.starts_with("b_changed.txt.bak")));
    assert!(
        !(after.contains(&"a_new.txt".to_string()) && after.contains(&"c_later.txt".to_string()))
    );
    assert!(
        !ctx.journal.history(10).await.is_empty(),
        "cancelled sync already created/overwrote files but left no journal entry; dst = {after:?}"
    );
}

// ─── SC-02: 삭제 전파 켜고 동기화 → Ctrl+Z (사용자 흐름 끝까지) ──────────

/// 덮어쓰기 + 삭제 전파 → Ctrl+Z. 기대: 덮어쓴 파일이 원래 내용으로 돌아온다.
/// (prune 복원 단계는 실제 OS 휴지통 API 를 부르므로 `pruned` 를 비우고 실행 — 그 단계는
///  `.bak` 경로로만 복원(undo.rs:401-425)하므로 `edit` 결과에 영향 없음.)
#[tokio::test]
#[ignore = "sync-compare repro: SC-02 undo after prune+overwrite reports Ok but the overwritten file keeps the new content"]
async fn sync_prune_overwrite_then_undo_restores_overwritten_file() {
    let t = TempDir::new().unwrap();
    let (src, dst) = (t.path().join("src"), t.path().join("dst"));
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    let trash = t.path().join("fixture-trash");
    std::fs::create_dir_all(&trash).unwrap();
    write_at(&src.join("edit.txt"), b"new source", 1_700_000_100);
    write_at(&dst.join("edit.txt"), b"old", 1_700_000_000);
    let mut dst_fs = Fixture::new();
    dst_fs.trash_dir = Some(trash.clone());
    let ctx = mk_ctx(&t.path().join("ctx")).await;
    let mut plan = sync_plan(&LocalFs, &dst_fs, loc(&src), loc(&dst))
        .await
        .unwrap();
    plan.prune = true;
    let mut entry = sync_execute(
        &LocalFs,
        &dst_fs,
        plan,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    // 이번 실행이 만든 백업이 prune 으로 휴지통에 들어갔다.
    let trashed = names(&trash);
    assert!(
        trashed.iter().any(|n| n.contains("edit.txt.bak")),
        "trash = {trashed:?}"
    );
    if let UndoAction::UndoSync { pruned, .. } = &mut entry.undo {
        pruned.clear();
    }
    let out = execute_undo(&entry, &ConnectionPool::new()).await;
    let now = std::fs::read(dst.join("edit.txt")).unwrap();
    assert_eq!(
        String::from_utf8_lossy(&now),
        "old",
        "undo kind={:?} message={:?} — user sees success but edit.txt keeps the synced content",
        out.kind,
        out.message
    );
}

/// 같은 원인의 다른 흐름: 삭제 전파 없이 동기화를 반복하면 `.bak` 이 받는 폴더에 쌓이고,
/// 나중에 **삭제 전파를 한 번 켜면 이전 실행들의 백업까지 전부 휴지통**으로 간다.
/// (현재 동작 기록 — 통과)
#[tokio::test]
async fn sync_backups_accumulate_in_destination_and_are_pruned_later() {
    let t = TempDir::new().unwrap();
    let (src, dst) = (t.path().join("src"), t.path().join("dst"));
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    let trash = t.path().join("fixture-trash");
    std::fs::create_dir_all(&trash).unwrap();
    write_at(&dst.join("doc.txt"), b"v0", 1_700_000_000);
    let mut dst_fs = Fixture::new();
    dst_fs.trash_dir = Some(trash.clone());
    let ctx = mk_ctx(&t.path().join("ctx")).await;
    write_at(&src.join("doc.txt"), b"v1-longer", 1_700_000_100);
    let plan = sync_plan(&LocalFs, &dst_fs, loc(&src), loc(&dst))
        .await
        .unwrap();
    sync_execute(
        &LocalFs,
        &dst_fs,
        plan,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    let baks: Vec<_> = names(&dst)
        .into_iter()
        .filter(|n| n.contains(".bak"))
        .collect();
    assert_eq!(
        baks.len(),
        1,
        "a visible .bak now lives in the user's destination folder"
    );
    let mut plan = sync_plan(&LocalFs, &dst_fs, loc(&src), loc(&dst))
        .await
        .unwrap();
    plan.prune = true;
    sync_execute(
        &LocalFs,
        &dst_fs,
        plan,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(names(&dst).iter().all(|n| !n.contains(".bak")));
    assert!(names(&trash).iter().any(|n| n.contains(".bak")));
}

// ─── SC-03: 부모/자식 폴더 — 비교창 "병합" 도 같은 사고 ──────────────────

/// 왼쪽 = /p, 오른쪽 = /p/backup (탭 두 개가 부모·자식). 비교 → 병합.
/// "backup" 폴더가 왼쪽 전용으로 잡혀 /p/backup → /p/backup/backup 으로 복사되며
/// 방금 만든 폴더를 다시 읽어 끝없이 파고든다. 4단계에서 list 실패로 끊는다.
/// 기대: 상하위 조합은 거부(또는 자기 자신은 제외).
#[tokio::test]
async fn merge_parent_and_child_does_not_copy_into_itself() {
    let t = TempDir::new().unwrap();
    let p = t.path().join("p");
    let child = p.join("backup");
    std::fs::create_dir_all(&child).unwrap();
    std::fs::write(p.join("a.txt"), b"a").unwrap();
    std::fs::write(child.join("b.txt"), b"b").unwrap();
    let mut fs = Fixture::new();
    fs.blocked_list = Some(child.join("backup/backup/backup"));
    let ctx = mk_ctx(&t.path().join("ctx")).await;
    let r = merge_bidir(
        &fs,
        loc(&p),
        &fs,
        loc(&child),
        false,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await;
    assert!(
        !child.join("backup/backup").exists(),
        "merge copied the right folder into itself (result {r:?}); depth reached: {}",
        child.join("backup/backup/backup").exists()
    );
}

// ─── SC-06: 받는 폴더 안 폴더 링크 + 삭제 전파 ──────────────────────────

/// dst/sub 가 바깥 폴더(external)를 가리키는 링크. 삭제 전파를 켜고 동기화하면
/// 선택 범위 밖 external 의 파일이 휴지통으로 간다(쓰기뿐 아니라 삭제도 새어 나감).
#[cfg(unix)]
#[tokio::test]
#[ignore = "sync-compare repro: SC-06 prune follows a destination directory link and trashes files outside the target"]
async fn sync_prune_does_not_trash_through_destination_directory_link() {
    let t = TempDir::new().unwrap();
    let (src, dst, ext) = (
        t.path().join("src"),
        t.path().join("dst"),
        t.path().join("external"),
    );
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::create_dir_all(&ext).unwrap();
    std::fs::write(src.join("sub/keep.txt"), b"k").unwrap();
    std::fs::write(ext.join("unrelated.txt"), b"not part of the sync").unwrap();
    std::os::unix::fs::symlink(&ext, dst.join("sub")).unwrap();
    let trash = t.path().join("fixture-trash");
    std::fs::create_dir_all(&trash).unwrap();
    let mut dst_fs = Fixture::new();
    dst_fs.trash_dir = Some(trash.clone());
    let ctx = mk_ctx(&t.path().join("ctx")).await;
    let mut plan = sync_plan(&LocalFs, &dst_fs, loc(&src), loc(&dst))
        .await
        .unwrap();
    plan.prune = true;
    sync_execute(
        &LocalFs,
        &dst_fs,
        plan,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(
        ext.join("unrelated.txt").exists(),
        "file outside the selected destination was trashed; trash = {:?}",
        names(&trash)
    );
}

// ─── SC-17: macOS APFS(정규화 무시) 에서 NFC/NFD 두 행을 적용·병합 ──────

#[cfg(target_os = "macos")]
fn apfs_pair() -> Option<(TempDir, PathBuf, PathBuf, String, String)> {
    use unicode_normalization::UnicodeNormalization;
    let t = TempDir::new().unwrap();
    let (l, r) = (t.path().join("L"), t.path().join("R"));
    std::fs::create_dir_all(&l).unwrap();
    std::fs::create_dir_all(&r).unwrap();
    let nfc: String = "보고서.txt".nfc().collect();
    let nfd: String = "보고서.txt".nfd().collect();
    assert_ne!(nfc, nfd);
    std::fs::write(l.join(&nfc), b"LEFT-version").unwrap();
    std::fs::write(r.join(&nfd), b"RIGHT-version-longer").unwrap();
    // 이 볼륨이 정규화 무시가 아니면(예: 대소문자 구분 APFS 설정 등) 건너뛴다.
    if std::fs::metadata(l.join(&nfd)).is_err() {
        return None;
    }
    Some((t, l, r, nfc, nfd))
}

/// 수정 전: 비교창이 두 행(왼쪽만 / 오른쪽만, "생성 2 · 덮어쓰기 0")으로 보여 주고 기본 방향
/// 그대로 적용하면 실제로는 덮어쓰기가 일어났다. 수정 후(SC-17): 한 행(차이)이라 기본 방향이
/// 건너뛰기 — 아무것도 덮어쓰지 않는다.
#[cfg(target_os = "macos")]
#[tokio::test]
async fn apfs_nfc_nfd_rows_applied_as_creates_do_not_overwrite() {
    use duet_lib::core::compare::{compare_dirs, CompareStatus};
    use duet_lib::core::ops::{apply_compare, ApplyDecision, ApplyDirection};
    let Some((t, l, r, _nfc, _nfd)) = apfs_pair() else {
        return;
    };
    let fs = LocalFs::new();
    let plan = compare_dirs(&fs, loc(&l), &fs, loc(&r)).await.unwrap();
    let st: Vec<_> = plan.entries.iter().map(|e| e.status).collect();
    assert_eq!(st.len(), 1, "one row for one visible name: {st:?}");
    // FE 기본 방향(compareView.tsx:129-141): left_only→to_right, right_only→to_left.
    let decisions = plan
        .entries
        .iter()
        .map(|e| ApplyDecision {
            rel: e.rel.clone(),
            direction: match e.status {
                CompareStatus::LeftOnly => ApplyDirection::ToRight,
                CompareStatus::RightOnly => ApplyDirection::ToLeft,
                _ => ApplyDirection::Skip,
            },
        })
        .collect();
    let ctx = mk_ctx(&t.path().join("ctx")).await;
    let entry = apply_compare(
        &fs,
        loc(&l),
        &fs,
        loc(&r),
        decisions,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    let left_now: Vec<_> = std::fs::read_dir(&l)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (
                e.file_name().to_string_lossy().into_owned(),
                String::from_utf8_lossy(&std::fs::read(e.path()).unwrap()).into_owned(),
            )
        })
        .collect();
    let overwritten = match &entry.op {
        duet_lib::services::journal::OpKind::CompareApply { overwritten, .. } => *overwritten,
        _ => 0,
    };
    assert_eq!(
        overwritten, 0,
        "dialog promised 'create 2 · overwrite 0' but {overwritten} files were overwritten; left now = {left_now:?}"
    );
}

/// 같은 상황에서 "병합" 은 양쪽 다 '이미 있음'으로 조용히 건너뛴다 — 0 ↔ 0 성공(현재 동작).
#[cfg(target_os = "macos")]
#[tokio::test]
async fn apfs_nfc_nfd_rows_merge_silently_does_nothing() {
    use duet_lib::services::journal::OpKind;
    let Some((t, l, r, _nfc, _nfd)) = apfs_pair() else {
        return;
    };
    let fs = LocalFs::new();
    let ctx = mk_ctx(&t.path().join("ctx")).await;
    let e = merge_bidir(
        &fs,
        loc(&l),
        &fs,
        loc(&r),
        false,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    match e.op {
        OpKind::Merge {
            to_left, to_right, ..
        } => {
            assert_eq!((to_left, to_right), (0, 0));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(names(&l).len(), 1);
    assert_eq!(names(&r).len(), 1);
}
