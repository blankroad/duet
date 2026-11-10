# Independent static review — approved B1/B3 subset

**B1 APPROVE and B3 APPROVE still hold for this exact subset**, subject to root's native/FE gates. No missing B2 dependency or new blocking finding identified. This is a static/dependency review, not a new test pass.

Inspected `/tmp/duet-ux-smoke-worktrees/fileops-subset`, branch `ux-smoke/fileops-approved-subset`, clean at **`7694b3b14f0bcb77947e72652329b355bd2bc435`**, based on `0386fc5`:

| Original | Subset commit | Scope |
| --- | --- | --- |
| df6f586 | 7b27754 | Rust smoke fixtures |
| d509fa0 | cf1e5c4 | B1 rename/collision behavior + tests/messages |
| 342b28d | 7694b3b | B3 cancellation/queue tests + FE regression fixtures |

Unapproved **9489013/B2 is absent**. Diff against 0386fc5 is 9 files, 1080 insertions / 172 deletions. No change to path_guard.rs, fs/local.rs, journal.rs, Cargo.toml, bindings, useTaskCancel.ts, useTaskEvents.ts, or stores/tasks.ts in this subset delta.

## Dependency and source identity checks

Machine-checked byte equality of actual subset working files with reviewed original commits:

| Subset file | Identical to |
| --- | --- |
| core/ops.rs | d509fa0 |
| core/undo.rs | d509fa0 |
| tests/ux_smoke_fileops_opus.rs | d509fa0 |
| src/lib/error.ts | d509fa0 |
| services/task_queue.rs | 342b28d |
| src/hooks/__review__/fileops-opus-taskcancel.test.ts | 342b28d |

- **B1:** `rename_entry`/`rename_via_temp`, preview and batch execution are unchanged from the approved code. Their `undo::self_alias` dependency is present with `pub(crate)` visibility; source-aware parent/join helpers and existing journal/undo APIs are present in this base. No call to B2's `same_entry`; no change to copy/move self-policy behavior or B2's altered test expectations. Collision and no-change error strings align with error.ts and both new i18n keys.
- **B3:** backend implementation and all five queue tests are identical to the approved version. `TaskSink`/`AppSink` are internal and preserve existing IPC/event types. The only `ProgressEmitter` construction is inside task_queue.rs, updated to its sink field; no external literal construction depends on the removed private app field. Existing shared cancellation hook, task removal/cancelling cleanup and ProgressModal/TasksBar consumers exist in 0386fc5 and require no B2 code.
- Earlier B2 findings remain deferred: missing same-host self-copy guard and no-op journal eligibility are not fixed or approved by this subset. Ordinary smoke data-preservation passes must not be described as proof of B2's no-op contract.

## Fixture expectations for root's gates

- **Rust smoke:** 14 actual `#[tokio::test]` attributes; **12 ordinary + 2 ignored**. Ignore counts exclude the file's documentation example.
- Still ignored at `src-tauri/tests/ux_smoke_fileops_opus.rs:193,231`: `same_folder_copy_replace_is_not_reported_as_failure` and `same_folder_move_keep_both_does_not_rename_original` (both B2/ux-fileops-01). Running this file with `--ignored` is expected to reproduce those deferred failures; a default run should not promote or execute them. B1's rename-collision test is correctly unignored.
- Ordinary same-folder safety tests permit the old error/rename result while checking preserved data. They do not require B2 to pass. The new fixture supplies real LocalFs/Journal/settings in tempdirs with pool/app=None and does not call OS trash or real SSH. Different-source-plan rejection is exercised at planning only.
- **B1 library tests:** c06/c07 case-only tests are ordinary and strengthened. They self-skip on case-sensitive volumes; root must report whether listing/spelling assertions actually ran. Separate-existing-file controls and batch collision/validation tests remain. NTFS/SSH and injected second-step rollback/redo coverage limits from review-B-r1.md remain.
- **B3 Rust tests:** five ordinary gated queue tests cover delayed running cancellation, late completion, failure, queued cancellation and same-host FIFO versus other-host progress. They depend only on the new in-memory sink seam and existing task types, not B2.
- **FE:** the three ux-fileops-02 rename-text cases and three cancellation cases are ordinary assertions, with actual new backend message/event shapes. The four previously requested FE files (`fileops-opus-ux`, `error`, `fileops-opus-taskcancel`, `useTaskEvents`) contain **zero active `it.fails`** in this subset. Main 0386fc5 already includes shell shortcut fixes, so the five shortcut cases that were expected failures on the original Opus branch are now normal assertions. Do not carry forward my earlier "5 expected failures / 83 ordinary" breakdown; here all cases in that gate should pass normally. Historical file-header `it.fails` examples are comments only.
- No latest-subset Rust/FE test result is claimed here. Root owns execution and integration gates, including detecting compile/runtime failures that static equality cannot establish.

## Read-only checks performed

`git -C <subset> log -6 --oneline`, `diff --stat/--name-status 0386fc5`, and full relevant diffs/source fixtures inspected. `git -C <subset> diff 0386fc5 --check` exited **0**. Byte checks used `git show <original>:<file>` versus the actual subset file contents; all six comparisons above returned true. Static scans verified 14/2 Rust test/ignore attributes, no active FE `it.fails`, and no B2 helper/call/test-helper residue.

Subset status was clean on inspection. Reviewer worktree remains at base 76b9b6e, tracked files clean, only review-notes untracked. **No product edits, patch application, Git index/commit operations, Cargo, Vitest, tsc, dependency installation, agents or model substitution.** Only this report was written, inside the permitted reviewer worktree.
