# SYNC round 3 — final independent review

Reviewer: ux-sync-sol. Date: 2026-11-11. Round **3 of 3**. Reviewer branch `ux-smoke/sync-sol`, HEAD/base `76b9b6e8b61608168b42a135a7a888422a3b1c60`. Reviewed target `84b58453625a447d478ea92c6d4e247b6bad11e7` on `ux-smoke/sync-opus`.

**84b5845 verdict: APPROVE, static review; Cargo execution pending.** The rewritten tests preserve the earlier overwrite/backup protection at the correct cancellation boundary and add stronger exact-journal and real-undo assertions. They do not merely accept the failed test's observed output.

**Final overall verdict for the 11-commit batch 863d38d..84b5845: APPROVE conditional on the targeted Rust tests and clippy gate passing.** Round-2 FE results remain 5 files / 30 tests passed and tsc exit 0. No new product code or FE change in round 3. SC-01 approval remains explicitly **LOCAL-only**; same-host partial-failure recovery remains OPEN in backlog by lead decision. No additional review iteration is requested.

All file:line references below refer to target 84b5845 unless an unchanged dependency is named. Evidence in this round is **static code trace** plus the lead-supplied earlier-run summary, not a fresh Rust/test execution.

## 1. Contract check: both rename boundaries, without weakening overwrite coverage

The old test asserted that after destination rename #1, b must already contain NEW-content and have a backup. Its fixture actually counts **every** destination rename (`tests/review_sync_compare_xcheck_opus.rs:94-105`), including `.duet-part` finalization. With name-sorted copy order, rename #1 is a's finalization, so the old boundary assumption no longer reaches b's backup at all.

84b5845 changes only `src-tauri/tests/review_sync_compare_xcheck_opus.rs` (144 insertions / 19 deletions); it does not alter production behavior, ignore a failing test, reduce an expected error to success, or remove the requirement that an overwritten b be complete with its old bytes recoverable.

| Contract requirement | Rename #1 test (`:264-278`) | Rename #2 test (`:283-311`) |
| --- | --- | --- |
| Cancellation is reported | Requires `Err(Cancelled)` | Requires `Err(Cancelled)` |
| Correct file states | a is full `fresh`; b remains exact `old`; c absent | a full `fresh`; b is **pinned to full `NEW-content`** at `:309`; c absent |
| Exactly one journal entry | Shared helper checks history length exactly 1 and UndoSync kind (`:213-230`) | Same helper |
| Exactly the mutations tracked | Created vector exactly `[a_new]`; no backup | Created vector exactly `[a_new]`; exactly one backup, original_path exactly b, backup bytes exactly `old` |
| Created fingerprints present | Length equals created count and every stamp Some (`:231-234`) | Same helper |
| No orphan .bak | All destination .bak names absent; journal backups empty | Exactly one destination .bak and its path equals the sole journal backup (`:301-305`) |
| Real undo recovers snapshot | Production undo cleanup through temp-trash resolver, UndoKind::Ok, exact sorted names+bytes equal pre-sync snapshot | Same full snapshot assertion |

The #2 test first expresses the two legal contract states for b, then **unconditionally asserts NEW-content**. Consequently the old-content branch cannot quietly pass for today's implementation: the explicit assertion at line 309 still fails. A partial b, missing b, missing/extra backup, wrong backup bytes/path, untracked creation, missing stamp, extra journal entry, leftover file/backup after undo, or wrong undo contents all fail assertions. This retains the original b-overwritten-and-backed-up guarantee in the new #2 test while making #1 test the genuinely earlier cancellation point.

The snapshot helper (`:165-173`) checks all directory entries' names and bytes for this intentionally flat fixture; it is not a metadata, recursive-tree, or crash-durability proof. Both tests start from a fresh TempDir/context. Source b (`NEW-content`) and destination b (`old`) differ in size, so overwrite does not depend on filesystem timestamp resolution.

