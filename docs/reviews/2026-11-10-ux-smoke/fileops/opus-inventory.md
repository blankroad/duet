# fileops UX smoke — inventory (ux-fileops-opus, 2026-11-10)

Base `76b9b6e`, worktree `/tmp/duet-ux-smoke-worktrees/fileops-opus`, branch `ux-smoke/fileops-opus`.

Labels used below:

- **mocked FE test**: Vitest, Tauri commands mocked. Not a live-app test.
- **Rust test**: integration test with real `LocalFs` in tempdirs. **Pending cargo slot.** Written, but not compiled or run (the lead's resource rule).
- **static**: code reading only, no run.
- **prior**: issue from the 2026-11-08 review that is still open. Its `#[ignore]`/`it.fails` repro is still in the tree. sol is re-checking these (not repeated here).

## Evidence run

| What | Command | Result |
| --- | --- | --- |
| New mocked FE smoke | `pnpm exec vitest run --minWorkers=1 --maxWorkers=2 src/lib/__smoke__/fileops-opus-ux.test.ts` | **34/34 pass**: 20 baselines pass and 14 `it.fails` repros fail. |
| Repro failure reasons | Ran a temporary copy with `.fails` removed (then deleted it) | All 14 fail on the intended assertion. Messages are quoted in the table. |
| New Rust smoke | `CARGO_BUILD_JOBS=2 cargo test --manifest-path src-tauri/Cargo.toml --test ux_smoke_fileops_opus` | **pending cargo slot** |
| Rust repros | `CARGO_BUILD_JOBS=2 cargo test --manifest-path src-tauri/Cargo.toml --test ux_smoke_fileops_opus -- --ignored` | **pending cargo slot**. 3 repros are expected to fail. |
| Rust lint for the new file | `CARGO_BUILD_JOBS=2 cargo clippy --manifest-path src-tauri/Cargo.toml --test ux_smoke_fileops_opus -- -D warnings` | **pending cargo slot** |

Setup notes:

- `bindings.ts` is gitignored. I copied it from `/tmp/duet-ux-smoke-worktrees/fileops-sol/src/types/bindings.ts` (same base, no backend diff). Its sha1 `c4526f1c…` matches archive-sol.
- `pnpm gen:bindings` was not run to completion: the first run got SIGINT from main and I stopped the second.
- No bindings change is needed for the tests.

## Cargo needed

1. `CARGO_BUILD_JOBS=2 cargo test --manifest-path src-tauri/Cargo.toml --test ux_smoke_fileops_opus`. Expect 10 pass.
2. `CARGO_BUILD_JOBS=2 cargo test --manifest-path src-tauri/Cargo.toml --test ux_smoke_fileops_opus -- --ignored`. Expect 3 fail:
   - `same_folder_copy_replace_is_not_reported_as_failure`
   - `same_folder_move_keep_both_does_not_rename_original`
   - `rename_onto_existing_name_reports_already_exists_kind`
3. `CARGO_BUILD_JOBS=2 cargo clippy --manifest-path src-tauri/Cargo.toml --test ux_smoke_fileops_opus -- -D warnings`

The Rust test file stays **uncommitted** until (1) compiles, so the branch never gets a red commit.

## Entry points (where each action lives)

| Action | Context menu (`entryMenu.tsx`) | Empty-area menu | Toolbar (`PaneToolbar`/`TopBar`) | Default key (`commands.ts`) | Palette | Drag/drop |
| --- | --- | --- | --- | --- | --- | --- |
| Copy to other pane | ✓ | – | ✓ | F5 | ✓ | in-app drag (remote, or local+none = OS drag) |
| Move to other pane | ✓ | – | ✓ | F6 | ✓ | in-app drag + Ctrl/Shift/⌘ |
| Clipboard copy/cut/paste | ✓ (folder: "paste into") | paste | – | Ctrl+C/X/V | ✓ | – |
| Rename (single → inline, multi → batch dialog) | ✓ | – | – | F2 | ✓ | – |
| Delete to trash | ✓ | – | ✓ | Delete | ✓ | – |
| Delete permanently (setting on only) | ✓ | – | – | Shift+Delete | ✓ | – |
| New folder / new file | ✓ (folder: "inside") | ✓ | ✓ (off in Recycle Bin) | F7 / Shift+F4 | ✓ | – |
| New symlink (unix/remote) | – | ✓ | – | – | **none** | – |
| Undo / redo | – | – | TopBar undo + History | Ctrl+Z / Ctrl+Shift+Z | ✓ | – |
| History | – | – | TopBar | none | ✓ | – |
| Shelf add / apply copy·move | ✓ (add) | – | sidebar shelf | Ctrl+Shift+A (add) | ✓ | – |
| Import from OS (Finder/Explorer) | – | – | – | – | – | `useOsFileDrop` (always copy + always confirm) |
| Task progress / cancel | – | – | TasksBar, ProgressModal | Esc in modal | – | – |

## Status matrix

Selection: N = none (cursor on ".."), S = single, M = multi, X = mixed (file + folder).
Context: L = local, R = remote SSH, A = archive-browse temp folder, T = Windows Recycle Bin view.

| # | Action × entry | Selection | Context | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | F2/F5/F6/F7/Shift+F4/Delete/Shift+Delete/Ctrl+C/X/V/Z/Shift+Z resolve to the right command | – | L (Windows key set) | OK | mocked FE `fileops shortcuts …` 12 `it.each` pass |
| 2 | Shift+Delete with permanent delete off | – | – | OK (unbound, §3) | mocked FE pass |
| 3 | **F8 / Shift+F8 / Ctrl+Shift+N / Shift+F6** (listed in DESIGN.md "File ops (TC 호환)") | – | all | **missing** | mocked FE `ux-fileops-03` ×4: `expected undefined to be 'file.delete'` (etc.) |
| 4 | **⌘⌫ to trash on macOS** (Finder convention; Mac has no forward-Delete key without fn) | S/M | L/R mac | **missing** | mocked FE `ux-fileops-04`: `expected undefined to be 'file.delete'` |
| 5 | F5/F6/Ctrl+C/Ctrl+X with nothing selected | N | L | OK (toast) | mocked FE pass (3 toasts, no plan call) |
| 6 | F2 with nothing selected / with multi | N/M | L | OK (toast "select one"; F2 in the palette goes to batch rename for M) | mocked FE pass |
| 7 | **Delete with nothing selected** | N | all | **broken (silent)**: no toast, unlike F5/F6/Ctrl+C | mocked FE `ux-fileops-05`: `expected "spy" to be called 1 times, but got 0 times` |
| 8 | Delete multi selection | M/X | L | OK (each item planned once) | mocked FE pass |
| 9 | Context menu for M: batch rename, delete, copy/move, clipboard; no Open | M | L/R | OK | existing `entryMenu.test.tsx` (not re-run) |
| 10 | **F6 when both panes show the same folder** | S/M | L/R | **broken UX**: plans a move onto itself → confirm dialog "a.txt conflicts with a.txt". Cut→paste into the same folder is already blocked with "already in this folder", and so is drag. | mocked FE `ux-fileops-01`: `expected ['fsMovePlan', …] to be undefined` |
| 11 | F5 / Ctrl+C→Ctrl+V into the same folder | S/M | L/R | **UX gap**: plan lists every item as conflicting with itself. Default policy is Skip (`settings.rs:24`), so Enter does nothing. Only Keep both makes an Explorer-style duplicate. | Rust (pending) `same_folder_copy_plan_lists_item_as_conflict_with_itself`, `…keep_both_makes_numbered_duplicate`, `…skip_changes_nothing` |
| 12 | Replace onto itself (copy, file and folder) | S | L | **pending**. Static reading of `ops.rs:~670`: it moves the dst (= src) to a backup, then copies from a missing src, then rolls back. Expected outcome is "data kept, but an error toast after the user confirmed". | Rust (pending) `same_folder_copy_replace_file_keeps_original`, `…dir_keeps_contents` (safety baseline); repro `same_folder_copy_replace_is_not_reported_as_failure` |
| 13 | Move onto itself, any policy | S | L | **pending**. KeepBoth likely renames the original to `a (1).txt`. | Rust (pending) `same_folder_move_any_policy_keeps_original` (safety); repro `same_folder_move_keep_both_does_not_rename_original` |
| 14 | **Inline rename onto an existing name** (F2 → Enter) | S | L/R | **broken text**: toast "이름 변경 실패: 입출력 오류 — target exists: …". `InlineRenameInput.tsx:110-129` does not pre-check sibling names, and `ops.rs:3428` returns `Io("target exists")`, which `error.ts` patterns don't match. Same text for case-only rename on macOS (prior fileops-08). | mocked FE `ux-fileops-02`: `expected '입출력 오류 — target exists: /w/b.txt' not to match /target exists/i`; Rust (pending) `rename_onto_existing_name_is_refused_and_keeps_both` (safety) + repro `…reports_already_exists_kind` |
| 15 | Batch rename collision / "nothing to rename" text | M | L/R | English when reached, but the dialog disables Apply on collision or no change (`BatchRenameDialog.tsx:117,157`), so it is reachable only by a race. Low. | mocked FE `ux-fileops-02` ×2: `'입출력 오류 — batch rename: name collision…'`; Rust (pending) `batch_rename_internal_collision_changes_nothing` |
| 16 | New folder with an existing name | – | L | expected OK (refused, contents kept) | Rust (pending) `mkdir_existing_name_is_refused` |
| 17 | Multi copy with mixed conflicts + KeepBoth | X | L | expected OK | Rust (pending) `multi_copy_mixed_conflicts_keep_both` |
| 18 | Items from two sources in one plan (shelf/clipboard) | X | L+R | expected OK (refused). The FE splits shelf groups (`applyShelfTo`). | Rust (pending) `plan_refuses_items_from_different_sources` |
| 19 | F5/F6 out of the Recycle Bin view | S | T | OK ("put back only") | mocked FE pass |
| 20 | **Ctrl+C / Ctrl+X in the Recycle Bin view** | S/M | T | **broken**: accepted; the next Ctrl+V plans copy/move from the virtual path `shell:RecycleBinFolder` | mocked FE `ux-fileops-06` ×2: `expected { targets…, mode: 'move' } to be null` |
| 21 | **F2 in the Recycle Bin view** | S | T | **broken**: starts an inline rename on a virtual entry; `fsRename` gets a virtual path | mocked FE `ux-fileops-06`: `spy … called 1 times` |
| 22 | **Drag/drop onto a Recycle Bin pane** (in-app drag, sidebar drop) | S/M | L→T | **broken (static + FE helper)**: `useEntryDrag` → `planTransferTo` has no bin guard; only the triggers check. `useOsFileDrop` likewise. | mocked FE `ux-fileops-06` (planTransferTo): `expected ['fsCopyPlan', …] to be undefined`. Windows device unverified. |
| 23 | Cut → paste: cancel or plan failure empties the clipboard | S/M | all | **prior fileops-24, still open** | `src/lib/__review__/fileops-opus-clippaste.test.ts` `it.fails` still present |
| 24 | Task cancel shows "cancelled" while the task keeps running; same-host rsync can't be cancelled | – | L/R | **prior fileops-16, still open** | `src/hooks/__review__/fileops-opus-taskcancel.test.ts` `it.fails` |
| 25 | Cancel or disk full leaves `.duet-part` files | – | L/R | **prior fileops-18, still open** | `ops.rs` `#[ignore = "fileops-18 repro"]` ×2 |
| 26 | Ctrl+Z while a copy/move task is running | – | all | **static hypothesis**: `commands/undo.rs` has no running-task check, and the running op is journaled only when it finishes. Ctrl+Z silently undoes the *previous* operation. | static |
| 27 | Ops inside an archive-browse temp folder (delete/rename/new/copy-in) | S/M | A | **static hypothesis, owner: archive**. They work on the temp copy, are journaled with temp paths, and have no "edits apply on Update archive" hint. After the temp root is reaped, the Ctrl+Z entries go stale. The context menu (`buildEntryMenu`) does not know about the archive context. | static (`panes.ts:26`, `archive.rs:789-830`) |
| 28 | OS-file import ignores the `confirm_transfer` setting (always opens the confirm dialog) | S/M | L/R | inconsistency (low) | static `useOsFileDrop.ts:54` |
| 29 | New symlink has no palette command or key | – | L unix/R | missing (low, shell/keymap scope) | static `commands.ts` |
| 30 | Remote: OS drag-out not possible (in-app drag only); Ctrl+C leaves the OS clipboard with the previous local file | S/M | R | by design / **prior fileops-36** | static |

## Candidate fixes (ranked, evidence-backed first)

1. **ux-fileops-01: F5/F6 into the same folder.** Rows 10–13. FE: F6 with `sameLocation(src, dst)` should toast "already in this folder" (the same rule as cut-paste and drag).
   - F5 / Ctrl+V into the same folder: either preselect Keep both when every conflict is the item itself, or skip the dialog and duplicate (Explorer "- Copy"). This is a product decision; ask main.
   - BE: treat Replace onto itself as a no-op (or refuse at plan time with `IntoItself`-like reason). Do it once the cargo slot confirms rows 12–13.
   - Evidence: mocked FE repro. Rust pending.
   - Size S (FE) / S–M (BE).
2. **ux-fileops-02: rename collision text.** Row 14.
   - Return a structured "already exists" (`DuetError::AlreadyExists` or an `Io` message matching `/already exists/`) from `ops::rename`.
   - Optionally pre-check sibling names in `InlineRenameInput` (the FE list is already in `tab.entries`).
   - Evidence: mocked FE repro of the toast text. Rust pending.
   - Size S. Coordinate the error contract with main/errors if it is a new kind.
3. **ux-fileops-06: Recycle Bin view guards (Windows).** Rows 20–22.
   - Add `isVirtualTrash` checks to `clipCopy`, `clipCut`, `triggerRename`, and `planTransferTo` (destination). The `planTransferTo` check covers drag, sidebar drop, shelf, and paste.
   - Evidence: mocked FE repros ×4. Windows device unverified.
   - Size S.
4. **ux-fileops-05: Delete with nothing selected is silent.** Row 7. Add a toast like the copy/move one. Evidence: mocked FE repro. Size S.
5. **ux-fileops-03/04: missing shortcuts vs DESIGN.md.** Rows 3–4.
   - Add `altKeys` F8 / Shift+F8 / Ctrl+Shift+N / Shift+F6.
   - On macOS add ⌘⌫ for delete (and ⌘⌥⌫ for permanent?).
   - Or update DESIGN.md if these were dropped on purpose.
   - Evidence: mocked FE repros ×5. Size S.
   - Touches `commands.ts`, which the **shell lead** owns (keymap). Coordinate.
6. Prior open items in fileops scope, for the lead to schedule (sol has their current state): fileops-24 (cut clipboard), fileops-16 (cancel), fileops-18 (`.duet-part`).
7. Static hypotheses, not fixed without a repro:
   - row 26: Ctrl+Z during a running task. Needs an AppHandle-less harness or a live app.
   - row 27: archive-browse journal entries. Owner archive.
   - row 28: OS import confirm setting.

## Files

- `src/lib/__smoke__/fileops-opus-ux.test.ts`: mocked FE test, committed `6371b88`.
- `src-tauri/tests/ux_smoke_fileops_opus.rs`: Rust test, **uncommitted, pending cargo slot**.
