# sync round 1 — ux-sync-opus

Branch `ux-smoke/sync-opus`, base `76b9b6e`. **No cargo was run (cargo frozen).** All Rust changes are formatted with rustfmt only, and none has been compiled. FE: focused vitest (1 worker) + `pnpm exec tsc --noEmit` (pass) + eslint on changed files (pass).

## Commits

| Issue | Commit | Files | Tests |
|---|---|---|---|
| SC-11 | `863d38d` fe/lib | `src/lib/compareRules.ts` (new), `fileActions.ts`, `CompareRulesBar.tsx`, `CompareDialog.tsx` | new `src/lib/compareRules.test.ts` (6); SC-11 `it.fails` in `sync-compare-compare-flow.test.tsx` → normal test. vitest PASS |
| SC-16 | `b3fb471` be/core | `core/three_way.rs` (ensure_roots_unrelated for all 3 root pairs in compare_three_way), `fileActions.ts` (empty base prompt + FE overlap check), en/ko i18n | new `src/lib/threeWayBase.test.ts` (7, PASS); Rust `three_way::tests::compare_three_way_rejects_related_roots`; apply.rs record test → `three_way_base_equal_to_left_is_rejected` |
| SC-08 | `ac5554e` be/core | `core/ops.rs` (RowApplied, source check in apply_one_relay / apply_one_same_host, skip and report in compare-apply + 3-way), `core/ops_paths_tests.rs` (probe test now expects SourceMissing) | un-ignored apply `apply_compare_missing_source_must_not_displace_destination`, xcheck_sol `sc08_…` (journal assertion flipped to is_none, per SC-40); rewrote `apply_compare_missing_source_leaves_no_backup_or_journal` and `apply_compare_partial_failure_journals_and_undo_restores` (later rows now apply) |
| SC-05 | `093db91` be/core | `core/three_way.rs` (ThreeWayStatus::Unreadable; NotFound = empty, other list errors = one Unreadable row), `ThreeWayDialog.tsx`, en/ko | Rust unit test `compare_three_way_unreadable_subfolder_is_a_conflict_row`; un-ignored apply `three_way_unreadable_subfolder_…` and xcheck_sol `sc05_connection_failure_…`; sol `sc05_changed_survivor…` now expects the Unreadable row; new `ThreeWayDialog.test.tsx` (2, PASS) |
| SC-07 | `487ffca` be/cmd | `core/ops.rs` (new `merge_bidir_with_rules`; `merge_bidir` kept as a default-rules wrapper so sol/browse tests are untouched), `commands/fs_ops.rs`, `ui-dialogs.ts`, `CompareDialog.tsx`, `App.tsx`, `fileActions.ts` | un-ignored apply `merge_respects_ignore_globs_…` + xcheck_sol `sc07_…` (they call `merge_bidir_with_rules`); `CompareDialog.test.tsx` +2 (PASS) |
| SC-01 | `a3a271c` be/core | `core/ops.rs` (sync_execute_local journals partial progress then returns the error; new `mirror_file` renames the `.bak` back if the copy failed and the name is free; mirror_dir sorts entries) | un-ignored ops.rs `review_sync_failure_keeps_dst_original_in_place`, `review_sync_failure_journals_partial_progress`; xcheck_opus `sync_cancel_midway_…`; xcheck_sol `sc01_stat_failure_…`, `sc01_cancel_after_first_…` |

## Binding changes (main must run `pnpm gen:bindings`; local gitignored copy was hand-edited)

- `fsMergeBidir(left, right, rules: CompareRules, detectRenames)` → invoke `{ left, right, rules, detectRenames }` (SC-07)
- `ThreeWayStatus` gains `"unreadable"` (SC-05)

## Cargo commands to verify (one combined run)

```
cd src-tauri && export CARGO_BUILD_JOBS=2
cargo test --lib three_way:: review_sync_failure_ sc40_ merge_and_apply ops_paths_tests
cargo test --test review_sync_compare_apply --test review_sync_compare_xcheck_opus --test review_sync_compare_xcheck_sol
cargo test --test review_browse_sc17_sensitive --test mvp3_smoke   # callers of apply/merge/3-way (regression check)
cargo clippy --all-targets -- -D warnings   # known baseline: fs/local.rs:637
```

Risks to watch:
- `matches!` + `{:?}` in the apply.rs SC-16 test.
- `RowApplied` is private, but the ops_paths_tests submodule reaches it through `use super::*`.
- Fixture rename counts in the xcheck_opus cancel test now that sync may rename a `.bak` back.

