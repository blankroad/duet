//! MVP-2 end-to-end smoke tests.
//!
//! 실제 `LocalFs` + 실제 `SettingsStore` + 실제 `Journal` 위에서 op → undo
//! 라운드-트립 검증. SshFs / IPC 레이어는 별도 — 본 파일은 core/ops + services
//! 통합 동작 확인.
//!
//! 실행: `cargo test --test mvp2_smoke`

use std::path::PathBuf;
use std::sync::Arc;

use duet_lib::core::ops::{self, copy_plan, delete_plan, mkdir, move_plan, rename, OpCtx};
use duet_lib::core::undo::{execute_undo, UndoKind};
use duet_lib::fs::LocalFs;
use duet_lib::services::connection_pool::ConnectionPool;
use duet_lib::services::journal::Journal;
use duet_lib::services::settings::{SettingsPatch, SettingsStore};
use duet_lib::types::{DeleteMode, DuetError, EntryRef, Location, SourceId};
use tempfile::TempDir;

/// 한 시나리오에 필요한 모든 상태.
struct Env {
    work: TempDir,
    cfg: TempDir,
    settings: Arc<SettingsStore>,
    journal: Arc<Journal>,
    pool: Arc<ConnectionPool>,
}

async fn setup() -> Env {
    let work = TempDir::new().unwrap();
    let cfg = TempDir::new().unwrap();
    let settings = SettingsStore::load_from(&cfg.path().join("s.toml"))
        .await
        .unwrap();
    let journal = Journal::load_from(&cfg.path().join("j.jsonl"))
        .await
        .unwrap();
    let pool = ConnectionPool::new();
    Env {
        work,
        cfg,
        settings,
        journal,
        pool,
    }
}

impl Env {
    fn ctx(&self) -> OpCtx {
        OpCtx {
            settings: self.settings.clone(),
            journal: self.journal.clone(),
            pool: None,
            app: None,
        }
    }
    fn dir(&self) -> &std::path::Path {
        self.work.path()
    }
    fn loc(&self, sub: &str) -> Location {
        Location {
            source: SourceId::Local,
            path: self.dir().join(sub),
        }
    }
    fn target(&self, sub: &str, name: &str) -> EntryRef {
        EntryRef {
            location: self.loc(sub),
            name: name.to_string(),
        }
    }
}

// === scenario 1: mkdir + undo ===

#[tokio::test]
async fn smoke_mkdir_then_undo_removes_dir() {
    let env = setup().await;
    let local = LocalFs::new();

    let entry = mkdir(
        &local,
        Location {
            source: SourceId::Local,
            path: env.dir().to_path_buf(),
        },
        "newdir".into(),
        &env.ctx(),
    )
    .await
    .unwrap();
    assert!(env.dir().join("newdir").is_dir());

    // pop_undoable 으로 가장 최근 entry 회수 → execute_undo
    let popped = env.journal.peek_undoable().await.unwrap().unwrap();
    assert_eq!(popped.id, entry.id);
    let outcome = execute_undo(&popped, &env.pool).await;
    env.journal.commit_undone(popped.id).await.unwrap();
    assert!(matches!(outcome.kind, UndoKind::Ok));
    assert!(!env.dir().join("newdir").exists());
}

// === scenario 2: rename + undo ===

#[tokio::test]
async fn smoke_rename_then_undo_restores_name() {
    let env = setup().await;
    let local = LocalFs::new();
    tokio::fs::write(env.dir().join("a.txt"), b"hello")
        .await
        .unwrap();

    rename(&local, env.target("", "a.txt"), "b.txt".into(), &env.ctx())
        .await
        .unwrap();
    assert!(!env.dir().join("a.txt").exists());
    assert!(env.dir().join("b.txt").exists());

    let popped = env.journal.peek_undoable().await.unwrap().unwrap();
    let outcome = execute_undo(&popped, &env.pool).await;
    env.journal.commit_undone(popped.id).await.unwrap();
    assert!(matches!(outcome.kind, UndoKind::Ok));
    assert!(env.dir().join("a.txt").exists());
    assert!(!env.dir().join("b.txt").exists());
}

