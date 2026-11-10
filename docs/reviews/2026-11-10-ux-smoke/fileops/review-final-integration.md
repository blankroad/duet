# Final integration-only static check

**APPROVE all three followups.** No production runtime semantic change, weakened assertion, or masked product failure identified. This does not approve B2 or start another implementation/review round.

| Commit | Static assessment |
| --- | --- |
| 32760e9 | Two calls inside the existing private-pasteboard test replace `&[a.clone()]` with `std::slice::from_ref(&a)`. Both still pass a one-element `&[PathBuf]` containing exactly the same path, board and nonce. Callee borrows paths to construct argv; no path mutation or retained borrow. Subsequent original-path use is unchanged. Every ownership/clear/stale-owner assertion and the existing ignore marker remain. Only test allocation/borrowing changes; no production implementation change. |
| 146efc7 | Moves `ThreeWayStatus` from module import to the sole test that uses it, already `#[cfg(unix)]`. The same enum/type and `RightDeleted` comparison remain. Unix test body/assertions and existing cfg are unchanged; Windows stops importing a symbol whose consumer was already excluded. No platform test is newly disabled. |
| 807efbf | SS31 changes `it.fails` to ordinary `it`, retains `expect(cmd.fsCopyPlan).not.toHaveBeenCalled()`, and strengthens feedback verification with exact `toast.trashOnlyPutBack` plus `"error"` assertion. Setup still selects the real virtual-trash location and adds a nonempty shelf item. No implementation, fixture shortcut, skip or error swallowing added. |

## SS31 guard trace at 807efbf

1. `src/components/__review__/shell-settings-sidebar.test.tsx:143` sets left pane location to local `VIRTUAL_TRASH_PATH`, activates left, and adds `/a/a.txt` to the shelf. Existing `beforeEach` resets all command mocks and the shelf, so earlier plan calls cannot contaminate this assertion.
2. `src/lib/fileActions.ts:765–785`: `applyShelfTo("copy", ...)` obtains the nonempty shelf, reads the active pane destination, groups the source and invokes **real** `planTransferTo` with the provided toast spy. No test mock replaces either shared action.
3. `fileActions.ts:671–676`: `planTransferTo` checks `refuseInVirtualTrash(dst, showToast)` **before** any `fsCopyPlan` call. Copy mode bypasses the move-only same-folder branch.
4. `fileActions.ts:212–216`: `isVirtualTrash` recognizes source.kind `local` + exact `shell:RecycleBinFolder`, emits `showToast(i18n.t("toast.trashOnlyPutBack"), "error")`, returns true, and planning returns immediately.

The existing mock plan-error result remains but should be unreachable. Removing the guard would call fsCopyPlan and fail the retained assertion; replacing the guard with a silent return would fail the new toast assertion. This promotes a legitimately repaired expected-failure test to a regression assertion, rather than hiding a failure. Other `it.fails` cases in that file are unchanged.

## Evidence and limits

- Inspected exact `git show` diffs for 32760e9, 146efc7 and 807efbf; surrounding test/helper bodies, SS31 reset/setup, shelf apply, pane location update and virtual-trash guard source inspected at those commits.
- `git diff <commit>^ <commit> --check` exited **0** for each followup.
- No source patch applied, no product files changed, no Git metadata mutation operations, no Cargo/Vitest/tsc/broad tests run. Only this report is written in the reviewer's permitted worktree.
- Main reports the first native gate exited 0 and first FE gate had 1321 passes plus SS31's unexpected expected-failure pass. That report is consistent with the source trace; it is not a reviewer rerun. Full FE and strict native/Windows clippy reruns remain main's gates; no result is inferred while they are running.
