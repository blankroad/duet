//! sync-compare R3(opus-3) — SC-31 동기화 undo 가 새로 만든 폴더를 남기는지. TempDir 안에서만.
//! 실행: `cargo test --manifest-path src-tauri/Cargo.toml --test review_sync_compare_r3_opus -- --include-ignored`

#[path = "support/undo_fixture.rs"]
mod undo_fixture;

use duet_lib::core::ops::{sync_execute, sync_plan, OpCtx};
use duet_lib::core::undo::UndoKind;
use duet_lib::fs::LocalFs;
use duet_lib::services::journal::Journal;
use duet_lib::services::settings::SettingsStore;
use duet_lib::types::{Location, SourceId};
use std::path::Path;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

fn loc(p: &Path) -> Location {
    Location {
        source: SourceId::Local,
        path: p.to_path_buf(),
    }
}

/// src 에만 있는 폴더 트리(newdir/sub/x.txt)를 동기화 → Ctrl+Z.
/// 기대: 동기화 전 상태(dst 비어 있음)로 돌아간다. 현재: 파일만 지워지고 빈 폴더 트리가 남는다.
#[tokio::test]
async fn sync_undo_removes_folders_it_created() {
    let t = TempDir::new().unwrap();
    let (src, dst, c) = (
        t.path().join("src"),
        t.path().join("dst"),
        t.path().join("ctx"),
    );
    for d in [&src, &dst, &c] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::create_dir_all(src.join("newdir/sub")).unwrap();
    std::fs::write(src.join("newdir/sub/x.txt"), b"x").unwrap();
    let ctx = OpCtx {
        settings: SettingsStore::load_from(&c.join("s.toml")).await.unwrap(),
        journal: Journal::load_from(&c.join("j.jsonl")).await.unwrap(),
        pool: None,
        app: None,
    };
    let plan = sync_plan(&LocalFs, &LocalFs, loc(&src), loc(&dst))
        .await
        .unwrap();
    let entry = sync_execute(
        &LocalFs,
        &LocalFs,
        plan,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(dst.join("newdir/sub/x.txt").exists());
    let out = undo_fixture::undo_tmp(&entry).await;
    assert!(matches!(out.kind, UndoKind::Ok), "undo kind {:?}", out.kind);
    assert!(
        !dst.join("newdir/sub/x.txt").exists(),
        "created file removed"
    );
    assert!(
        !dst.join("newdir").exists(),
        "undo reported Ok but left the empty folder tree dst/newdir/sub; refreshed = {:?}",
        out.refreshed_locations
    );
}
