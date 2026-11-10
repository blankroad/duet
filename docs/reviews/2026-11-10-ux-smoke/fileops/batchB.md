# fileops batch B: ux-fileops-opus (code committed; cargo verification pending)

Branch `ux-smoke/fileops-opus`.

## Commits

| Commit | Item | Summary |
| --- | --- | --- |
| `df6f586` | Rust smoke test | Same-folder transfers and renames. 3 repros start as `#[ignore]`. |
| `d509fa0` | B1 (fileops-08, ux-fileops-02) | `rename_entry`: rename onto a free name, or a 2-step temp rename when the target is the same entry spelled differently, or `Io("already exists: <name>")`. Batch preview treats a self-alias as no collision. FE reason `renameUnchanged` (ko/en). c06/c07 un-ignored and strengthened. |
| `9489013` | B2 (ux-fileops-01) | `path_guard::same_entry`. Copy Replace/Skip onto itself is a no-op; Keep both still duplicates. Move onto itself is a no-op for every policy. c02 self tests updated to the no-op contract. |
| `342b28d` | B3 (fileops-16) | `TaskQueue`: queued cancel ends at once; running cancel only cancels the token. Atomic start. Finalize emits at most once. `TaskSink` exists so the queue can be unit-tested. FE taskcancel repros rewritten to the new contract (no FE product change). |

## Cargo already run while the slot was granted (before B3 existed)

| # | Command | Result |
| --- | --- | --- |
| 1 | `--test ux_smoke_fileops_opus` | 11 passed, 3 ignored. The build included the B1/B2 code. |
| 2 | Same with `-- --ignored` | 3 passed. Pre-fix failure of these repros is static evidence only. |
| 3 | `cargo clippy --test ux_smoke_fileops_opus -- -D warnings` | Exit 0. |
| 4 | `--lib -- review_fileops_sol::c0 batch_rename rename path_guard alias` | First run: 58 passed, 2 failed. The failures were the c02 self tests, which encoded the old "Replace onto itself = error". After updating them: **60 passed, 0 failed, 7 ignored**. Those 7 are prior known repros: fileops-09, 17, 18, 26, 27. |

Later code changed after these runs and is **not compiled yet**:

- B2 `same_entry` unit tests.
- B3 `task_queue.rs`.
- The B1/B2 split. Its content is identical to what ran in step 4, apart from rustfmt.

## Cargo needed (one at a time, after go)

All commands use this prefix:

```
CARGO_TARGET_DIR=/tmp/duet-ux-target-fileops-opus CARGO_BUILD_JOBS=2 cargo
```

and run from the worktree root.

1. ```
   test --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 --manifest-path src-tauri/Cargo.toml --lib -- services::task_queue core::path_guard review_fileops_sol::c0 batch_rename rename alias
   ```
   Expect everything to pass. The `review_fileops_sol` repros stay ignored.
2. ```
   test --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 --manifest-path src-tauri/Cargo.toml --test ux_smoke_fileops_opus
   ```
   Expect 14 passed, 0 ignored.
3. ```
   test --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 --manifest-path src-tauri/Cargo.toml --test mvp2_smoke
   ```
   This covers the rename/copy/move undo round trips.
4. ```
   clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings
   ```
   The known baseline hit `fs/local.rs:637` items_after_test_module is not mine.

## FE checks (done)

- `pnpm exec vitest run --minWorkers=1 --maxWorkers=1 src/lib/__smoke__/fileops-opus-ux.test.ts src/lib/error.test.ts`: **82 passed**.
- `pnpm exec vitest run --minWorkers=1 --maxWorkers=1 src/hooks/__review__/fileops-opus-taskcancel.test.ts src/hooks/useTaskEvents.test.ts`: **6 passed**.
- `pnpm exec tsc --noEmit`: exit 0, run once for batch B.
- eslint and prettier on the changed TS/JSON: clean.

## Limits

- **Case-only rename** runs only on a case-insensitive volume (macOS here). On a case-sensitive volume the test prints SKIP and the "refused other file" test runs instead. Not run on NTFS or SSH.
- **B2** does not cover same-server rsync between two different connections with identical paths (`SshSameHost`).
- **B3**:
  - Same-host rsync/cp still can't be interrupted (`ssh/remote_exec.rs`, remote-owned). Such a task stays "stopping" until the command returns.
  - The FE has no extra duplicate-event guard. The Rust queue tests guard the single-terminal-event contract.
- **Files I avoided:** `fs/local.rs` and `useTaskEvents.ts` are not touched.

## Cargo slot A (03:38): results on clean tree `342b28d`

All four commands use this prefix and test flags:

```
CARGO_TARGET_DIR=/tmp/duet-ux-target-fileops-opus CARGO_BUILD_JOBS=2 cargo
--config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 --manifest-path src-tauri/Cargo.toml
```

They ran sequentially, with `git status` showing only `?? review-notes/`.

1. `test --lib -- services::task_queue core::path_guard review_fileops_sol::c0 batch_rename rename alias`: **exit 0, 67 passed, 0 failed, 7 ignored** (prior known repros fileops-09/17/18/26/27).
   - **B3**: all 5 `services::task_queue::tests::*` pass:
     - `running_cancel_waits_for_the_task_then_emits_one_cancelled`
     - `cancel_after_the_last_checkpoint_reports_completed_only`
     - `running_cancel_that_fails_reports_failed_only`
     - `queued_cancel_terminates_once_and_never_runs`
     - `same_host_fifo_waits_for_a_cancelling_task_other_hosts_continue`
   - **B2**: `path_guard::tests::same_entry_detects_item_copied_onto_itself` and `same_entry_keeps_backslash_literal_on_ssh` pass.
   - **B1**: these pass:
     - `c06_case_only_rename`
     - `c06_case_variant_of_other_file_is_refused`
     - `c06_rename_onto_other_file_reports_already_exists`
     - `c07_case_only_batch_rename`
     - `c07_batch_onto_other_existing_file_stays_blocked`
   - The log has 0 "SKIP" lines. The macOS volume here is case-insensitive, so both case-only tests ran fully. The case-sensitive control ran too and returned early with its own skip message, which does not contain "SKIP".
2. `test --test ux_smoke_fileops_opus`: **exit 0, 14 passed, 0 failed, 0 ignored.**
3. `test --test mvp2_smoke`: **exit 0, 7 passed, 0 failed.**
4. `clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings`: **exit 101.**
   - Its only error is the known baseline `items after a test module` at `src/fs/local.rs:637`, in the lib test target. It is not mine and that file is untouched.
   - That error stopped the build early ("build failed, waiting for other jobs"), so targets after the lib test may not have been fully linted.
   - The earlier `clippy --test ux_smoke_fileops_opus -- -D warnings` was exit 0.

No other cargo was run.