## SC-06 proposal (text only, not applied)

`LocalFs::list` (`fs/local.rs:~380`) deliberately follows links, so a folder link is reported as `Dir`. Browse relies on this to enter link folders, so `list()` should **not** change.

Minimal fix outside local.rs: in `ops.rs` `mirror_dir` (Dir arm, before mkdir/recursion) and `prune_pass` (before recursing into or trashing a dst Dir), call `dst_fs.symlink_metadata(&d)`:
- if it is `Symlink`, skip recursion. Prune trashes the link itself, never its target.

This needs `LocalFs::symlink_metadata` to be a real lstat. Unverified: the trait default delegates to `metadata`. If LocalFs does not override it, add to `fs/local.rs`:

```rust
async fn symlink_metadata(&self, path: &Path) -> Result<EntryMeta, DuetError> {
    let p = path.to_path_buf();
    tokio::task::spawn_blocking(move || std::fs::symlink_metadata(&p).map(|m| meta_from(&m)))
        .await.map_err(|e| DuetError::Io(e.to_string()))?.map_err(map_io)
}
```

The helper names `meta_from` and `map_io` are placeholders. Check them against the file.

## Unfinished / not done

- No Rust compile or test run (cargo frozen). Everything above is pending the combined run.
- SC-01 same-host rsync partial failure: not changed (report only).
- SC-08 same-host path: no test (needs SSH).
- Parked per lead: SC-02 (D-7), SC-06 (above), SC-10, SC-12, SC-13, SC-14, SC-15, SC-35, archive-browse gating, error strings.
- Paths owner FYI: `ops_paths_tests.rs` probe test changed to expect `RowApplied::SourceMissing`.

## Pause note (2026-11-11)

Paused at HEAD `a3a271c`. No uncommitted code: the only untracked files are the REVIEW/CHECKPOINT reports, plus the gitignored hand-edited `src/types/bindings.ts`. Resume steps are in `CHECKPOINT-sync-opus.md`.

## Round 2 (2026-11-11)

Reviewer verdict (sol R1, `/tmp/duet-ux-smoke-worktrees/sync-sol/REVIEW-sync-round1-review.md`):
- Approved (static): SC-16, SC-08, SC-05, SC-07.
- Changes requested: R1-01 SC-11 late-prefill overwrite → fixed. R1-02 SC-01 same-host → lead decision: local-only accepted; same-host stays OPEN in the backlog, no code change.

| Commit | What |
|---|---|
| `d165503` fe/ui | CompareRulesBar: the late settings prefill skips any field the user already edited (tolerance and ignore text, tracked in refs); regression test |
| `6083f1a` test | Sol's reviewer test ported by hand (the patch conflicted with d165503's test block) + an ignore-only partial-touch case; credits the reviewer |
| `b16b507` be/core | SC-01: mirror_file keeps a failed new file recorded unless the post-failure lstat is a definite NotFound; MockFs test `mirror_file_tests::new_file_copy_failure_with_uncertain_stat_is_recorded` |

Local bindings: `src/types/bindings.ts` (gitignored) already hand-edited. `fsMergeBidir(left, right, rules: CompareRules, detectRenames)` → invoke `{ left, right, rules, detectRenames }`; `ThreeWayStatus` gains `"unreadable"`. Main must regenerate.

FE results (logs in `_report/`):
- `pnpm exec tsc --noEmit` → exit 0 (`_report/r2-tsc.log`)
- `npx vitest run --maxWorkers=1 --minWorkers=1 src/lib/compareRules.test.ts src/lib/threeWayBase.test.ts src/components/dialogs/CompareDialog.test.tsx src/components/dialogs/ThreeWayDialog.test.tsx src/components/dialogs/__review__/sync-compare-compare-flow.test.tsx` → **5 files, 30 tests passed** (`_report/r2-vitest.log`)

Rust: still not compiled. Combined run when the slot is granted (add `--lib mirror_file_tests`):
```
cd src-tauri && export CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/duet-ux-sync-target
cargo test --lib three_way:: review_sync_failure_ sc40_ merge_and_apply ops_paths_tests mirror_file_tests
cargo test --test review_sync_compare_apply --test review_sync_compare_xcheck_opus --test review_sync_compare_xcheck_sol
```

### Round 2 item 4 — sync relay guard (`912bf01`)

- `ensure_sync_supported` holds `sync_plan`'s exact NotSupported text and is used by `sync_plan`, `sync_preview` and `sync_execute`.
- `sync_execute` re-derives the strategy from the current sources (not `plan.strategy`):
  - unsupported → that error
  - mismatch with the plan → "create a new plan"
