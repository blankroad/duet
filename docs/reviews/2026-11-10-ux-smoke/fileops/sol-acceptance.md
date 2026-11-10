# Fileops review acceptance — proposed fix set

Review checks code and focused tests; mocked FE ≠ live app, tempdir Rust ≠ Windows/NTFS or real SSH. Rust runs remain **pending a lead-granted cargo slot**. No product edits in this worktree.

## 24 — cut/paste lifecycle

- Opening then cancelling confirmation, closing via Esc, plan error, and execute/enqueue rejection retain the cut snapshot so Ctrl+V can retry. Same-folder/self-descendant guards retain it too.
- Consume only the cut entries whose execution was accepted, through both immediate and confirmed paths; copy clipboard remains reusable. All-Skip/no-op does not consume unexecuted entries. Multi-select/policy groups must not lose rejected/unsubmitted groups.
- An old async plan/dialog/task callback cannot clear a newer Ctrl+C/Ctrl+X snapshot. Repeated submission must not accidentally enqueue the same move twice.
- For accepted tasks that later fail/cancel after partial execution, distinguish acceptance from completion: report the partial result and retain existing journal/recovery; do not promise all items moved or blindly retry already moved paths. If remaining-entry clipboard recovery is deferred, document that limit explicitly.
- Check local↔local, local↔SSH, SSH↔SSH planning/confirmation with IPC mocks; no claim of real transfers.
- **Promote:** both `it.fails` in `src/lib/__review__/fileops-opus-clippaste.test.ts` → `it`. Keep immediate-success control. Add focused assertions for confirmation accept/cancel, enqueue error, grouped selection, and newer clipboard snapshot.

## 16 — running cancellation

- Running Cancel shows **Cancelling**, keeps task/progress visible and the host's worker occupied until execution really returns; no early terminal event/toast. Repeated Cancel is idempotent.
- Exactly one terminal event and at most one corresponding toast per task. A request arriving after the last cancellation checkpoint may truthfully finish Completed/Failed; never show terminal Cancelled first. Clear cancelling state on every terminal result.
- Queued cancellation prevents execution and terminates once. Cancelling one task never cancels others: same-host FIFO advances only after running work stops; other-host workers continue. Late snapshot/progress must not resurrect a terminal task.
- Partial local copy/move/delete retains existing completed-item journaling. Noninterruptible remote exec must remain Cancelling until it returns; do not imply SSH commands stop instantly. Progress dialog and task panel agree.
- **Promote:** both `it.fails` in `src/hooks/__review__/fileops-opus-taskcancel.test.ts` → normal assertions. Fixtures must exercise the implemented cancelling→terminal contract, retaining meaningful protection against duplicate/contradictory notices. Add a backend event-count/queue-order assertion: FE toast suppression alone cannot prove the queue fixed.

## 08 — case-only rename, single + batch

- On a case-insensitive FS, `a.txt→A.txt` and multi-select extension lowercase succeed; directory listing shows requested spelling, bytes/subtree remain intact, no temporary names left. Preview agrees with execution; unchanged names are safe no-ops.
- A genuinely different existing target, duplicate batch result, or selected-name overlap remains blocked without overwriting. Keep invalid-name/path-separator validation. Temporary-name collision or second-step failure must preserve/recover the original and report incomplete rollback.
- Journal reflects the logical rename once; undo/redo restore spelling without clobbering an occupied unrelated path. Case-sensitive local/remote FS must still distinguish `a` from `A`; no blanket lowercase identity test or local-path assumption for SSH.
- **Promote:** `core::ops::review_fileops_sol::{c06_case_only_rename,c07_case_only_batch_rename}`: remove `#[ignore = "fileops-08 repro"]`. Strengthen beyond success/preview: actual spelling, batch execute, content, rollback and undo. Existing volume self-skip is **unverified**, not NTFS evidence; Windows/NTFS requires actual Windows run or explicit limit. SSH behavior needs mocks/FS capability evidence; macOS success does not establish it.

## 17 — optional cross-device trash-failure improvement

- If copying succeeded but source trash failed, preserve the source, avoid “move completed,” and state accurately whether/where the destination copy remains. Multi-select identifies failed versus completed items; earlier completed moves remain journaled. Local↔remote relay must not claim source removal on failure.
- Full repair requires remaining copy to be rolled back safely or journaled for recovery; Replace must preserve the old destination on failure. Never infer “copy remains” from an arbitrary trash-delete error alone; FE fixture should use the real emitted error shape.
- **Promote FE if addressed:** fileops-17 `it.fails` in `src/lib/__review__/fileops-opus-r2-explain.test.ts` → `it`, with accurate backend-shaped input.
- **Promote Rust only if recovery fixed:** `core::ops::review_fileops_sol::c03_trash_failure_must_not_leave_unjournaled_copy`, remove its ignore. A wording-only change leaves this ignored repro and the unjournaled-copy defect explicitly unresolved. FaultFs simulates the volume/trash failure; Windows network-drive behavior remains unverified.