## 2. Trace: the pinned b state is the actual contract-safe path

1. `core/ops.rs:1373-1378` sorts a_new, b_changed, c_later and checks the Sync cancellation token only between entries.
2. `mirror_file` copies with `fs::copy_relay` (`ops.rs:1454`). The unchanged `fs/mod.rs:314-323` creates a **fresh, uncancelled copy token**. Therefore requesting Sync cancellation during a file does not interrupt that file's copy.
3. These small local files use `native_copy_file` (`fs/mod.rs:493-512`): copy to `.duet-part`, then `finalize_part` calls the fixture destination `rename(part, final)` at `fs/mod.rs:608`. This is counted by the fixture, even for a newly created file.
4. **Cancel #1:** a's final rename completes; fixture cancels the Sync token; copy returns success and a is added to created/source bookkeeping. At the next loop entry the token is cancelled, so b and c are untouched.
5. **Cancel #2:** a has already completed. `mirror_file` moves b to its chosen backup (`ops.rs:1447-1450`); fixture cancels after that successful rename. No cancellation check occurs before b's copy. It completes into its final name (rename #3), then the backup is recorded (`ops.rs:1473-1477`). The next entry, c, observes cancellation and never starts.
6. `sync_execute_local` retains the error outcome, stamps created/backed-up changes, pushes exactly one UndoSync entry, **then** returns Cancelled (`ops.rs:1290-1344`). Backup preservation plus partial journal makes the pinned completed-b state safe under the agreed cancellation contract, despite cancellation not being immediate.

This is file-boundary cancellation, not prompt mid-file cancellation. These tests do not prove crash safety, arbitrary disk failure recovery, or same-host rsync cancellation; those claims are excluded.

## 3. Undo genuinely uses production recovery with temporary trash

`undo_restores_snapshot` calls `undo_fixture::undo_tmp` (`tests/review_sync_compare_xcheck_opus.rs:248-258`), requires `UndoKind::Ok`, and compares the full destination snapshot afterward. The unchanged `tests/support/undo_fixture.rs` calls production `undo_cleanup` using its `FsResolver`, not a hand-written restoration of the expected bytes.

The resolver supplies `TrashDirFs` only for Local source and rejects SSH. Its `trash` implementation renames into a newly allocated TempDir trash (`support/undo_fixture.rs:51-57`); `remove` panics (`:59-61`), and restore is another local rename (`:62-66`). Thus these two new undo paths do not call OS Trash or a real server. The source, destination, context files and temporary trash are app/test-owned temp paths. Other pre-existing ignored tests in this integration file are not represented as safe/green new tests by this review.

## 4. items_after_test_module check for the entire changed Rust scope

**Static result: no new `clippy::items_after_test_module` pattern in any of the seven Rust files changed by 76b9b6e..84b5845.** Inspected top-level declarations and file tails from the committed snapshot, not just the last commit's diff. In production source files, test modules form the final suffix; later modules in that suffix are also test-only. Integration test files are test crates and their top-level helper-module declarations do not introduce an inline unit-test module followed by production items.

| Changed Rust file | Structural evidence at 84b5845 |
| --- | --- |
| `src-tauri/src/commands/fs_ops.rs` | Last production function `format_move_title` at 1987; `#[cfg(test)]` modules start at 1998/1999, then test-only modules at 2193/2194 and 2247/2248; EOF 2314. No production item after them. |
| `src-tauri/src/core/ops.rs` | Last production function `copy_execute_same_host` at 4184; test-only suffix begins 4476/4477. External `ops_paths_tests` at 7834-7836 is cfg(test); later same_host_hash_tests, mirror_file_tests and sync_relay_guard_tests are all cfg(test); EOF 8120. No production item added after test modules. |
| `src-tauri/src/core/three_way.rs` | Last production function `walk` at 182; final cfg(test) tests module starts 285/286 and ends at EOF 480. |
| `src-tauri/src/core/ops_paths_tests.rs` | Entire external module is included under cfg(test) by ops.rs; fixture/helpers and individual tests, no nested unit-test module followed by product items; EOF 486. |
| `src-tauri/tests/review_sync_compare_apply.rs` | Integration test crate; fixtures/helpers and individual tests; shared undo helper is a support module without inner tests. EOF 559. |
| `src-tauri/tests/review_sync_compare_xcheck_opus.rs` | Integration test crate; new support module at 20/21 contains fixture code, no inner unit-test block. New snapshot/journal/undo helpers are test infrastructure, not production items after a unit-test module. EOF 618. |
| `src-tauri/tests/review_sync_compare_xcheck_sol.rs` | Integration test crate; fixture/helpers and individual tests, no nested unit-test module followed by production items; EOF 510. |

