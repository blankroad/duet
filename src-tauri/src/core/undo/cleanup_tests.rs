//! 생성분 정리 undo 테스트 — 실제 ops 로 기록을 만들고 fixture 휴지통(TempDir 안)으로 되돌린다.
//! OS 휴지통·영구 삭제는 부르지 않는다(fixture 가 막음).

use super::testing::{FixtureResolver, TrashDirFs};
use super::undo_cleanup;
use crate::core::ops::{self, ConflictPolicy, OpCtx};
use crate::core::undo::{UndoKind, UndoReason};
use crate::fs::LocalFs;
use crate::services::journal::{JournalEntry, TrashItem, UndoAction};
use crate::types::{ConnectionId, EntryRef, Location, SourceId};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

struct Env {
    t: TempDir,
    ctx: OpCtx,
    trash: TrashDirFs,
}

impl Env {
    async fn new() -> Self {
        let t = TempDir::new().unwrap();
        let c = t.path().join("ctx");
        std::fs::create_dir_all(&c).unwrap();
        let ctx = OpCtx {
            settings: crate::services::settings::SettingsStore::load_from(&c.join("s.toml"))
                .await
                .unwrap(),
            journal: crate::services::journal::Journal::load_from(&c.join("j.jsonl"))
                .await
                .unwrap(),
            pool: None,
            app: None,
        };
        let trash = TrashDirFs::new(&t.path().join("trash"));
        Self { t, ctx, trash }
    }
    fn dir(&self, name: &str) -> PathBuf {
        let p = self.t.path().join(name);
        std::fs::create_dir_all(&p).unwrap();
        p
    }
    async fn undo(&self, entry: &JournalEntry) -> crate::core::undo::UndoOutcome {
        undo_cleanup(entry, &FixtureResolver(self.trash.clone()))
            .await
            .expect("cleanup kind")
    }
}

fn loc(p: &Path) -> Location {
    Location {
        source: SourceId::Local,
        path: p.to_path_buf(),
    }
}

async fn copy(
    env: &Env,
    src: &Path,
    names: &[&str],
    dst: &Path,
    policy: ConflictPolicy,
) -> JournalEntry {
    let items = names
        .iter()
        .map(|n| EntryRef {
            location: loc(src),
            name: (*n).into(),
        })
        .collect();
    let plan = ops::copy_plan(&LocalFs, &LocalFs, items, loc(dst))
        .await
        .unwrap();
    ops::copy_execute(
        &LocalFs,
        &LocalFs,
        plan,
        policy,
        &env.ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn unchanged_copies_go_to_trash_not_permanent_delete() {
    let env = Env::new().await;
    let (src, dst) = (env.dir("src"), env.dir("dst"));
    std::fs::create_dir_all(src.join("proj/sub")).unwrap();
    std::fs::write(src.join("proj/sub/a.txt"), b"a").unwrap();
    std::fs::write(src.join("f.txt"), b"f").unwrap();
    let e = copy(&env, &src, &["proj", "f.txt"], &dst, ConflictPolicy::Skip).await;
    // Finder 가 폴더를 열어 부산물을 만들어도 "바뀜" 으로 보지 않는다.
    std::fs::write(dst.join("proj/.DS_Store"), b"finder").unwrap();

    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Ok, "{out:?}");
    assert!(!dst.join("proj").exists() && !dst.join("f.txt").exists());
    assert_eq!(
        env.trash.trashed(),
        2,
        "both copies are in the (fixture) trash"
    );
}

/// fileops-02: 사본 폴더 안에 사용자가 만든 파일은 지우지 않는다.
#[tokio::test]
async fn copied_folder_with_user_work_is_kept_and_reported() {
    let env = Env::new().await;
    let (src, dst) = (env.dir("src"), env.dir("dst"));
    std::fs::create_dir_all(src.join("proj")).unwrap();
    std::fs::write(src.join("proj/a.txt"), b"a").unwrap();
    let e = copy(&env, &src, &["proj"], &dst, ConflictPolicy::Skip).await;
    std::fs::write(dst.join("proj/notes.txt"), b"hours of work").unwrap();

    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Stale, "{out:?}");
    assert_eq!(out.reason, Some(UndoReason::Changed));
    assert_eq!(out.skipped[0].path, dst.join("proj"));
    assert!(dst.join("proj/notes.txt").exists());
    assert_eq!(env.trash.trashed(), 0);
}

