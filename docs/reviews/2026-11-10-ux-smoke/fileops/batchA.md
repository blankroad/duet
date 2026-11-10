# fileops batch A (FE only): ux-fileops-opus

Branch `ux-smoke/fileops-opus`, base `76b9b6e`. All tests below are **mocked FE tests**: Tauri commands are mocked, so none of this was run in the live app. No cargo was run and no bindings were regenerated; `bindings.ts` was copied from fileops-sol at the same base.

## Commits

| Commit | Item | Summary |
| --- | --- | --- |
| `86dddea` | A1 (fileops-24) | Cut clipboard is consumed only when the move task is accepted. Snapshot id flows through the move-confirm dialog, `executeTransfer` and the per-file groups. Newer Ctrl+C/X is never cleared by an older paste. Double-clicking confirm on the same plan enqueues once. |
| `e300302` | A2 (UX-FOP-01/02, ux-fileops-05/06) | Recycle Bin view: Ctrl+C, Ctrl+X, F2 and batch rename are refused. `planTransferTo` refuses a bin source or destination, which covers drag, sidebar drop, shelf and paste. OS-file drop onto the bin is refused. Toolbar Copy/Move are disabled when either pane is the bin. Delete with nothing selected shows a toast (new key `toast.deleteNothingSelected`, ko/en). Research fop01/fop02 are adopted as regression tests. |
| `756c9fe` | A3 (ux-fileops-01) | A move whose items are all already in the destination is refused with the "already in this folder" toast (F6, shelf, sidebar drop). A copy into the same folder still opens the dialog but preselects **Keep both** when every conflict is the item itself. Move dialogs are unchanged, the default setting is unchanged, and the preselect is not stored as the remembered session choice. |
| `d4874f4` | A1 review round 1 | Fixes R1-01 and R1-02 (see "Review round 1"). |
| `bc0561e` | test relabel | ux-fileops-03/04 → **UX-SHL-11/12**, still `it.fails` (shell owns them). |

Earlier commit `6371b88` is the inventory smoke test.

## What changed, by file

- `src/stores/clipboard.ts`:
  - `ClipEntry.id` is a snapshot id.
  - `consume(id, moved)` removes only matching targets; it is a no-op if the id is stale or the clipboard is in copy mode.
- `src/lib/fileActions.ts`:
  - Cut-clipboard lifecycle:
    - `executeTransfer(..., clip?)` returns whether the task was accepted.
    - `claimPlan`/`releasePlan` prevent submitting the same plan twice.
    - `consumeCutClipboard` and `itemsActedOn` decide what to consume.
    - Reservation: `reserveCut`/`releaseCut` (private) and `beginCutSubmit`/`endCutSubmit` (exported).
    - A `useUIDialogs` subscription releases the reservation when a move-confirm dialog closes without submitting.
  - `planTransferTo(..., opts)`:
    - returns `"dialog" | "done"`;
    - refuses the bin as source or destination;
    - refuses a move into the folder the items are already in.
  - Bin guards in `clipCopy`, `clipCut`, `triggerRename` and `triggerBatchRename`.
  - Toast for Delete with nothing selected.
  - `resolveActiveTargets` is unchanged. `triggerExtract` was not touched.
- `src/App.tsx`:
  - `onMoveConfirm` passes `dialog.clip`.
  - `onTransferPerFile(..., clip)`: claims the plan, hands over the reservation, consumes skip-aware per accepted group, and releases in `finally`.
- `src/stores/ui-dialogs.ts`: `move-confirm` has an optional `clip`.
- `src/lib/planItems.ts`: `selfConflictsOnly(plan)`. It compares folders without regard to separator style and treats the same path on different sources as different.
- `src/components/dialogs/CopyMoveConfirmDialog.tsx`: Keep-both preselect for a same-folder copy.
- `src/components/pane/PaneToolbar.tsx`: `canTransfer`.
- `src/hooks/useOsFileDrop.ts`: bin guard.
- `src/i18n/{ko,en}.json`: `toast.deleteNothingSelected`.

`commands.ts` (keymap) is untouched; the shortcut gaps are handed to shell.

## Repros flipped to normal tests

- `src/lib/__review__/fileops-opus-clippaste.test.ts`: both fileops-24 cases.
- `src/lib/__smoke__/fileops-opus-ux.test.ts`: ux-fileops-01, ux-fileops-05, ux-fileops-06 ×4.
- Remaining `it.fails`:
  - UX-SHL-11 ×4 and UX-SHL-12 (shell).
  - ux-fileops-02 ×3 (rename "already exists" text; batch B).