The existing `src-tauri/src/fs/local.rs:637` diagnostic is outside this changed-file list and was not edited. This static inspection is **not** a clippy execution result. Lead may run the planned gate allowing only that known lint to get past the baseline; this review does not introduce an allow attribute or rely on a broad suppression to hide a new module-order issue.

## 5. Earlier Cargo run and remaining gate

Read `/Users/ctmctm/Desktop/01_PROJECT/duet/docs/reviews/2026-11-10-ux-smoke/sync/cargo-r2/summary.txt`:

- Target was 912bf01; lib command exit 1, integration exit 101, include-ignored integration exit 101, clippy exit 101, bindings export exit 0.
- Lead reports the lib filter syntax prevented those tests running, normal integration failed on the obsolete #1 rename/b assumption, and clippy diagnosed only baseline local.rs:637. The summary alone contains exit codes, not detailed failure traces; the explanation is attributed to lead.
- Generated bindings succeeded and summary records only fsMergeBidir rules + ThreeWayStatus unreadable versus main, matching the hand edits used for the independent R2 FE gate.
- Known intentionally ignored repro failures do not establish a new product regression and must not be silently counted as a passing suite.

Final approval is conditional on lead's next permitted Cargo run actually executing the intended lib tests, passing the normal focused integration targets including **both** cancellation-contract tests, and passing clippy with only the agreed baseline allowance. Do not record a clean Rust gate until those results are appended. No reviewer Cargo/Vitest/tsc commands ran in round 3.

## 6. Final batch disposition

| Commits | Final scoped disposition |
| --- | --- |
| 863d38d + d165503 + 6083f1a | APPROVE: remote tolerance default plus protection of explicit user edits; independent R2 tests green |
| b3fb471 | APPROVE: unrelated 3-way base validation |
| ac5554e | APPROVE: source precheck before Apply backup, including static same-host trace |
| 093db91 | APPROVE: unreadable 3-way subtree excluded from auto-apply |
| 487ffca | APPROVE: Merge uses accepted dialog comparison rules |
| a3a271c + b16b507 | APPROVE: LOCAL-only Sync partial journaling/recovery and conservative uncertain-output tracking |
| 912bf01 | APPROVE: plan/preview/execute strategy validation prevents unsupported relay Sync |
| 84b5845 | APPROVE: preserves and strengthens cancellation/undo contract coverage at both real rename boundaries |

Backend dispositions are static pending the gate above. Same-host SC-01 remains OPEN; the other parked UX/data-safety issues retain their prior scope/status. No claim of all ignored repros fixed, real SSH verification, or Windows/native-device validation.

Read-only commands used include `git show 84b5845 --`, `git log --oneline 76b9b6e..84b5845`, `git diff --name-only 76b9b6e 84b5845`, `git show 84b5845:<path>` for committed source/test bodies, `cat` of the summary/undo fixture, and a Python subprocess reader extracting top-level declarations/tails from each changed Rust blob. No implementation was applied or index changed in this round. Final tracked/index diffs remain empty; only review/checkpoint artifacts are untracked. Reviewer idle; lead can append the execution results below.

## Lead execution results to append

Pending.