#[tokio::test]
async fn one_edited_copy_gives_partial() {
    let env = Env::new().await;
    let (src, dst) = (env.dir("src"), env.dir("dst"));
    std::fs::write(src.join("a"), b"a").unwrap();
    std::fs::write(src.join("b"), b"b").unwrap();
    let e = copy(&env, &src, &["a", "b"], &dst, ConflictPolicy::Skip).await;
    std::fs::write(dst.join("b"), b"edited after copy").unwrap();

    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Partial, "{out:?}");
    assert!(!dst.join("a").exists());
    assert_eq!(std::fs::read(dst.join("b")).unwrap(), b"edited after copy");
}

/// 지문이 없는 구버전 기록은 바뀌었는지 모르므로 건너뛴다.
#[tokio::test]
async fn old_entry_without_stamps_is_skipped_as_unverifiable() {
    let env = Env::new().await;
    let dst = env.dir("dst");
    std::fs::write(dst.join("a"), b"a").unwrap();
    let e = env
        .ctx
        .journal
        .push(
            crate::services::journal::OpKind::Copy {
                count: 1,
                src: loc(&dst),
                dst: loc(&dst),
            },
            UndoAction::UndoCopy {
                target_source: SourceId::Local,
                copied: vec![dst.join("a")],
                backups_to_restore: vec![],
                src_source: None,
                copied_from: vec![],
                copied_stamps: vec![],
            },
        )
        .await
        .unwrap();
    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Stale);
    assert_eq!(out.reason, Some(UndoReason::Unverifiable));
    assert!(dst.join("a").exists());
}

/// 휴지통 실패는 Ok 로 삼키지 않고 Error (재시도 가능).
#[tokio::test]
async fn trash_failure_is_an_error_not_ok() {
    let env = Env::new().await;
    let (src, dst) = (env.dir("src"), env.dir("dst"));
    std::fs::write(src.join("a"), b"a").unwrap();
    let e = copy(&env, &src, &["a"], &dst, ConflictPolicy::Skip).await;
    env.trash.fail_trash.store(true, Ordering::SeqCst);
    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Error, "{out:?}");
    assert!(dst.join("a").exists());
    // 재시도하면 끝난다.
    env.trash.fail_trash.store(false, Ordering::SeqCst);
    assert_eq!(env.undo(&e).await.kind, UndoKind::Ok);
    assert!(!dst.join("a").exists());
}

/// 폴더 교체(Replace) 되돌리기 — 사본은 휴지통, 원래 폴더는 제자리로.
#[tokio::test]
async fn folder_replace_undo_restores_original_folder() {
    let env = Env::new().await;
    let (src, dst) = (env.dir("src"), env.dir("dst"));
    std::fs::create_dir_all(src.join("proj")).unwrap();
    std::fs::write(src.join("proj/new.txt"), b"new").unwrap();
    std::fs::create_dir_all(dst.join("proj")).unwrap();
    std::fs::write(dst.join("proj/old-only.txt"), b"old").unwrap();
    let e = copy(&env, &src, &["proj"], &dst, ConflictPolicy::Replace).await;
    assert!(dst.join("proj/new.txt").exists());

    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Ok, "{out:?}");
    assert!(dst.join("proj/old-only.txt").exists());
    assert!(!dst.join("proj/new.txt").exists());
}

