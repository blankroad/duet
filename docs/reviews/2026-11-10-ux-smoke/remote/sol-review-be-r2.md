# Backend review — round 2 of 3

**Overall BE verdict: CHANGES / not READY.** `0a9f59b` is a sound mock repair. `bd8e57b` fixes a real false-failure assumption, but its replacement assertion does not establish the claimed pre-cancel ordering. The required post-fixup reruns are not yet recorded in Opus's report as of **2026-11-11 02:31 KST**. No Cargo or other tests run by Sol in this round; actual diffs and test bodies were read independently at HEAD `0a9f59b3e52972f445298f1f4b4730146000b1fa`.

| Fixup | Verdict | Evidence type |
| --- | --- | --- |
| `bd8e57b` | **CHANGES** | Static reading of original/fixed assertion and complementary runtime test; original Docker failure attributed to Opus. Post-fixup rerun pending. |
| `0a9f59b` | **APPROVE (static; execution pending)** | Static reading of fixture, unchanged assertions, default walker, and fail-closed tests; original unit failure attributed to Opus. Post-fixup rerun pending. |

## bd8e57b — chaos c13

**Original failure:** `review_remote_opus_chaos::c13_long_exec_blocks_other_ops_on_same_connection` expected only `Err(Cancelled)`. Opus reports find `/` completed successfully in **157ms**, before cancellation scheduled after 200ms, so that assertion rejected valid completion (`remote-opus/_report/opus.md:223`). This is a test assumption error, not evidence of a product regression.

**Contract assessment:** allowing a successful search that completed before cancellation is correct. The fix preserves list-during-exec <2s, session check <100ms, and search return <2s (`tests/review_remote_opus_chaos.rs:411–414`). However its new condition at **:419** is `Cancelled OR (Ok AND elapsed <250ms)`. Elapsed <250ms does not imply completion before the 200ms cancellation, and neither timer's actual ordering is captured. For example, cancellation at 200ms followed by an ignored cancellation and success at 220ms would satisfy it. This is a limited weakening of the cancellation assertion, not a proof of the claim in its comment.

**Requested change:** capture completion/cancellation ordering explicitly for the allowed-Ok branch, or use a controlled long-running search fixture with evidence it is in flight before cancelling and retain the exact Cancelled assertion. Keep the existing latency bounds. An elapsed-time allowance alone cannot classify the outcome as pre-cancel completion. No production implementation change is requested here.

**Complementary evidence:** the separate `review_remote_opus_handle::cancelled_exec_stops_the_remote_process_group` still requires Cancelled <2s and no remote `sleep 3171` process (`tests/review_remote_opus_handle.rs:67–101`). Opus's step 4a reports that Docker test passed, with ~4ms return after cancellation and no process left (`opus.md:222`). That supports the exec cancellation implementation on OpenSSH 9.7, but it calls exec_cancellable directly and does not replace search-backend cancellation wiring coverage. The c13 fix cannot be described as independently proving that cancellation branch when find completes before cancellation.

**Rerun evidence:** step 4b records the original **2 passed / 1 failed** and explicitly says rerun needed. No step 8 result is present in `opus.md` at review time. A green rerun of the 250ms assertion would not resolve the ordering gap above.

## 0a9f59b — ProbeFs lstat

**Original failure:** Opus step 5a reports **183 passed / 1 failed**, with `core::ops::ops_paths_tests::relay_count_and_preview_walks_use_each_filesystem` counting 0 instead of 1 (`opus.md:224`). ProbeFs left `exists=false` and did not implement symlink_metadata, so the trait default delegated to its always-NotFound metadata. After B2, list_for_walk correctly propagates that error, and count_files correctly treats an unreadable subtree as zero (`fs/mod.rs:80–92`, `core/ops.rs:1205–1211`). The fixture represented a listable directory as impossible to lstat.

**Contract assessment:** the fix adds only ProbeFs::symlink_metadata (`core/ops_paths_tests.rs:82–92`). Paths explicitly present as directory-listing keys return Dir; other paths retain the old metadata behavior. These fixture keys really are directory roots, not symlink fixtures. Production code and all original assertions are unchanged. The test still requires count=1, copy=`sub/leaf`, prune=`extra`, and the custom destination/source joins (`:173–212`). Returning the wrong child path still misses the keyed subtree and fails, so the original join contract remains exercised. It does not bypass list_for_walk or weaken B2's production fail-closed behavior.

The separate failing-lstat and changed-kind tests remain in `tests/remote03_walk_links.rs:529`, `:555`; Opus reports that nine-test target passed in step 5b (`opus.md:225`). Those tests verify that an actually failing lstat remains an error and comparison becomes Unreadable. They are complementary evidence, not a rerun of the repaired ProbeFs target.

**Rerun evidence:** `opus.md:229` still requests `--lib -- core::ops::ops_paths_tests`. No post-0a9f59b result is recorded as of the timestamp above. Static approval is justified; executed approval remains pending the leased step 8 result.

## Overall gate for round 3

Resolve the c13 assertion-ordering gap and record the exact post-fixup chaos and ProbeFs rerun results (including commits/commands/counts). Keep R1's integration requirement: sync guard `912bf01` before SshFs classification `9fe7819`, preserving its checks during conflict resolution. R1's production assessment and the 120s late-open cleanup limit are unchanged. The reports of successful Docker cancellation and SFTP link scenarios improve execution evidence but do not turn these two pending reruns into passes.
