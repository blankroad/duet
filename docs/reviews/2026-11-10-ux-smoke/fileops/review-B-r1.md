# Batch B round 1 — through 342b28d

| Item | Verdict |
| --- | --- |
| B1 — d509fa0, case-only rename / collision messages | **APPROVE** — source + mocked FE review; leased Rust verification remains an integration gate |
| B2 — 9489013, self-transfer no-op | **CHANGES REQUESTED** |
| B3 — 342b28d, running cancellation | **APPROVE** — source + mocked FE review; new Rust queue tests must compile/pass under a lease before integration |

Read Opus `batchB.md`, test smoke df6f586, and production/test diffs c6fc958→342b28d in the combined working tree. No Cargo was run. B1/B3 approval is not a statement that the latest Rust tree has compiled. Existing READY-candidate.json remains batch-A-only.

## Findings

### B-R1-01 — P2, B2: same-host SSH copy bypasses the self-copy guard

**Locations:** `src-tauri/src/core/ops.rs:547–550` (dispatch), `:4176–4184` (same-host conflict resolution).

**Failure scenario:** An SSH source and destination refer to the same server/path, e.g. source `/srv/report.txt`, destination folder `/srv`, policy Replace. This applies to one connection and to two same-endpoint connections. `copy_execute` dispatches `SshSameHost` to `copy_execute_same_host`, while the new `same_entry` check is inside **copy_execute_relay only**. The same-host resolver still renames the destination—which is also the source—to `.bak`, then rsync/cp attempts to read the now-missing source. The source vanishes from its original name and the task fails instead of being a no-op; backups/journal may permit later recovery but do not satisfy B2.

**Evidence: static source/call-path trace, not live SSH.** The top-level nesting guard compares the selected full path with the receiving **parent** folder and permits this case. FE Keep-both preselection is user-overridable, and different connection IDs do not get that self-copy preselection. Thus the backend path remains reachable. Opus notes explicitly exclude two-connection same-host coverage, but the implementation omission also covers same-connection same-host copy.

**Required:** Apply the self-entry/no-op decision before destructive same-host conflict handling (or at a common dispatcher/resolver). KeepBoth must still duplicate; Replace/Skip onto the same entry must not backup/exec. Add a fixture-backed regression that actually exercises the resolver used by `SshSameHost`, plus a control that distinct entries with the same basename still follow their chosen conflict policy. Different-server relay paths with identical strings must remain real transfers. No real SSH server is required for this regression.

### B-R1-02 — P2, B2: no-op copy/move still pushes an actionable undo entry

**Locations:** `src-tauri/src/core/ops.rs:800–826` (copy), `:1158–1181` (move); `src-tauri/src/services/journal.rs:426–432` (undo selection).

**Failure scenario:** Complete a real rename/move, then submit a same-entry copy Replace or a same-entry move. The new branch returns `Ok(true)` and increments `skipped`; the function then pushes `UndoCopy { copied: [], ... }` or `UndoMove { moved: [], ... }`, count 0, with `undone=false, stale=false`. Journal does not filter empty actions: `peek_undoable` selects this record and FE's `hasUndoable` does too. Next Ctrl+Z consumes the fake operation, reports successful undo of zero items, and leaves the real preceding operation untouched. Disconnected SSH can even require reconnection just to undo an empty action because undo resolves filesystems before iterating.

**Evidence: static source/journal/undo trace.** Newly changed `assert_copied_nothing` (`ops.rs:7027–7042`) expressly permits these records and checks only empty vectors; it does not establish that the no-op is absent from the undo stack. Existing integration smoke asserts bytes/names, not undo-stack eligibility.

**Required:** Ensure a no-op never becomes actionable undo/redo work. Prefer avoiding journal push; if an informational record is necessary, both backend selection and FE History/undo eligibility must exclude it, and it must not invalidate a real redo chain. Strengthen copy and move tests: seed prior undoable work, perform no-op under relevant policies, assert next undo still targets the prior real entry. Also test a mixed batch: real changes remain journaled while no-op entries contribute no work. Keep the different-file/same-basename conflict controls.

## B1 assessment

- Both prior fileops-08 ignored tests are now ordinary assertions and strengthened: actual listing spelling, contents, no temp residue, one logical journal entry, and undo. Multi-select extension lowercase is exercised. Case-sensitive-volume control refuses a separate case-variant file; existing-name and invalid-name controls remain.
- `rename_entry` checks lstat-style existence, requires conservative `self_alias` evidence (folded spelling + exact directory listing + metadata), and refuses different entries/dangling-link occupancy. Preview uses the same alias test, execution validates again. UUID temporary rename is only for a confirmed self-alias; second-step failure attempts restoration and double failure exposes the temporary recovery path.
- Existing batch rollback still has the known fileops-27 double-failure limitation; this batch does not claim to fix it. Existing no-replace race limits also remain. No new B1 blocker found by source inspection.
- Rename and batch collision text now matches actual backend `already exists` messages; unchanged batch rules get localized `renameUnchanged`. The three former rename-text `it.fails` assertions are ordinary passing tests using the new backend shapes.
- **Limits:** no independent Rust execution in this round; local case-only/undo/redo behavior must be gated on focused Rust checks. Case-insensitive tests self-skip on case-sensitive volumes; a passing self-skip is not NTFS evidence. NTFS/SSH case-only rename and controlled temp-step rollback failures are not executed evidence here. The current added case-only tests cover undo but not a complete redo assertion.