/// 폴더 교체 뒤 사본에 작업을 했으면 사본도 백업도 그대로 두고 백업 위치를 알린다.
#[tokio::test]
async fn folder_replace_with_user_work_keeps_both() {
    let env = Env::new().await;
    let (src, dst) = (env.dir("src"), env.dir("dst"));
    std::fs::create_dir_all(src.join("proj")).unwrap();
    std::fs::write(src.join("proj/new.txt"), b"new").unwrap();
    std::fs::create_dir_all(dst.join("proj")).unwrap();
    std::fs::write(dst.join("proj/old-only.txt"), b"old").unwrap();
    let e = copy(&env, &src, &["proj"], &dst, ConflictPolicy::Replace).await;
    std::fs::write(dst.join("proj/mine.txt"), b"work").unwrap();

    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Stale, "{out:?}");
    assert!(dst.join("proj/mine.txt").exists());
    assert!(out.message.unwrap_or_default().contains("kept as"));
    assert_eq!(env.trash.trashed(), 0);
}

/// 동기화: 덮어쓴 파일 복원 + 새 파일 휴지통 + 새로 만든 폴더 트리 제거(SC-31).
#[tokio::test]
async fn sync_undo_restores_overwritten_and_removes_created_tree() {
    let env = Env::new().await;
    let (src, dst) = (env.dir("src"), env.dir("dst"));
    std::fs::write(src.join("same"), b"newer and longer").unwrap();
    std::fs::write(dst.join("same"), b"old").unwrap();
    std::fs::create_dir_all(src.join("newdir/sub")).unwrap();
    std::fs::write(src.join("newdir/sub/x"), b"x").unwrap();
    let plan = ops::sync_plan(&LocalFs, &LocalFs, loc(&src), loc(&dst))
        .await
        .unwrap();
    let e = ops::sync_execute(
        &LocalFs,
        &LocalFs,
        plan,
        &env.ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();

    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Ok, "{out:?}");
    assert_eq!(std::fs::read(dst.join("same")).unwrap(), b"old");
    assert!(!dst.join("newdir").exists(), "created folder tree removed");
    let left: Vec<_> = std::fs::read_dir(&dst).unwrap().collect();
    assert_eq!(left.len(), 1, "only the restored file remains");
}

/// 동기화 뒤 덮어쓴 파일을 또 고쳤으면 그 편집을 지키고 백업 위치를 알린다.
#[tokio::test]
async fn sync_undo_keeps_later_edit_of_overwritten_file() {
    let env = Env::new().await;
    let (src, dst) = (env.dir("src"), env.dir("dst"));
    std::fs::write(src.join("same"), b"newer and longer").unwrap();
    std::fs::write(dst.join("same"), b"old").unwrap();
    std::fs::write(src.join("added"), b"a").unwrap();
    let plan = ops::sync_plan(&LocalFs, &LocalFs, loc(&src), loc(&dst))
        .await
        .unwrap();
    let e = ops::sync_execute(
        &LocalFs,
        &LocalFs,
        plan,
        &env.ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    std::fs::write(dst.join("same"), b"edited after the sync").unwrap();

    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Partial, "{out:?}");
    assert_eq!(out.skipped[0].reason, UndoReason::Changed);
    assert_eq!(
        std::fs::read(dst.join("same")).unwrap(),
        b"edited after the sync"
    );
    assert!(!dst.join("added").exists());
    assert!(out.message.unwrap_or_default().contains("kept as"));
}

/// SC-09: 한쪽에 연결할 수 없으면 아무것도 하지 않고 Error (재시도 가능) — 한쪽만 되돌리고
/// "성공"으로 끝내지 않는다.
#[tokio::test]
async fn merge_undo_with_unreachable_side_changes_nothing() {
    let env = Env::new().await;
    let (l, r) = (env.dir("L"), env.dir("R"));
    std::fs::write(l.join("left"), b"L").unwrap();
    std::fs::write(r.join("right"), b"R").unwrap();
    let mut e = ops::merge_bidir(
        &LocalFs,
        loc(&l),
        &LocalFs,
        loc(&r),
        false,
        &env.ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    if let UndoAction::UndoBidirMerge { left_source, .. } = &mut e.undo {
        *left_source = SourceId::Ssh {
            connection_id: ConnectionId("gone".into()),
            host_ip: "127.0.0.1".parse().unwrap(),
            user: "u".into(),
        };
    }
    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Error);
    assert_eq!(out.reason, Some(UndoReason::Unreachable));
    assert!(r.join("left").exists() && l.join("right").exists());
    assert_eq!(env.trash.trashed(), 0);
}

