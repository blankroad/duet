# Browse independent review — round 2

**APPROVE the Markdown and thumbnail fix pairs. CHANGES for `8f9547e`: the original single-build overwrite and Unicode filename defects are fixed, but two overlay-lifetime schedules still lose the latest reindex.**

Branch `ux-smoke/browse-sol`, HEAD `76b9b6e8b61608168b42a135a7a888422a3b1c60`. This review covers only the requested R1 fixes. Diffs were applied locally without commits or index writes. No Cargo, binding generation, broad suite, live app, or SSH was started by this reviewer.

## Per-SHA verdicts

| SHA / covered pair | Issue | Verdict | Findings | Commands / results |
|---|---|---|---|---|
| `0ba87da` (= Opus `da7dfc2`), together with `23f0c03` (= `cf94e9b`) | R1-01 / browse-08 | **APPROVE** | Enter/Space stop propagation before the pane's window handler. Click/auxclick prevention remains intact. Reviewer Enter probe now passes; supplied test also verifies Enter outside the link still reaches the pane. | `git show 0ba87da`; focused command below: reviewer Markdown Enter/autolink/image/raw-HTML controls plus all four supplied link tests passed. |
| `997facb` (= Opus `b152ce0`), together with `dfccc8c` (= `49f2413`) | R1-04 / browse-16 | **APPROVE** | Failure is keyed by complete versioned URL, including source/path. Same-name, same-metadata files in another folder retry; unchanged failed URL still falls back to icon. | `git show 997facb`; focused command below: all three thumbnail tests passed, including the reviewer folder-identity regression. |
| `8f9547e` | R1-02 / R1-03, SC-18 / SC-25 | **CHANGES** | ASCII prefix fixes byte length, and the original single-active-build probe passes. **R2-01 (P2):** a newer build's final publication can prune an overlay still needed by an older active build. **R2-02 (P3):** retained records can overwrite a later reindex when timestamps share a millisecond. | `git show 8f9547e`; isolated probes: 7 pass, 2 fail at intended assertions. Lead-run Cargo evidence inspected: **38 passed / 1 ignored** library cases and **8 passed** integration cases; supplied single-build and Unicode tests pass. |

## R2-01 — newer build prunes an older active build's overlay (P2)

Root: `src-tauri/src/services/file_index.rs:448-449`, final-publication `list.retain(|o| o.at_ms >= started)`.

Reproduced sequence using extracted production state methods:

1. Global build A starts at time 0 and holds an old subtree snapshot.
2. A folder reindex completes at time 10. Its overlay is recorded and applied.
3. Global build B starts at time 20, reads the newer data itself, and finishes before A. B's final publication deletes the time-10 overlay because it predates B.
4. A remains active (`global_builds == 1`). A publishes its old snapshot, but the overlay it needs is gone. The new hit count becomes **0 instead of 1**.

`global_builds` counts concurrent builds but the pruning rule does not account for the oldest one still active. Keep each overlay until every active build that can contain pre-overlay data is finished, or prevent overlapping global builds and reconcile completion/cleanup under that invariant. A generation/sequence scheme can express this without wall-clock ambiguity.

Test: `review-r2 newer final publication keeps overlays needed by older active builds` in `src/lib/__review__/ux-smoke-browse-index.test.ts`. The Rust probe runs the two publication orders explicitly; this is deterministic state-method evidence, not a live threaded timing test.

## R2-02 — retained overlay restores stale data at equal timestamps (P3)

Root: retained records at `src-tauri/src/services/file_index.rs:448-449`, recording only while a build is active at `:352-362`, and the `>= started` inclusion at `:445`.

Reproduced sequence with a controlled clock:

1. A build records and applies overlay `one_needle` at time 10, then finishes. The overlay remains after the active-build count reaches zero.
2. A subsequent folder reindex changes the subtree to `two_needle` while no build runs. The shared index updates, but the old overlay is neither removed nor superseded.
3. A new global build starts in the same clock millisecond, reads `two_needle`, and publishes that fresh snapshot. The retained overlay also has time 10, so `>= started` reapplies `one_needle` and removes `two_needle`. Its hit count becomes **0 instead of 1**.

This is a controlled equal-millisecond schedule, not a measured live wall-clock incident. Retaining overlays after all relevant builds finish also extends their memory lifetime until a later final publication prunes them. Clear/supersede records when no older build can need them, including the no-active-build reindex path, and prefer monotonic sequence IDs for ordering. Merely changing `>=` to `>` would instead lose legitimate same-millisecond reindexes during an active build.