- The list() lines in `count_files` and the preview walks are untouched (remote team owns them).
- Tests:
  - `sync_relay_guard_tests::{sync_preview_rejects_local_to_remote_relay, sync_execute_rejects_relay_even_when_plan_claims_local}` (the remote mock panics on any I/O).
  - `ops_paths_tests::endpoints_route_planning_and_read_only_operations_to_relay` now expects NotSupported from the relay preview.
- Add to the cargo run: `cargo test --lib sync_relay_guard_tests endpoint`

## Round 3 — `sync_cancel_midway_journals_what_was_already_applied` failure → cancel-recovery contract

**Verdict: (A) the code is correct. The test's trigger point moved, because the copy order is now fixed.**

Trace (read only):
- `mirror_dir` now sorts entries (a3a271c), so the order is `a_new.txt`, `b_changed.txt`, `c_later.txt`.
- Every file copy ends with `finalize_part` → `dst_fs.rename(<name>.duet-part → <name>)` (`fs/mod.rs:~608`, native and stream paths alike). The fixture counts **every** dst rename, not only backups.
- So rename #1 is the finalize of `a_new.txt`, not b's backup. The token is cancelled there.
- The `a_new` copy still finishes (`copy_relay` uses its own token), and a3a271c/b16b507 record it in `created`.
- On the next loop iteration, before b, `mirror_dir` sees the cancel and returns `Cancelled`. b is never touched: content `old`, no `.bak`. c is not created. `sync_execute_local` journals `created=[a_new]`, so Ctrl+Z can remove it.

For the user this is right: one finished new file, journaled and undoable; nothing displaced. The test's comment ("1st rename = b's backup") and its b assertions came from the old unsorted listing order, where the test had already been ignored.

Planned change (test only, `tests/review_sync_compare_xcheck_opus.rs`):
1. `cancel_on_nth_rename = Some((2, tok))`, with a comment: entries are processed in name order; rename #1 = a_new's `.duet-part` finalize, #2 = b's backup. This keeps the test's original scenario (cancel right after b's backup), which is the riskier one.
   - Expected with current code: b's copy completes (NEW-content), the backup is recorded, then `Cancelled` before c.
   - So the existing assertions hold: b == NEW-content, `.bak` present, not both a and c, journal non-empty.
2. Tighten: assert `a_new.txt` exists, `c_later.txt` does not, and the journal entry's `UndoSync` holds `created=[…a_new.txt]` and one backup for b.
3. No product code change. (The cancel-after-first-new-file case is already covered by xcheck_sol `sc01_cancel_after_first_completed_file_keeps_journal`.)

Also for the rerun: lib filters must go after `--`, for example
`cargo test --lib -- three_way:: review_sync_failure_ sc40_ merge_and_apply ops_paths_tests mirror_file_tests sync_relay_guard_tests`

### Round 3 result (`84b5845`, test only)

Contract for local sync cancel or failure:
1. Each file is either the untouched original, or complete new content with its original kept as a journaled `.bak`. Never a half state.
2. Everything the run changed is in ONE journal entry: created files with stamps, plus `backups_to_restore`. Nothing unchanged is in it.
3. No `.bak` is left that the journal doesn't know about.
4. Undo of that entry returns dst to the exact pre-sync state (names + bytes).

Tests in `tests/review_sync_compare_xcheck_opus.rs`. Undo runs through `tests/support/undo_fixture.rs::undo_tmp`, which uses a temp-folder trash and never the OS Trash.
- `sync_cancel_midway_journals_what_was_already_applied`: cancel at rename #1, a_new's finalize.
  - (1) a = `fresh`, b = `old`, c absent.
  - (3) no `.bak`.
  - (2) one entry, `created=[a_new]` with stamps, no backups.
  - (4) undo → snapshot.
- `sync_cancel_right_after_backup_rename_keeps_contract`: cancel at rename #2, b's backup, which is the riskiest point.
  - Accepts only the two contract states for b, and pins the one the code takes: b fully `NEW-content` plus one journaled `.bak` holding `old`.
  - The single `.bak` on disk equals the journaled `backup_path` (no orphan).
  - `created=[a_new]`, c absent.
  - (4) undo → snapshot.

No product code change was needed: the reading predicted that the code already satisfies the contract at both points. To be confirmed in the cargo slot:
```
cd src-tauri && cargo test --test review_sync_compare_xcheck_opus -- sync_cancel_
```
