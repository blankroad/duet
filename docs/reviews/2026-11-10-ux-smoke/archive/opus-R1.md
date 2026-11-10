# archive R1 + R1b — ux-archive-opus report

Branch `ux-smoke/archive-opus` (worktree `/tmp/duet-ux-smoke-worktrees/archive-opus`), base `76b9b6e`, HEAD `f027487`.
Specs: SPEC-R1 (§3, §6, §7, §8, Addendum A) + SPEC-R1b (supersedes R1 §1, §2, §4, §5). Main review fixes and Sol static review (#1–#3) included.
WIP commits `225ceeb` / `cd072c2` were squashed into the clean FE commits below (my branch only).

## Commits (in order)

| hash | scope | what |
| --- | --- | --- |
| `9b661ac` | be/core | Extract-here engine `core/archive_here.rs` (staging → placement with name reservation, merge, KeepBoth/Replace/Skip, protected sources, one journal entry, staging cleanup via trash) + `core/archive_names.rs` (numbered names, `try_reserve`, `reserve_free`) + archive.rs refactor (`check_extractable`, `extract_local` pub(crate), single-file explicit output name) |
| `eba92c6` | be/core | `core/archive_batch.rs` (each-to-folder batch plan, intra-batch `a (2)`, case-insensitive) + `ExtractPlan.keep_both` → `extract_execute` reserves the dest at execute time (TOCTOU fix) |
| `ce08b80` | be/core | `check_extract_here` pre-check |
| `377ab7e` | be/cmd | `fs_extract_plan_batch`, `fs_extract_here`, `fs_extract_here_retry`, `ExtractHereNoticeEvent` |
| `0c18851` | be/core | Main's review: `protected_sources()` (BE re-validates the batch), pre-rename placeholder re-check, honest guarantee docs (corrects 9b661ac's "atomic" wording), tests incl. full-undo merge into an existing user folder |
| `d5c8309` | be/cmd | Password retry carries the original `batch`, so protection survives the retry |
| `c1fa09c` | test | clippy `needless_range_loop` fix (lead's clippy run at d5c8309) |
| `62b163f` | fe/ui | Menu items, `extractActions.ts`, `extractNotices.ts`, `extractPending.ts` FIFO + retry, both dialogs, App extract blocks, task/notice hooks, i18n, `fileActions.ts` deletion-only hunk |
| `e722df3` | test | Vitest: menu, actions, password FIFO, notices, dialogs |
| `d9f5f84` | be/core | Sol #1/#2/#3: journal-failure rollback via `core::undo::undo_cleanup`, `HereOutcome { result, summary }` (summary kept on error), cleanup only treats NotFound as gone, wording fix; tests |
| `6bb4bef` | be/cmd | Task uses `HereOutcome` + `PoolFs` rollback resolver; emits the notice also on failure |
| `905bc2f` | test | Fix E0382 use-after-move in `leftover_staging_is_reported_in_the_summary_even_on_error` (lead's cargo at d37f5be) |
| `d37f5be` | fe/ui | **Addendum A** — palette `file.extract` / `file.compress` (no default key, after `file.calcSize`), deps in App, `cmd.file.extract`/`cmd.file.compress` en+ko before `cmd.file.calcSize`, menu `commandId`s, tests |

## Files

- New BE: `src-tauri/src/core/archive_here.rs`, `archive_here_tests.rs`, `archive_names.rs`, `archive_batch.rs`, `archive_batch_tests.rs`.
- Changed BE: `core/archive.rs`, `core/mod.rs`, `commands/fs_ops.rs`, `services/archive_events.rs`, `lib.rs`. No edits to `core/ops.rs`, `core/undo.rs`, `fs/local.rs`.
- New FE: `src/lib/extractActions.ts`, `extractNotices.ts`, `components/dialogs/ExtractHereDialog.tsx`, `ExtractConflictDialog.tsx`, tests `src/lib/extractActions.test.ts`, `src/components/dialogs/ExtractDialogs.test.tsx`, `src/lib/commands.extract.test.ts`.
- Changed FE: `src/lib/extractPending.ts`, `entryMenu.tsx` (extract/compress items + imports only), `fileActions.ts` (deletion only: old `triggerExtract` + `rememberExtract` import, 31 lines removed, 0 added), `stores/ui-dialogs.ts`, `hooks/useTaskEvents.ts`, `hooks/useArchiveNoticeEvents.ts`, `lib/commands.ts`, `App.tsx` (hunks: imports, 2 deps lines at ~L1182, extract dialog blocks at ~L2261; nothing in L758–830), `i18n/en.json`, `i18n/ko.json`.

## Tests run (exact commands, results)

- `pnpm exec tsc --noEmit` → exit 0. Run with the lead's real `gen:bindings` output from `d5c8309`. No IPC type or command changed after `d5c8309`, so no regeneration needed.
- `pnpm exec eslint <touched FE files>` → exit 0; `pnpm exec prettier --check <touched FE files + i18n>` → clean.
- `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/extractActions.test.ts src/components/dialogs/ExtractDialogs.test.tsx` → 24 passed.
- `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/commands.extract.test.ts src/lib/extractActions.test.ts src/lib/commands.mac.test.ts src/lib/commands.win.test.ts src/stores/keymap.test.ts src/lib/entryMenu.test.tsx` → 6 files, 44 passed.
- Cargo (lead-run): at `9b661ac` engine 16/16; at `d5c8309` `core::archive` 118 passed / 0 failed / 22 ignored, clippy one finding → fixed in `c1fa09c`. **Not yet run:** `d9f5f84` / `6bb4bef` (new tests: `journal_failure_rolls_the_extraction_back`, `failed_rollback_names_backups_and_items_left_in_place`, `leftover_staging_is_reported_in_the_summary_even_on_error`; all archive_here tests moved to the new API).
- Research acceptance Part A (copied as `src/lib/__review__/research-primary-repro.test.tsx`, run single-worker, then removed — not committed): both A tests stop with `INCONCLUSIVE-harness: real archive dialog confirmation adapter pending archive commit`. That is the harness waiting for this commit, not a product failure.

## Cargo needed (lead; from `src-tauri/`, at `f027487` — see R3 section)

1. `CARGO_BUILD_JOBS=2 cargo test --lib -- core::archive`
2. `cargo clippy --lib --tests -- -D warnings`
3. No `gen:bindings` needed (no IPC change since `d5c8309`).

## Info for research acceptance test

- (a) Menu ids: `extract-here` (listed first; local only) and `extract` (to folder / each to its own folder (k); `commandId: "file.extract"`).
- (b) IPC: extract here = `commands.fsExtractHere(archives, policy)` (`fs_extract_here`), retry `fsExtractHereRetry(archive, policy, password, batch)`. To folder = `commands.fsExtractPlanBatch(archives, keepBoth)` (`fs_extract_plan_batch`, returns `ExtractPlanItem[]` — **an array**, not a single plan), then `fsExtractExecute(plan, null)` per item. The matcher `/extract.*plan|plan.*extract/` matches `fsExtractPlanBatch` but not `fsExtractHere`.
- (c) Confirming the dialog: `onSelect` of `extract-here` opens `{kind: "extract-here", archives}` in `useUIDialogs`. The test can (1) read `useUIDialogs.getState().dialog.archives` (exactly the list that will be sent), then (2) call `runExtractHere(archives, "keep_both", toast)` from `@/lib/extractActions` (what the dialog's Extract button does), or render `ExtractHereDialog` and click its "Extract" button. For `extract`, the mocked `fsExtractPlanBatch` must return `{status:"ok", data: ExtractPlanItem[]}`.

## Deviations from spec (deliberate)

- All new commands return `Result<…, DuetError>` for binding consistency; per-item problems are reported inside the list, not as a whole-call Err. `fs_extract_here_retry` takes an extra `batch: Vec<EntryRef>` (main fix #1).
- Engine API: `extract_here_execute(fs, HereRequest{archive, policy, password, protect}, ctx, rollback: &dyn FsResolver, cancel) -> HereOutcome { result, summary }` (refines the proposed signature; needed for Sol #1/#2 without exceeding clippy's arg limit).
- Remote extract-here is also refused in the BE (`NotSupported`), not only hidden in the menu.
- Each-to-folder: `ExtractPlan.keep_both` (serde default false). The batch planner sets `keep_both = !conflict`, so every item the user did not explicitly choose to replace reserves its name at execute time. Batch name comparison is case-insensitive (conservative).
- Password FIFO: the next prompt opens via a `useUIDialogs` subscription in `extractPending.ts`, so the App close path needed no extra code. The App extract-password block only switched to `retryExtract`.
- New dialog blocks (`extract-conflict`, `extract-here`) are rendered directly beside the extract-password block in App.tsx, plus their imports and two builtin-deps lines (Addendum A). App.tsx needed no other changes.
- To-folder menu id kept as `extract` (not `extract-folders`), so existing menu tests stay valid. Palette `file.extract` = extract to folder(s), matching that item. Extract here has no palette command, because it isn't in the shell contract.

## Known limits

- **Race scope (documented in `archive_here.rs`):** KeepBoth/Skip never replace an item that existed when the name was reserved. Cooperating duet tasks are serialized by `TaskQueue`. External writers after reservation are best effort only: the gap between the placeholder check and the rename, children moved into a freshly made folder, and an ancestor swapped for a link. The pre-rename check only sees "a zero-byte regular file still occupies the path" and makes no ownership claim.
- **Journal failure:** rolled back in place via the undo executor. It is not write-ahead, so a crash before the journal write is not covered. Write-ahead is cross-cutting backlog.
- When a task fails after a partial journal push, the FE journal store gets no push event until the next push (same as copy). BE `undo_last` still finds the entry.
- Each-to-folder Replace path: `extract_execute`'s existing rollback uses `fs.remove` on its own dest (pre-existing code, unchanged). Something appearing in the tiny window between backup and mkdir could be caught by it. KeepBoth items now avoid this path entirely.
- Cancellation: `extract_local` isn't cancellable mid-unpack, and fresh-folder fill doesn't check cancel per child.
- No preflight conflict listing for extract-here (the dialog always asks). Windows: renaming a staged symlink over the placeholder is unverified (no device).
- Batch notices assume the notice event arrives before the task's completion event. If it doesn't, that archive's notice shows on its own (nothing is lost).
- SPEC-R1 "Not in R1" items stand: smart extract-here, password reuse across archives, cancel/rollback of a running extract (G-09).

## R3 — Sol R2 fixes (sol-review-here-R2.md)

| hash | scope | fix |
| --- | --- | --- |
| `ccf8029` | be/core | **#1 P1** Each-to-folder planning seeds the batch's claimed names with every selected source archive. An output named like a selected source (`a.zip.gz` → `a.zip` next to selected `a.zip`) gets a numbered keep-both name (`a (2).zip`), never a Replace conflict. keep_both items only reserve fresh names on execute and on password re-execution, so nothing is backed up. Test `output_named_like_a_selected_source_never_replaces_it` (both selection orders, Replace chosen): both sources byte-identical, outputs distinct, no `.bak`; re-running the same plan goes to `a (3).zip`. |
| `771b53b` | be/core | **#3 P2** Rollback verification: only NotFound counts as gone/restored. Other lookup errors go to a "could not check" list and the message says it "could not confirm" the rollback, never "rolled back". `undo_cleanup`'s own kind and message are included whenever the rollback isn't fully confirmed. Test `rollback_check_errors_are_reported_as_unknown_not_restored` (trash fails, then lstat → PermissionDenied). The existing partial-rollback test now asserts the new wording. |
| `f027487` | fe/ui | **#2 P1** Each extract-password prompt has a unique `promptId` (also for same-name archives). The new `ExtractPasswordPrompt` is rendered with `key={promptId}`, so state (pw/error/busy) is reset on every transition and on cancel. `closeExtractPrompt(promptId)` closes only that prompt, so A's late submit can't close or answer B. `PasswordPromptDialog` is unchanged. Rendered test `ExtractPasswordPrompt.test.tsx`: type in A + Cancel → B empty, no wrong-password state; A's retry resolving after cancel leaves B open, and A's password went only to A's plan. |

R3 runs (once each):
- `pnpm exec tsc --noEmit` → exit 0 (lead's real bindings from `d5c8309`). `promptId` is FE-only (DialogState); no IPC change, so no `gen:bindings` needed.
- `pnpm exec eslint` on the 5 touched FE files → exit 0; prettier applied.
- `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/components/dialogs/ExtractPasswordPrompt.test.tsx src/lib/extractActions.test.ts` → 2 files, 22 passed.
- Rust: **not run** (cargo is the lead's). New/changed tests: `core::archive_batch::tests::output_named_like_a_selected_source_never_replaces_it`, `core::archive_here::tests::rollback_check_errors_are_reported_as_unknown_not_restored`, `core::archive_here::tests::failed_rollback_names_backups_and_items_left_in_place` (wording assertion).

Cargo needed at `f027487` (from `src-tauri/`):
1. `CARGO_BUILD_JOBS=2 cargo test --lib -- core::archive` (covers archive, archive_batch, archive_here, archive_names)
2. `cargo clippy --lib --tests -- -D warnings`

R3 notes / limits:
- Source protection in each-to-folder is decided at planning time from the selected batch. `extract_execute` itself has no sibling list, but every protected item is keep_both, and keep_both execution never backs anything up. A plan built by the single `fs_extract_plan` (not used by the menu any more) keeps the old rule.
- Sol's baseline inversion patch (`_report/sol-baseline-inverted.patch` in Sol's tree) was not applied here (lead applies).