Test: `review-r2 retained overlay cannot overwrite a newer same-millisecond reindex` in the same probe file.

## Requested static checks

- **Lock order:** both `splice_into_global` (`:351`, then `:353`) and `publish_global` (`:443`, then `:444`) acquire `inner` before `reindexed`. No opposite production order was found. No await occurs while holding the standard mutex guard. This is static inspection, not a deadlock stress test.
- **Join error counter:** `build_global_from_roots` decrements `global_builds` at `:433`, before propagating `JoinError` at `:434`. The ordinary join-error path therefore decrements correctly. No forced-panic/cancellation fault injection was run.
- **Nested roots:** the isolated control passes for parent overlay followed by a newer child overlay, then a newer parent replacement removing the child overlay. Component-prefix `/a` versus `/ab`, and root `/`, also pass. This does not cure the lifetime/pruning cases above.
- **Records after build completion:** the final publication deliberately retains records whose timestamps are at/after its start; decrementing the last active build does not clean them. R2-02 exercises the resulting stale-record case.
- **Cache names:** production ASCII-only prefix remains at most 120 bytes plus the hash/suffix. The valid nested Korean-root regression and distinct-key collision regression pass. Full-key hash preserves distinctions lost by prefix sanitization.

## Reviewer command and results

After applying `0ba87da`, `997facb`'s product hunk (the equivalent reviewer regression was already present), and `8f9547e` into this worktree:

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/components/pane/__review__/ux-smoke-review-r1.test.tsx src/components/pane/__review__/browse-lead-preview.test.tsx src/components/pane/__review__/browse-thumbnail-refresh.test.tsx src/lib/__review__/ux-smoke-browse-index.test.ts --testNamePattern='Markdown|browse-08|browse-16|review-r[12]|browse-s08|SC-26' --testTimeout=30000 --reporter=json --outputFile=ux-smoke-reports/review-r2-results.json
```

**19 passed / 2 failed / 6 skipped**, four focused files, exit 1. Both failures are R2-01/R2-02 at intended assertions, not timeouts or compile failures. The original R1 single-build overwrite, Unicode filename, Markdown Enter, and thumbnail-folder identity probes all pass. No duplicate backup test discovery in this run.

Artifacts: `review-r2-results.json`, `review-r2-test.log`. Prettier formatted the adapted index probe; `git diff --check` passed. No reviewer tsc/eslint/Cargo run is claimed.

The Rust harness extracts the current `ReindexOverlay`, `splice_subtree`, `splice_into_global`, `publish_global`, cache/query/validation helpers. It substitutes standard `RwLock` for the Tokio lock calls and controls `now_ms`; matching fixtures are ASCII, while the Unicode filename probe does not rely on normalization stubs. Active-build count changes in the interleaving tests represent the surrounding build wrapper's increment/decrement. These probes do not execute the filesystem walker or Tauri command layer.

## Lead-run Cargo evidence

Inspected full log: `/tmp/duet-ux-smoke-worktrees/browse-lead-cargo-r2.log`. This was executed by the lead, not this reviewer. The command specified in the brief was:

```sh
cargo test --lib --test review_sync_compare_sol -- file_index core::search search index
```

The log confirms the real backend compiled and reports:

- Library selection: **38 passed, 0 failed, 1 ignored**. Includes `global_publish_during_build_keeps_completed_reindex`, `cache_name_stays_short_for_long_unicode_roots`, global reindex splice/hidden controls, and core search tests.
- `review_sync_compare_sol` selection: **8 passed, 0 failed**. Includes content metadata filters, canonical-name queries, hidden exclusion, cache collision, corrupt-cache handling and symlink-cycle controls.
- Ignored remote-newline reproduction remains ignored; no SSH transport claim follows from these results.

This closes the earlier compile/runtime uncertainty for the supplied backend cases. The supplied publication regression has one active build and does not exercise either new failing schedule; its success does not contradict R2-01/R2-02.

## Handoff

Reviewer-only index probe adaptation/reproductions: `ux-smoke-reports/sol-review-r2-repros.patch`, relative to the R1 reviewer probe saved as `r1-index-probe.ts.backup`. The complete current probe is also available at `src/lib/__review__/ux-smoke-browse-index.test.ts`. No product fix, commit, or index mutation by this reviewer. Frontend fix pairs are approved; `8f9547e` needs overlay-lifetime correction. Await round 3 prompt; no automatic further work.