// === scenario 3: copy with conflict (auto backup) + undo ===

#[tokio::test]
async fn smoke_copy_with_conflict_creates_backup_and_undo_restores() {
    let env = setup().await;
    let local = LocalFs::new();
    tokio::fs::create_dir(env.dir().join("src")).await.unwrap();
    tokio::fs::create_dir(env.dir().join("dst")).await.unwrap();
    tokio::fs::write(env.dir().join("src/a.txt"), b"NEW")
        .await
        .unwrap();
    tokio::fs::write(env.dir().join("dst/a.txt"), b"OLD")
        .await
        .unwrap();

    let plan = copy_plan(
        &local,
        &local,
        vec![env.target("src", "a.txt")],
        env.loc("dst"),
    )
    .await
    .unwrap();
    assert_eq!(plan.conflicts.len(), 1, "should detect conflict");

    let cancel = tokio_util::sync::CancellationToken::new();
    ops::copy_execute(
        &local,
        &local,
        plan,
        ops::ConflictPolicy::Replace,
        &env.ctx(),
        cancel,
        None,
    )
    .await
    .unwrap();

    // dst/a.txt = NEW, dst/a.txt.bak.* = OLD
    let new_content = tokio::fs::read(env.dir().join("dst/a.txt")).await.unwrap();
    assert_eq!(new_content, b"NEW");
    let backups: Vec<_> = std::fs::read_dir(env.dir().join("dst"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("a.txt.bak."))
        .collect();
    assert_eq!(backups.len(), 1, "should have one .bak.* file");

    // undo → dst/a.txt 다시 OLD, backup 사라짐
    let popped = env.journal.peek_undoable().await.unwrap().unwrap();
    let outcome = execute_undo(&popped, &env.pool).await;
    env.journal.commit_undone(popped.id).await.unwrap();
    assert!(
        matches!(outcome.kind, UndoKind::Ok),
        "undo failed: {:?}",
        outcome.message
    );
    let restored = tokio::fs::read(env.dir().join("dst/a.txt")).await.unwrap();
    assert_eq!(restored, b"OLD", "backup should be restored");
    let backups_after: Vec<_> = std::fs::read_dir(env.dir().join("dst"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("a.txt.bak."))
        .collect();
    assert_eq!(backups_after.len(), 0, "backup should be moved back");
}

// === scenario 4: move (same fs) + undo ===

#[tokio::test]
async fn smoke_move_same_fs_then_undo_restores() {
    let env = setup().await;
    let local = LocalFs::new();
    tokio::fs::create_dir(env.dir().join("src")).await.unwrap();
    tokio::fs::create_dir(env.dir().join("dst")).await.unwrap();
    tokio::fs::write(env.dir().join("src/a"), b"x")
        .await
        .unwrap();

    let plan = move_plan(&local, &local, vec![env.target("src", "a")], env.loc("dst"))
        .await
        .unwrap();
    assert!(plan.is_same_fs);

    let cancel = tokio_util::sync::CancellationToken::new();
    ops::move_execute(
        &local,
        &local,
        plan,
        ops::ConflictPolicy::Replace,
        &env.ctx(),
        cancel,
        None,
    )
    .await
    .unwrap();
    assert!(!env.dir().join("src/a").exists());
    assert!(env.dir().join("dst/a").exists());

    let popped = env.journal.peek_undoable().await.unwrap().unwrap();
    let outcome = execute_undo(&popped, &env.pool).await;
    env.journal.commit_undone(popped.id).await.unwrap();
    assert!(matches!(outcome.kind, UndoKind::Ok));
    assert!(env.dir().join("src/a").exists());
    assert!(!env.dir().join("dst/a").exists());
}

// === scenario 5: permanent delete gate ===

#[tokio::test]
async fn smoke_permanent_delete_blocked_then_allowed() {
    let env = setup().await;
    let local = LocalFs::new();
    tokio::fs::write(env.dir().join("a"), b"x").await.unwrap();

    let plan = delete_plan(&local, vec![env.target("", "a")], DeleteMode::Permanent)
        .await
        .unwrap();

    // settings off → NotPermitted (확인 단어가 맞아도 settings 게이트에서 먼저 차단)
    let result = ops::delete_execute(&local, plan.clone(), &env.ctx(), "delete").await;
    assert!(matches!(result, Err(DuetError::NotPermitted)));
    assert!(env.dir().join("a").exists(), "file should still exist");

    // settings on → 영구삭제
    env.settings
        .apply(SettingsPatch {
            permanent_delete_enabled: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
    let entry = ops::delete_execute(&local, plan, &env.ctx(), "delete")
        .await
        .unwrap();
    assert!(!env.dir().join("a").exists());

    // undo → Irreversible
    let popped = env.journal.peek_undoable().await.unwrap().unwrap();
    assert_eq!(popped.id, entry.id);
    let outcome = execute_undo(&popped, &env.pool).await;
    env.journal.commit_undone(popped.id).await.unwrap();
    assert!(matches!(outcome.kind, UndoKind::Irreversible));
}

// === scenario 6: trash + undo (Linux/Windows only — macOS 는 restore 미지원) ===

#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
#[tokio::test]
async fn smoke_trash_then_undo_restores_on_linux_windows() {
    let env = setup().await;
    let local = LocalFs::new();
    let target_path = env.dir().join("smoke-trash-target.txt");
    tokio::fs::write(&target_path, b"trash me").await.unwrap();

    let plan = delete_plan(
        &local,
        vec![env.target("", "smoke-trash-target.txt")],
        DeleteMode::Trash,
    )
    .await
    .unwrap();
    // Trash 모드 — confirm 단어는 무시됨.
    ops::delete_execute(&local, plan, &env.ctx(), "")
        .await
        .unwrap();
    assert!(!target_path.exists(), "file should be in trash");

    let popped = env.journal.peek_undoable().await.unwrap().unwrap();
    let outcome = execute_undo(&popped, &env.pool).await;
    env.journal.commit_undone(popped.id).await.unwrap();
    assert!(
        matches!(outcome.kind, UndoKind::Ok),
        "undo from trash failed: {:?}",
        outcome.message
    );
    assert!(target_path.exists(), "file should be restored");

    // cleanup — 다시 휴지통으로 (테스트가 디스크에 흔적 남기지 않도록)
    let _ = trash::delete(&target_path);
}

// === scenario 7: same-host SSH copy now uses SshSameHost strategy ===

#[tokio::test]
async fn smoke_same_host_ssh_copy_uses_ssh_same_host_strategy() {
    let env = setup().await;
    let local = LocalFs::new();
    use duet_lib::core::copy_strategy::CopyStrategy;
    use duet_lib::types::ConnectionId;
    use std::net::Ipv4Addr;
    let src = SourceId::Ssh {
        connection_id: ConnectionId("a".into()),
        host_ip: std::net::IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
        user: "u".into(),
    };
    let dst_src = src.clone();

    let item = EntryRef {
        location: Location {
            source: src,
            path: PathBuf::from("/x"),
        },
        name: "f".into(),
    };
    let dst = Location {
        source: dst_src,
        path: PathBuf::from("/y"),
    };

    // MVP-3: same-host SSH copy is now allowed — strategy = SshSameHost.
    let plan = copy_plan(&local, &local, vec![item], dst)
        .await
        .expect("same-host SSH copy should now succeed");
    assert_eq!(plan.strategy, CopyStrategy::SshSameHost);

    let _ = env; // suppress unused
}

// === scenario 8: journal persists across reload ===

#[tokio::test]
async fn smoke_journal_persists_across_reload() {
    let env = setup().await;
    let local = LocalFs::new();

    mkdir(
        &local,
        Location {
            source: SourceId::Local,
            path: env.dir().to_path_buf(),
        },
        "persisted".into(),
        &env.ctx(),
    )
    .await
    .unwrap();

    // 같은 jsonl 경로로 새 Journal — replay 되어야 함
    let j2 = Journal::load_from(&env.cfg.path().join("j.jsonl"))
        .await
        .unwrap();
    let history = j2.history(10).await;
    assert_eq!(history.len(), 1);
    assert!(!history[0].undone);
}
