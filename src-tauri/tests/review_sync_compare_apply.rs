//! sync-compare 점검 라운드(2026-11-08, opus-1) — 비교 적용·양방향 머지·3-way 의
//! 적용/undo 왕복 재현 테스트. 모든 파일 작업은 `TempDir` 안에서만 한다.
//! OS 휴지통을 부르는 경로(3-way 삭제 전파, prune)는 실행하지 않는다.
//!
//! `#[ignore = "sync-compare repro: …"]` 가 붙은 테스트는 **기대 동작**을 단언하며
//! 현재 코드에서 실패한다(결함 재현). 실행:
//! `cargo test --manifest-path src-tauri/Cargo.toml --test review_sync_compare_apply -- --include-ignored`

#[path = "support/undo_fixture.rs"]
mod undo_fixture;

use std::path::Path;

use duet_lib::core::compare::{compare_dirs_progress, CompareRules, CompareStatus};
use duet_lib::core::ops::{apply_compare, merge_bidir, ApplyDecision, ApplyDirection, OpCtx};
use duet_lib::core::three_way::{compare_three_way, ThreeWayStatus};
use duet_lib::core::undo::UndoKind;
use duet_lib::fs::LocalFs;
use duet_lib::services::journal::{Journal, UndoAction};
use duet_lib::services::settings::SettingsStore;
use duet_lib::types::{ConnectionId, Location, SourceId};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

async fn mk_ctx(dir: &Path) -> OpCtx {
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

fn dec(rel: &str, direction: ApplyDirection) -> ApplyDecision {
    ApplyDecision {
        rel: rel.into(),
        direction,
    }
}

/// L, R, ctx 디렉터리를 만든 TempDir.
fn sides() -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
    let dir = TempDir::new().unwrap();
    let l = dir.path().join("L");
    let r = dir.path().join("R");
    std::fs::create_dir_all(&l).unwrap();
    std::fs::create_dir_all(&r).unwrap();
    std::fs::create_dir_all(dir.path().join("ctx")).unwrap();
    (dir, l, r)
}

fn set_mtime(p: &Path, secs: u64) {
    let f = std::fs::File::options().write(true).open(p).unwrap();
    f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs))
        .unwrap();
}

/// 이름에 `.bak` 이 들어간 형제가 있는지(백업 파일 흔적).
fn has_backup_sibling(dir: &Path, stem: &str) -> bool {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n != stem && n.starts_with(stem) && n.contains("bak")
        })
}

// ─── C-10 비교 결과 적용 ────────────────────────────────────────────────