/// 이 OS 가 휴지통 복원을 못 하면(macOS) 건너뜀 + 수동 복원 안내 — Ok 로 덮지 않는다.
#[tokio::test]
async fn prune_restore_unsupported_is_reported() {
    let env = Env::new().await;
    let dst = env.dir("dst");
    env.trash.restore_unsupported.store(true, Ordering::SeqCst);
    let e = env
        .ctx
        .journal
        .push(
            crate::services::journal::OpKind::Sync {
                count: 0,
                pruned: 1,
                src: loc(&dst),
                dst: loc(&dst),
            },
            UndoAction::UndoSync {
                dst_source: SourceId::Local,
                created: vec![],
                backups_to_restore: vec![],
                pruned: vec![TrashItem {
                    trash_path: String::new(),
                    original_path: dst.join("pruned"),
                }],
                src_source: None,
                created_from: vec![],
                created_stamps: vec![],
                created_dirs: vec![],
            },
        )
        .await
        .unwrap();
    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Stale, "{out:?}");
    assert_eq!(out.reason, Some(UndoReason::TrashRestoreUnsupported));
    assert!(out.message.unwrap_or_default().contains("manually"));
}

fn sync_entry(dst: &Path, created_dirs: Vec<PathBuf>, pruned: Vec<TrashItem>) -> UndoAction {
    UndoAction::UndoSync {
        dst_source: SourceId::Local,
        created: vec![],
        backups_to_restore: vec![],
        pruned,
        src_source: None,
        created_from: vec![],
        created_stamps: vec![],
        created_dirs: created_dirs.into_iter().map(|d| dst.join(d)).collect(),
    }
}

async fn push(env: &Env, dst: &Path, undo: UndoAction) -> JournalEntry {
    env.ctx
        .journal
        .push(
            crate::services::journal::OpKind::Sync {
                count: 0,
                pruned: 0,
                src: loc(dst),
                dst: loc(dst),
            },
            undo,
        )
        .await
        .unwrap()
}

/// R2-sol-03: 만든 폴더를 못 지운 일시 오류(권한·연결)는 Error — "되돌림"으로 확정하지 않는다.
#[tokio::test]
async fn created_dir_cleanup_error_stays_retryable() {
    let env = Env::new().await;
    let dst = env.dir("dst");
    std::fs::create_dir(dst.join("made")).unwrap();
    *env.trash.fail_rmdir.lock().unwrap() = Some(dst.join("made"));
    let e = push(&env, &dst, sync_entry(&dst, vec!["made".into()], vec![])).await;
    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Error, "{out:?}");
    assert!(dst.join("made").exists());
}

/// 만든 폴더에 사용자 파일이 남아 있으면 조용히 둔다(오류 아님).
#[tokio::test]
async fn created_dir_with_user_files_is_left_quietly() {
    let env = Env::new().await;
    let dst = env.dir("dst");
    std::fs::create_dir(dst.join("made")).unwrap();
    std::fs::write(dst.join("made/mine.txt"), b"mine").unwrap();
    let e = push(&env, &dst, sync_entry(&dst, vec!["made".into()], vec![])).await;
    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Ok, "{out:?}");
    assert!(dst.join("made/mine.txt").exists());
}

/// R2-sol-04: 휴지통 쪽 항목이 영구히 없어졌으면(휴지통 비움) Error 로 스택을 막지 않고
/// Gone 으로 건너뛴다.
#[tokio::test]
async fn missing_trashed_item_is_gone_not_a_blocking_error() {
    let env = Env::new().await;
    let dst = env.dir("dst");
    let emptied = env.trash.trash_dir.join("emptied-long-ago");
    let pruned = vec![TrashItem {
        trash_path: emptied.to_string_lossy().into_owned(),
        original_path: dst.join("pruned.txt"),
    }];
    let e = push(&env, &dst, sync_entry(&dst, vec![], pruned)).await;
    let out = env.undo(&e).await;
    assert_eq!(out.kind, UndoKind::Stale, "{out:?}");
    assert_eq!(out.reason, Some(UndoReason::Gone));
}