## B3 assessment

- Running cancellation now cancels only the token; worker owns the eventual Completed/Cancelled/Failed event. Queued cancellation emits once immediately; `try_start` checks token/status and changes to Running under the same state lock, closing the queued/start race. Repeated cancel and finalize are idempotent by status/presence.
- A worker awaits `run` and finalize before receiving its next work item, so same-host FIFO does not advance while cancellation is pending. Separate host workers remain independent. The TaskSink seam leaves production Tauri emissions intact and makes these assertions testable without AppHandle.
- Read all five new queue tests: running cancel delayed until stop; last-checkpoint completion; failure after cancel; queued task never runs/one terminal; same-host wait versus other-host completion. **Not executed/compiled by this reviewer**; pending leased results are necessary before integration.
- Mocked FE tests invoke the existing shared cancellation hook: retain running task + Cancelling with no premature toast, one cancel request on repeat click, and remove task/clear cancelling on each terminal result. Existing ProgressModal/TasksBar both use this hook. Normal snapshot/event ordering tests still pass.
- Rewritten FE repros correctly model the new backend contract; they no longer inject duplicate terminal events to demand a separate FE deduplicator. Therefore frontend passes alone do not prove backend event count; the queue tests are the missing Rust gate.
- Same-host remote rsync/cp may remain stopping until the command returns; this is the explicitly accepted limit. Panic/dead-worker recovery (prior fileops-28) is outside this fix. No new B3 blocker found.

## Independent commands/results

```sh
git diff --exit-code
git diff 76b9b6e 342b28d > review-notes/B.patch && git apply review-notes/B.patch
```

Exit 0; combined branch prefix applied in this worktree only. Main checkout local.rs and Opus working files were not modified.

Exactly one Vitest process, one worker:

```sh
node node_modules/vitest/vitest.mjs run --minWorkers=1 --maxWorkers=1 src/lib/__smoke__/fileops-opus-ux.test.ts src/lib/error.test.ts src/hooks/__review__/fileops-opus-taskcancel.test.ts src/hooks/useTaskEvents.test.ts
```

**Exit 0: 4 files / 88 passed, 7.17s** (37 inventory, 45 error, 3 cancel, 3 task-event ordering). Five inventory cases remain expected failures for shell shortcuts; 83 ordinary tests pass. These are **mocked FE tests**, not live tasks/filesystems/native/SSH. Existing Node localstorage warning only.

```sh
node node_modules/typescript/bin/tsc --noEmit
```

**Exit 0**, no diagnostics, executed once. `git diff --check`: exit 0.

Opus's previously leased Rust results in batchB.md are **worker-reported evidence**, not reviewer runs. At read time, latest same-entry unit tests and B3 were still marked uncompiled. Its earlier smoke results and 60-pass filtered run predate the final B3 tree; no assumption that they validate the queue change.

## cargo requested by reviewer

**Not run; no lease.** Request focused execution on the reviewed/revised tree only after the lead grants a slot. If Opus provides leased results for identical code, prefer those over redundant compilation. Commands below use the reviewer's own target directory and two jobs, with crate-only test optimization/debug settings to control resources:

```sh
CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/duet-fileops-sol-target cargo test --offline --manifest-path src-tauri/Cargo.toml --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 --lib services::task_queue::tests -- --nocapture
CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/duet-fileops-sol-target cargo test --offline --manifest-path src-tauri/Cargo.toml --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 --lib core::ops::review_fileops_sol::c06 -- --nocapture
CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/duet-fileops-sol-target cargo test --offline --manifest-path src-tauri/Cargo.toml --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 --lib core::ops::review_fileops_sol::c07_case_only_batch_rename -- --nocapture
CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/duet-fileops-sol-target cargo test --offline --manifest-path src-tauri/Cargo.toml --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 --test ux_smoke_fileops_opus
```

The final command's current tests do **not** cover the two B2 findings; add the requested same-host resolver/no-op journal assertions before claiming B2 fixed. Current existing tests do not independently prove temporary second-step rollback or case-only redo; focused fixture coverage is recommended, with skip/platform limits reported explicitly. No full suite or broad clippy requested.

## Cleanup

Executed `git apply -R review-notes/B.patch` (exit 0), followed by `git diff --exit-code` (exit 0). `git status --short` shows only `?? review-notes/`. No tracked changes remain. Line references above describe the applied 342b28d tree.
