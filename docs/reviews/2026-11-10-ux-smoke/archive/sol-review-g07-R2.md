# G-07 R2 — BLOCKED before application/test

Read `git show eb183e0` and prior R1 change; verified corrected full diff `git diff 76b9b6e ux-smoke/archive --stat/--name-only` touches exactly seven intended G-07 files, no baseline smoke tests.

Attempted authorized reset of ONLY the six R1-applied files:

`git checkout -- src/App.tsx src/stores/panes.ts src/stores/session.ts src/stores/__review__/archive-context.test.ts src/components/pane/__review__/browse-opus2-app.test.tsx src/components/pane/__review__/browse-sol3-app.test.tsx`

Exit 128: `fatal: Unable to create '/Users/ctmctm/Desktop/01_PROJECT/duet/.git/worktrees/archive-sol/index.lock': Operation not permitted`.

Stopped at sandbox block per original instruction; no bypass, alternate reset, escalation, application, or test run. Tree still contains applied R1 patch; committed baseline preserved. No cargo or tsc runs. Cannot issue independently validated APPROVE yet.

## Static review of eb183e0

- Finding 1 addressed: openTab copies archiveTrail when cloning current location or opening within current archive; uses insideArchive for source + separator boundary rather than raw prefix. No trail mutation introduced (setArchiveContext builds new arrays).
- Finding 2 addressed: reopenClosedTab selects outermostArchive(...).exitTo for both location and reset history; clears archive/context trail. Session.snapshot uses same outermost helper.
- Finding 3 addressed: archiveFor evaluates current chain and remembered trail and chooses longest canonical containing root, so synthetic overlapping-root repro should select inner context.
- Finding 4 test rewrite agreed: original review called it advisory and explicitly allowed documenting the bound. Revised test asserts array length 20 and preservation of original durable /archives after 30 nested opens; this protects the intended behavior. It does not claim total retained objects <=20. Parent depth remains linear and intentionally unbounded; documentation states that limitation. The text “20 + nested depth” is an informal bound, not a measured memory guarantee across multiple retained nested branches.

No new blocking issue identified statically. Lead-reported 9/9 store tests, 18/18 App tests, tsc/eslint success are external evidence only, not independently rerun here.

Pending after permitted reset/application: `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/stores/__review__/archive-context-g07-sol.test.ts src/stores/__review__/archive-context.test.ts` exactly once. Apply corrected `git diff 76b9b6e ux-smoke/archive | git apply` only after scope recheck.

## Final follow-up — APPROVE

Lead authorized applying only the R2 delta over the already-applied R1 patch, avoiding index writes. `git show eb183e0 | git apply`: **exit 0**, working-tree only. Earlier reset block is resolved by this explicitly authorized alternative.

Ran exactly once:

`pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/stores/__review__/archive-context-g07-sol.test.ts src/stores/__review__/archive-context.test.ts`

**Exit 0: 2 test files passed, 9 tests passed, duration 2.55s.** All adopted review cases pass with the revised documented trail-bound test. `git diff --check`: exit 0. No App tests, tsc retries, cargo, staging or commits in this follow-up. Original baseline smoke files remain committed and unchanged.

**Final verdict: APPROVE G-07 R2 (eb183e0 over ddf352f).** Findings 1-3 resolved by implementation and passing focused store evidence; advisory finding 4 resolved by accurate documentation and a test of the intended bound/durable parent behavior. No additional blocking findings. Original no-live-filesystem/no-live-desktop limits still apply; App/tsc/eslint R2 validation remains lead-provided evidence.