/// 비교 뒤 소스 파일이 사라졌다(다른 프로그램이 지움 등). 그 행을 적용하면
/// **받는 쪽 파일이 그대로 있어야** 한다(SC-08). 예전엔 받는 쪽을 먼저 `.bak` 으로 치운 뒤
/// 복사가 NotFound 로 실패 — 원래 이름의 파일이 사라진 채 오류만 남았다.
#[tokio::test]
async fn apply_compare_missing_source_must_not_displace_destination() {
    let (dir, l, r) = sides();
    std::fs::write(r.join("a.txt"), b"keep-me").unwrap();
    // left/a.txt 는 비교 당시엔 있었지만 적용 시점엔 없음.
    let fs = LocalFs::new();
    let ctx = mk_ctx(&dir.path().join("ctx")).await;
    let res = apply_compare(
        &fs,
        loc(&l),
        &fs,
        loc(&r),
        vec![dec("a.txt", ApplyDirection::ToRight)],
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await;
    assert!(res.is_err(), "source missing → error expected");
    assert_eq!(
        std::fs::read(r.join("a.txt")).ok().as_deref(),
        Some(&b"keep-me"[..]),
        "destination must stay at its original name (found .bak sibling: {})",
        has_backup_sibling(&r, "a.txt")
    );
}

/// 원본이 사라진 행만 적용하면 아무것도 바뀌지 않는다 — `.bak` 도, 빈 journal 기록도 없다
/// (SC-08 + SC-40). 오류는 건너뛴 행 이름을 담는다.
#[tokio::test]
async fn apply_compare_missing_source_leaves_no_backup_or_journal() {
    let (dir, l, r) = sides();
    std::fs::write(r.join("a.txt"), b"keep-me").unwrap();
    let fs = LocalFs::new();
    let ctx = mk_ctx(&dir.path().join("ctx")).await;
    let res = apply_compare(
        &fs,
        loc(&l),
        &fs,
        loc(&r),
        vec![dec("a.txt", ApplyDirection::ToRight)],
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await;
    match res {
        Err(duet_lib::types::DuetError::NotFound(msg)) => {
            assert!(msg.contains("a.txt"), "skipped row named: {msg}")
        }
        other => panic!("expected NotFound for the skipped row, got {other:?}"),
    }
    assert_eq!(std::fs::read(r.join("a.txt")).unwrap(), b"keep-me");
    assert!(
        !has_backup_sibling(&r, "a.txt"),
        "no .bak for a skipped row"
    );
    assert!(
        ctx.journal.peek_undoable().await.unwrap().is_none(),
        "nothing changed → no journal entry"
    );
}

/// 두 번째 행 소스 없음 — 그 행만 건너뛰고(SC-08) 나머지는 적용, 적용분은 journal 에 남아
/// Ctrl+Z 로 복원. 결과는 건너뛴 행을 알리는 오류.
#[tokio::test]
async fn apply_compare_partial_failure_journals_and_undo_restores() {
    let (dir, l, r) = sides();
    std::fs::write(l.join("a.txt"), b"L-a").unwrap();
    std::fs::write(r.join("a.txt"), b"R-a").unwrap();
    std::fs::write(l.join("c.txt"), b"L-c").unwrap();
    let fs = LocalFs::new();
    let ctx = mk_ctx(&dir.path().join("ctx")).await;
    let res = apply_compare(
        &fs,
        loc(&l),
        &fs,
        loc(&r),
        vec![
            dec("a.txt", ApplyDirection::ToRight),
            dec("b-missing.txt", ApplyDirection::ToRight),
            dec("c.txt", ApplyDirection::ToRight),
        ],
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await;
    match &res {
        Err(duet_lib::types::DuetError::NotFound(msg)) => {
            assert!(msg.contains("b-missing.txt"), "skipped row named: {msg}")
        }
        other => panic!("expected NotFound for the skipped row, got {other:?}"),
    }
    assert_eq!(std::fs::read(r.join("a.txt")).unwrap(), b"L-a");
    assert_eq!(
        std::fs::read(r.join("c.txt")).unwrap(),
        b"L-c",
        "rows after the skipped one are still applied"
    );
    let entry = ctx
        .journal
        .peek_undoable()
        .await
        .unwrap()
        .expect("journaled");
    let out = undo_fixture::undo_tmp(&entry).await;
    assert!(matches!(out.kind, UndoKind::Ok));
    assert_eq!(std::fs::read(r.join("a.txt")).unwrap(), b"R-a");
    assert!(!r.join("b-missing.txt").exists());
    assert!(!r.join("c.txt").exists(), "undo removes the applied c.txt");
}

/// 타입 불일치(왼쪽 폴더 vs 오른쪽 파일) 행 적용 → 폴더로 교체, Ctrl+Z 로 파일 복원.
#[tokio::test]
async fn apply_compare_type_mismatch_roundtrip() {
    let (dir, l, r) = sides();
    std::fs::create_dir_all(l.join("x")).unwrap();
    std::fs::write(l.join("x/inner.txt"), b"in").unwrap();
    std::fs::write(r.join("x"), b"i-am-a-file").unwrap();
    let fs = LocalFs::new();
    let ctx = mk_ctx(&dir.path().join("ctx")).await;
    let entry = apply_compare(
        &fs,
        loc(&l),
        &fs,
        loc(&r),
        vec![dec("x", ApplyDirection::ToRight)],
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(r.join("x/inner.txt")).unwrap(), b"in");
    let out = undo_fixture::undo_tmp(&entry).await;
    assert!(matches!(out.kind, UndoKind::Ok));
    assert_eq!(std::fs::read(r.join("x")).unwrap(), b"i-am-a-file");
}

/// 적용으로 새로 생긴 폴더 안에 사용자가 파일을 추가한 뒤 Ctrl+Z.
/// 기대: 사용자가 만든 파일은 남는다(건너뛰거나 휴지통). 현재: `fs.remove` →
/// `remove_dir_all` 로 폴더째 **영구 삭제**(CLAUDE.md §3·§4).
#[tokio::test]
async fn apply_compare_undo_keeps_user_files_added_into_created_folder() {
    let (dir, l, r) = sides();
    std::fs::create_dir_all(l.join("d")).unwrap();
    std::fs::write(l.join("d/x.txt"), b"x").unwrap();
    let fs = LocalFs::new();
    let ctx = mk_ctx(&dir.path().join("ctx")).await;
    let entry = apply_compare(
        &fs,
        loc(&l),
        &fs,
        loc(&r),
        vec![dec("d", ApplyDirection::ToRight)],
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    // 사용자가 적용 후 그 폴더에서 작업.
    std::fs::write(r.join("d/my-notes.txt"), b"precious").unwrap();
    let _ = undo_fixture::undo_tmp(&entry).await;
    assert!(
        r.join("d/my-notes.txt").exists(),
        "file the user created after apply was permanently deleted by undo"
    );
}

/// 덮어쓴 파일을 사용자가 이어서 편집한 뒤 Ctrl+Z — 편집분이 휴지통/백업 없이 사라짐.
#[tokio::test]
async fn apply_compare_undo_does_not_silently_drop_later_edits() {
    let (dir, l, r) = sides();
    std::fs::write(l.join("b.txt"), b"left").unwrap();
    std::fs::write(r.join("b.txt"), b"right-old").unwrap();
    let fs = LocalFs::new();
    let ctx = mk_ctx(&dir.path().join("ctx")).await;
    let entry = apply_compare(
        &fs,
        loc(&l),
        &fs,
        loc(&r),
        vec![dec("b.txt", ApplyDirection::ToRight)],
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    std::fs::write(r.join("b.txt"), b"left + edits made after apply").unwrap();
    let out = undo_fixture::undo_tmp(&entry).await;
    let now = std::fs::read(r.join("b.txt")).unwrap();
    let edits_survive = std::fs::read_dir(&r)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| {
            std::fs::read(e.path()).ok().as_deref() == Some(&b"left + edits made after apply"[..])
        });
    assert!(
        edits_survive || !matches!(out.kind, UndoKind::Ok),
        "undo reported Ok and the post-apply edits are gone (b.txt now {:?})",
        String::from_utf8_lossy(&now)
    );
}

// ─── C-11 양방향 머지 ────────────────────────────────────────────────────

/// 비교창에서 무시 패턴(`node_modules`)을 걸어 목록에 안 보이게 했어도, 머지는 규칙
/// 없이 다시 비교해 그 폴더까지 복사한다. 기대: 비교창에서 본 범위만 머지.
#[tokio::test]
#[ignore = "sync-compare repro: merge_bidir ignores the compare rules (ignore globs) the dialog used"]
async fn merge_respects_ignore_globs_shown_in_compare_dialog() {
    let (dir, l, r) = sides();
    std::fs::write(l.join("keep.txt"), b"k").unwrap();
    std::fs::create_dir_all(l.join("node_modules/pkg")).unwrap();
    std::fs::write(l.join("node_modules/pkg/index.js"), b"js").unwrap();
    let fs = LocalFs::new();
    // 비교창이 사용자에게 보여 준 결과(무시 규칙 적용).
    let rules = CompareRules {
        ignore_globs: vec!["node_modules".into()],
        mtime_tolerance_ms: 0,
    };
    let shown = compare_dirs_progress(
        &fs,
        loc(&l),
        &fs,
        loc(&r),
        &rules,
        &CancellationToken::new(),
        &|_| {},
    )
    .await
    .unwrap();
    assert_eq!(shown.entries.len(), 1, "dialog shows only keep.txt");
    assert_eq!(shown.entries[0].status, CompareStatus::LeftOnly);
    // 사용자가 Merge 클릭 → FE 는 detectRenames 만 넘긴다(App.tsx onMerge).
    let ctx = mk_ctx(&dir.path().join("ctx")).await;
    merge_bidir(
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
    assert!(r.join("keep.txt").exists());
    assert!(
        !r.join("node_modules").exists(),
        "ignored folder (not in dialog) was copied by merge"
    );
}

/// 머지로 생긴 폴더에 사용자가 파일을 넣은 뒤 Ctrl+Z → 폴더째 영구 삭제.
#[tokio::test]
async fn merge_undo_keeps_user_files_added_into_created_folder() {
    let (dir, l, r) = sides();
    std::fs::create_dir_all(l.join("d")).unwrap();
    std::fs::write(l.join("d/x.txt"), b"x").unwrap();
    let fs = LocalFs::new();
    let ctx = mk_ctx(&dir.path().join("ctx")).await;
    let entry = merge_bidir(
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
    std::fs::write(r.join("d/my-notes.txt"), b"precious").unwrap();
    let _ = undo_fixture::undo_tmp(&entry).await;
    assert!(
        r.join("d/my-notes.txt").exists(),
        "file the user created after merge was permanently deleted by undo"
    );
}

/// 머지 undo 때 한쪽(원격) 연결이 없으면 아무것도 지우지 못했는데도 `Ok` 를 돌려
/// journal 이 "되돌림"으로 확정된다(commands/undo.rs:32) → 다시 시도할 수 없다.
/// 비교 적용(UndoCompareApply)은 같은 상황에서 Error 를 돌려 재시도가 가능하다.
#[tokio::test]
async fn merge_undo_with_unreachable_side_must_not_report_ok() {
    let (dir, l, r) = sides();
    std::fs::write(l.join("only_l.txt"), b"L").unwrap();
    let fs = LocalFs::new();
    let ctx = mk_ctx(&dir.path().join("ctx")).await;
    let mut entry = merge_bidir(
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
    // 오른쪽이 원격이었고 지금은 끊겼다고 가정 — 풀에 없는 connection id.
    if let UndoAction::UndoBidirMerge { right_source, .. } = &mut entry.undo {
        *right_source = SourceId::Ssh {
            connection_id: ConnectionId("gone".into()),
            host_ip: "127.0.0.1".parse().unwrap(),
            user: "u".into(),
        };
    } else {
        panic!("expected UndoBidirMerge");
    }
    let out = undo_fixture::undo_tmp(&entry).await;
    assert!(r.join("only_l.txt").exists(), "nothing was undone");
    assert!(
        !matches!(out.kind, UndoKind::Ok),
        "undo must not report Ok (journal would mark it undone, no retry)"
    );
}

/// 대조군: 같은 상황에서 비교 적용 undo 는 Error → journal 미확정(재시도 가능).
#[tokio::test]
async fn compare_apply_undo_with_unreachable_side_reports_error() {
    let (dir, l, r) = sides();
    std::fs::write(l.join("only_l.txt"), b"L").unwrap();
    let fs = LocalFs::new();
    let ctx = mk_ctx(&dir.path().join("ctx")).await;
    let mut entry = apply_compare(
        &fs,
        loc(&l),
        &fs,
        loc(&r),
        vec![dec("only_l.txt", ApplyDirection::ToRight)],
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    if let UndoAction::UndoCompareApply { right_source, .. } = &mut entry.undo {
        *right_source = SourceId::Ssh {
            connection_id: ConnectionId("gone".into()),
            host_ip: "127.0.0.1".parse().unwrap(),
            user: "u".into(),
        };
    } else {
        panic!("expected UndoCompareApply");
    }
    let out = undo_fixture::undo_tmp(&entry).await;
    assert!(matches!(out.kind, UndoKind::Error));
}

/// 시작 전에 취소된 머지는 아무것도 바꾸지 않았으므로 기록도 남기지 않는다(SC-40 —
/// 빈 기록이 Ctrl+Z 한 번을 소모하던 결함).
#[tokio::test]
async fn merge_cancelled_before_start_leaves_no_journal_entry() {
    let (dir, l, r) = sides();
    std::fs::write(l.join("a.txt"), b"L").unwrap();
    let fs = LocalFs::new();
    let ctx = mk_ctx(&dir.path().join("ctx")).await;
    let tok = CancellationToken::new();
    tok.cancel();
    let res = merge_bidir(&fs, loc(&l), &fs, loc(&r), false, &ctx, tok, None).await;
    assert!(res.is_err());
    assert!(!r.join("a.txt").exists());
    assert!(
        ctx.journal.peek_undoable().await.unwrap().is_none(),
        "SC-40: cancelled-before-start merge must not leave an empty undo entry"
    );
}

// ─── C-13 3-way ─────────────────────────────────────────────────────────

/// 오른쪽 하위 폴더를 읽을 수 없으면(권한/끊김) `unwrap_or_default()` 로 **빈 폴더**
/// 취급 → base 와 같은 왼쪽 파일이 전부 `RightDeleted`(= 적용 시 왼쪽에서 휴지통) 로
/// 분류된다. 2-way 비교는 같은 상황을 Unreadable 로 막는다(compare.rs:302).
#[cfg(unix)]
#[tokio::test]
#[ignore = "sync-compare repro: three_way treats an unreadable folder as empty → RightDeleted"]
async fn three_way_unreadable_subfolder_is_not_classified_as_deleted() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new().unwrap();
    let (b, l, r) = (
        dir.path().join("B"),
        dir.path().join("L"),
        dir.path().join("R"),
    );
    for side in [&b, &l, &r] {
        std::fs::create_dir_all(side.join("sub")).unwrap();
        std::fs::write(side.join("sub/a.txt"), b"same").unwrap();
        set_mtime(&side.join("sub/a.txt"), 1_700_000_000);
    }
    std::fs::set_permissions(r.join("sub"), std::fs::Permissions::from_mode(0o000)).unwrap();
    // root 로 돌면 권한이 무시돼 재현 불가 — 그땐 건너뛴다.
    let readable_anyway = std::fs::read_dir(r.join("sub")).is_ok();
    let fs = LocalFs::new();
    let plan = compare_three_way(&fs, loc(&b), &fs, loc(&l), &fs, loc(&r)).await;
    std::fs::set_permissions(r.join("sub"), std::fs::Permissions::from_mode(0o755)).unwrap();
    if readable_anyway {
        return;
    }
    let plan = plan.unwrap();
    let deleted: Vec<_> = plan
        .entries
        .iter()
        .filter(|e| e.status == ThreeWayStatus::RightDeleted)
        .map(|e| e.rel.clone())
        .collect();
    assert!(
        deleted.is_empty(),
        "unreadable right/sub classified as deletion → apply would trash left/{deleted:?}"
    );
}

/// base 입력칸의 기본값이 왼쪽 경로였을 때(fileActions.ts) 그대로 Enter 하면 base==left →
/// 왼쪽에만 있는 파일이 전부 "오른쪽에서 삭제됨"(적용 시 왼쪽에서 휴지통) 이 됐다(SC-16).
/// 이제 비교 단계에서 같은 경로·상하위 루트를 `IntoItself` 로 거부한다.
#[tokio::test]
async fn three_way_base_equal_to_left_is_rejected() {
    let (dir, l, r) = sides();
    let _ = dir;
    std::fs::write(l.join("new-work.txt"), b"mine").unwrap();
    let fs = LocalFs::new();
    let res = compare_three_way(&fs, loc(&l), &fs, loc(&l), &fs, loc(&r)).await;
    assert!(
        matches!(res, Err(duet_lib::types::DuetError::IntoItself(_))),
        "base == left must be refused before classifying anything: {:?}",
        res.map(|p| p.entries.len())
    );
}

/// 3-way 적용(변경·추가 전파) + Ctrl+Z 왕복 — 삭제 전파는 OS 휴지통이라 제외.
#[tokio::test]
async fn three_way_apply_change_and_add_then_undo() {
    use duet_lib::core::ops::apply_three_way;
    let dir = TempDir::new().unwrap();
    let (b, l, r) = (
        dir.path().join("B"),
        dir.path().join("L"),
        dir.path().join("R"),
    );
    for side in [&b, &l, &r] {
        std::fs::create_dir_all(side).unwrap();
        std::fs::write(side.join("c.txt"), b"base").unwrap();
        set_mtime(&side.join("c.txt"), 1_700_000_000);
    }
    std::fs::create_dir_all(dir.path().join("ctx")).unwrap();
    // left 만 변경 + left 에 추가.
    std::fs::write(l.join("c.txt"), b"left-changed").unwrap();
    set_mtime(&l.join("c.txt"), 1_700_000_100);
    std::fs::write(l.join("added.txt"), b"new").unwrap();
    let fs = LocalFs::new();
    let ctx = mk_ctx(&dir.path().join("ctx")).await;
    let entry = apply_three_way(
        &fs,
        loc(&b),
        &fs,
        loc(&l),
        &fs,
        loc(&r),
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(r.join("c.txt")).unwrap(), b"left-changed");
    assert_eq!(std::fs::read(r.join("added.txt")).unwrap(), b"new");
    let out = undo_fixture::undo_tmp(&entry).await;
    assert!(matches!(out.kind, UndoKind::Ok));
    assert_eq!(std::fs::read(r.join("c.txt")).unwrap(), b"base");
    assert!(!r.join("added.txt").exists());
}
