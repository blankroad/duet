# Browse independent review — round 3 (FINAL)

**APPROVE `7615754` on static review and the isolated production-method probes. Cargo evidence pending at report time.** Both R2-01 and R2-02 are resolved in the exercised schedules; no additional P1/P2 finding was found in this scoped final review.

Reviewer worktree: `/private/tmp/duet-ux-smoke-worktrees/browse-sol`, branch `ux-smoke/browse-sol`, HEAD `76b9b6e8b61608168b42a135a7a888422a3b1c60`. Only the requested commit was reviewed and applied locally. No commits, index writes, Cargo invocation, binding generation, broad suite, native app or SSH test by this reviewer.

| SHA | Scope | Verdict | Findings / validation | Commands + result |
|---|---|---|---|---|
| `7615754ddef757ae37f3d7de4284efeeb978d087` | R2-01/R2-02, SC-18 overlay ordering and lifetime | **APPROVE — Cargo pending** | Shared sequence removes millisecond ambiguity; active-build IDs retain records for the oldest build that needs them; ending the final build clears records. Original overwrite, newer-build-first, later reindex, nested-root, prefix/root and cleanup controls pass. No blocking finding from static inspection. | `git show 7615754`, local `git apply`, focused Vitest command below: **11 passed / 0 failed / 6 skipped**, exit 0. `git diff --check`: passed. |

## What was checked

- **Ordering:** `OverlayState::take_seq` at `src-tauri/src/services/file_index.rs:187` supplies unique ordered IDs for global build starts and reindex starts. `build_local` takes its ID at `:359`, before walking. `publish_global` at `:492` selects overlays whose sequence is newer than the build and sorts them by sequence before applying them. No wall-clock timestamp participates in overlay ordering.
- **R2-01:** build A starts, a reindex completes, newer build B starts and finishes first. The probe calls `end_global_build(B)` while A remains registered, confirms the needed record is retained, then publishes A's old snapshot. The fresh hit remains present. Ending A clears records.
- **R2-02:** ending the last build clears overlays. A later no-active-build reindex is not overridden by a subsequent build. The probe keeps identical index timestamps to show that timestamp equality no longer affects the result.
- **Pruning:** `OverlayState::prune` at `:195` retains only records newer than the oldest active build and clears all records when there is no build. Cleanup also passes with the opposite completion order and a repeated end call.
- **Nested roots:** parent then child overlays are replayed in sequence order; a newer parent replacement removes obsolete descendant overlays. The retargeted R2 nested-root control passes, as do component-prefix `/a` versus `/ab` and root `/` controls.
- **Before first publication:** a reindex during an active build is recorded even before a global index exists; its contents survive the first global publication.
- **Lock order:** `splice_into_global` and `publish_global` take `inner` before `overlays`. `begin_global_build`, `end_global_build`, and the short reindex sequence allocation take only `overlays`; none then waits for `inner` while holding it. The sequence-allocation guard is dropped before the reindex walk/await. No reverse lock acquisition was found.
- **Join errors:** `build_global_from_roots` invokes `end_global_build(started)` at `:460`, after awaiting the blocking task and before propagating its join error. Thus the ordinary join-error path removes registration and prunes records. This was inspected statically; no forced-panic or cancellation fault injection was performed.
- **Prior controls:** the Unicode filename byte-budget and distinct-key cache-name regressions still pass, along with structural-cache validation and hidden-scope controls. No IPC or generated-binding change is needed.

## Reviewer test command

The probe was retargeted to the new `OverlayState`, `begin_global_build`, `end_global_build`, `splice_into_global(..., seq)` and `publish_global(idx, start)` API.

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/__review__/ux-smoke-browse-index.test.ts --testNamePattern='review-r[123]|browse-s08|SC-26' --testTimeout=30000 --reporter=json --outputFile=ux-smoke-reports/review-r3-results.json
```

**11 passed / 0 failed / 6 skipped**. All selected cases are ordinary positive assertions, not `it.fails`. One process, one worker, one focused file; no rerun. Artifacts: `review-r3-results.json`, `review-r3-test.log`.

The isolated harness extracts the current production state/helper methods and substitutes standard `RwLock` operations for Tokio lock operations. It explicitly schedules method calls; it does not run the filesystem walker, Tauri IPC or live concurrent tasks. Normalization helpers remain identity stubs for ASCII matching fixtures; the Unicode cache-name test does not depend on them. The actual `build_local` sequence allocation before its walk and build-wrapper join cleanup were checked statically in the production source.

Prettier formatted the adapted probe. `git diff --check` passed. No new tsc/eslint or Cargo execution by this reviewer.

## Cargo evidence and handoff

The lead's leased Cargo run/log for **7615754** has not been supplied within this review. Therefore this is the explicitly permitted **static + isolated-probe APPROVE, Cargo pending** verdict. The prior round's Cargo log validates 8f9547e, not this new commit; it is not presented as round 3 runtime evidence.

Reviewer-only probe adaptation: `ux-smoke-reports/sol-review-r3-probe.patch`, relative to the R2 probe saved as `r2-index-probe.ts.backup`. No product fix or commit by this reviewer. This is the final allowed review round; no automatic further testing or implementation will start.
