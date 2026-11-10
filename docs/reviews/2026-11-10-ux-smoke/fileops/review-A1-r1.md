# A1 round 1 — 86dddea

**Verdict: CHANGES REQUESTED.** Reviewed `git diff 76b9b6e 86dddea` applied to this reviewer's working files, against acceptance.md §24. No index changes, Opus-worktree access, Cargo, or additional test runs.

## Findings

### A1-R1-01 — P2: global Skip consumes cut entries that were not moved

**Location:** `src/lib/fileActions.ts:501` (`consumeCutClipboard(clip, plan.items)`).

**Failure scenario:** Cut `a.txt` and `b.txt`; destination already contains `a.txt` but not `b.txt`. Paste, leave the dialog on **Skip**, confirm. The primary button is enabled because only one of two entries conflicts (`CopyMoveConfirmDialog.tsx:78–81`). `executeTransfer` receives the whole plan and policy `skip`. Once its task is accepted, line 501 removes **both** entries from the clipboard. Backend `core/ops.rs:986–988` skips `a.txt`, so its source remains but Ctrl+V can no longer retry it. This is the same clipboard-loss symptom for a normal mixed-selection workflow.

**Evidence: static call-path trace**, not an extra executed reproduction. Existing passing group test (`fileops-opus-clippaste.test.ts:160–178`) manually supplies only the accepted subgroup under Replace; it does not test global Skip on a mixed plan. The new tests also call `confirm(..., "skip")` on all-conflict mocked plans, where the actual UI would disable confirmation, so those tests do not establish correct Skip consumption.

**Required:** Preserve explicitly skipped conflict entries; consume only submitted non-skipped targets. Add an ordinary assertion using a two-item/one-conflict plan with global Skip: accepted nonconflict disappears, skipped entry remains. Preserve the existing per-file grouping behavior. If replanning creates a new skipped conflict, avoid consuming that item too, or document the remaining race separately.

### A1-R1-02 — P2: repeated Ctrl+V still submits the same cut snapshot twice while enqueue is pending

**Locations:** `src/lib/fileActions.ts:270` (no in-flight cut-snapshot reservation), `:436–439` (claim keyed only by plan object), `:556–578` (each paste gets a fresh plan and immediately executes it).

**Failure scenario:** No conflicts and `confirm_transfer=conflicts_only`; press Ctrl+V twice before the first `fsMoveExecute` response. Both calls capture the same clipboard id before consumption. Real IPC planning returns two distinct plan objects, so both `claimPlan` calls succeed and both move tasks enqueue. FIFO does not deduplicate them: the second later tries already-moved sources and can produce a misleading failure, or repeat work across destinations. The same issue is possible when a second paste plan started earlier finishes after the first has already consumed the cut snapshot.

**Evidence: static async call-path trace**, not an extra executed reproduction. The new double-confirm test (`fileops-opus-clippaste.test.ts:181–186`) reuses one plan object and therefore covers only double-clicking one confirmation. This is an existing race left open by A1, not a claim that A1 introduced it; it fails acceptance.md's repeated-submission criterion.

**Required:** Reserve/deduplicate an in-flight cut submission by clipboard snapshot/target identity, release reservation on plan error, cancelled confirmation or rejected enqueue, and allow later retry of retained entries. Do not apply this restriction to reusable copy clipboard. Add a deferred-IPC assertion with two distinct plans for the same cut snapshot; require one accepted move submission.

## Acceptance coverage and limits

- Both prior fileops-24 `it.fails` cases became ordinary passing tests: dialog-only planning and plan rejection retain the clipboard.
- Immediate and confirmed enqueue rejection retain it; accepted move consumes it; a newer Ctrl+C/Ctrl+X snapshot survives old confirmation. Copy clipboard survives. Local↔SSH/SSH↔SSH variants use mocked IPC only.
- File-specific consumption is wired through App's `dialog.clip` and each successful group; no actual App dialog/group interaction is exercised by the requested tests. Cancel/Esc is inferred from closing without executing, not a simulated key event.
- Consumption-on-acceptance is explicitly documented at `fileActions.ts:458–462`: later partial failure/cancellation does not restore clipboard entries. This is the declared scope boundary, with backend partial journaling unchanged; not a claim that all moves completed.
- Existing same-folder/self-descendant early returns retain the clipboard by static inspection. No Windows/NTFS/live transfer claims.
- Patch also adds `src/lib/__smoke__/fileops-opus-ux.test.ts` (397 lines, includes unrelated expected-failure probes). Read it; did not execute it because lead authorized only two files.

## Exact commands and results

```sh
git diff --exit-code
git diff 76b9b6e 86dddea > review-notes/A1.patch && git apply review-notes/A1.patch
```

Both exit 0. Patch applied in this worktree only; all five changed tracked files and the added smoke test inspected.

```sh
node node_modules/vitest/vitest.mjs run --minWorkers=1 --maxWorkers=1 src/lib/__review__/fileops-opus-clippaste.test.ts src/lib/fileActions.errors.test.ts
```

**Exit 0: 2 files / 18 passed** (13 cut/paste, 5 error-toast), 4.09s. **Mocked FE tests**, not live app tests. One Vitest process, maxWorkers=1. Node printed the existing `--localstorage-file` warning; no failed assertions.

```sh
node node_modules/typescript/bin/tsc --noEmit
```

**Exit 0**, no diagnostics. Executed once; no binding regeneration.

## Cleanup

Executed `git apply -R review-notes/A1.patch` (exit 0), then `git diff --exit-code` (exit 0). `git status --short` shows only `?? review-notes/`; the added smoke test was removed by reversal. No tracked changes remain. Findings refer to the applied A1 line numbers.