## Review round 1 (A1 → `d4874f4`)

- **R1-01 (global Skip on a mixed plan)**: consumption now uses `itemsActedOn(plan, policy)`, so with Skip the plan's conflicts stay in the clipboard. Per-file groups use the same rule on each re-planned group, so a new conflict that appears on re-plan in a Skip group is not consumed either.
  - Test: 2 items, 1 conflict, global Skip → the conflicting item remains and the other is consumed.
- **R1-02 (two quick Ctrl+V)**: the cut snapshot is reserved from the start of the paste until one of these happens:
  - the plan errors or finishes without a dialog;
  - the move-confirm dialog closes without submitting (cancel, Esc, or replaced);
  - the enqueue is accepted or rejected.

  The copy clipboard is not reserved. `executeTransfer` and the per-file path hand the reservation over before closing the dialog, so the close does not release it.
  - Tests use deferred IPC and a fresh plan object per call:
    - two pastes while the execute is pending → 1 plan, 1 execute;
    - two pastes while planning → 1 plan;
    - dialog open → second paste ignored; Esc → paste again works;
    - confirm pending → ignored; rejected → paste again works;
    - plan error → paste again works;
    - copy clipboard → both pastes proceed.
- **Mutation checks**: removing the reservation fails 4 tests; ignoring Skip fails 1 test. Source restored and verified with `git diff --stat`.
- **Documented limit (unchanged)**: consumption happens on acceptance, not completion. If an accepted task later fails or is cancelled, the clipboard is not restored, so already-moved items are not retried. The backend's partial journaling is unchanged.
- **Not exercised**: an actual App render of the per-file dialog and its groups. The tests call the same functions App calls.

## Not done or deferred

- **Drag-copy into the same folder** stays a no-op, as before. In-app drag doesn't highlight or act on the source folder (DESIGN.md "원래 폴더·자기 자신 위에선 드롭 강조를 하지 않는다"). An OS drag back into the same folder shows "already in this folder". The lead's A3 brief mentioned drag-copy, but I didn't change the documented drag rule. Flagging it for a decision.
- **Second Ctrl+V while a cut paste is in flight** is ignored silently. This is mostly unreachable while the confirm dialog is open, because modal dialogs block global shortcuts.
- **Windows device** not run. The bin guards are verified only against the virtual path in mocked tests.

## Exact commands and results

Each run was one Vitest process with `--minWorkers=1 --maxWorkers=1`. The pre-review runs used the same focused files.

1. Batch A focused set after the review fix:

   ```
   pnpm exec vitest run --minWorkers=1 --maxWorkers=1 src/lib/__smoke__/ \
     src/components/__smoke__/fileops-opus-self-copy.test.tsx \
     src/components/pane/__smoke__/fileops-fop01-trash-toolbar.test.tsx \
     src/lib/__review__/fileops-opus-clippaste.test.ts src/lib/entryMenu.test.tsx \
     src/lib/fileActions.errors.test.ts src/components/dialogs/CopyMoveConfirmDialog.test.tsx \
     src/components/pane/PaneToolbar.test.tsx src/stores/clipboard.test.ts src/hooks/useCutNames.test.ts
   ```

   **Exit 0: 11 files, 116 passed.** Before the review fix: 109 passed.
2. `pnpm exec vitest run --minWorkers=1 --maxWorkers=1 src/lib/__review__/fileops-opus-clippaste.test.ts`: **20 passed**.
3. Relabel check: `pnpm exec vitest run --minWorkers=1 --maxWorkers=1 src/lib/__smoke__/fileops-opus-ux.test.ts`: **36 passed** (`it.fails` cases count as passing).
4. `pnpm exec tsc --noEmit`: **exit 0**, run once after A3 and once after the review fix.
5. `pnpm exec eslint <changed .ts/.tsx>`: exit 0, no output.
6. `pnpm exec prettier --check <changed files incl. i18n json>`: "All matched files use Prettier code style!"

## Batch B: cargo still pending

The Rust smoke file `src-tauri/tests/ux_smoke_fileops_opus.rs` is still uncommitted and has not been compiled. I will run these commands when you grant the slot:

```
CARGO_BUILD_JOBS=2 cargo test --manifest-path src-tauri/Cargo.toml \
  --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 \
  --test ux_smoke_fileops_opus
# then the same command with `-- --ignored`
CARGO_BUILD_JOBS=2 cargo clippy --manifest-path src-tauri/Cargo.toml --test ux_smoke_fileops_opus -- -D warnings
```
