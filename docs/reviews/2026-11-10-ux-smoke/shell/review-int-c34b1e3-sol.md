# UX-SHL-01 integration follow-up — round 3

**c34b1e3 — APPROVE.** Reviewed against parent/main snapshot `197bf87`, including browse03's selection pruning. Test/comment-only adjustment; no shell behavior change or browse03 reversal found. **Windows runtime UNVERIFIED.** No Cargo/gen:bindings/build run.

## Contract checks

1. **After setFilter:** the integrated pane store computes the visible set and prunes selected names to it. The first split L2 case selects a/b/c, filters a.zip, confirms `resolveActiveTargets()` sees only a.zip, and checks native More receives the same one-item set. It passes.
2. **Selection set after filtering:** the second case filters first and then uses setSelected with a/b/c. That setter does not prune; both duet actions and native More receive all three. It passes. This preserves the helper's responsibility to honor its supplied selection, rather than adding a second visibility policy.
3. **Comment accuracy:** shellMenuTarget now says the store may prune on filter/hidden changes, while the helper orders the passed selected entries without filtering them by visibility. The existing exclusion of names absent from tab.entries and of `..` is still stated. This matches the code and integrated store.
4. **No behavior change:** `git diff 197bf87 c34b1e3` contains only `shellMenu.test.ts` and comments in `shellMenu.ts`. Independently transpiled both revisions' shellMenu.ts with TypeScript `removeComments:true`; **emitted JavaScript is identical**. panes.ts is not changed by this commit. browse03's pruning remains intact.

## Independent validation (own worktree only)

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/shellMenu.test.ts src/stores/panes.test.ts src/stores/__review__/browse-panes.test.ts src/lib/__review__/shell-settings-shell-menu.test.ts src/hooks/useShellWarm.test.tsx
# 5 files / 102 passed, exit 0
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/__review__/primary-repro.test.tsx -t 'B:'
# 2 passed / 2 Part-A tests skipped, exit 0
```

These are FE/store/IPC-mocked tests. Research Part B still confirms complete unfiltered three-archive and mixed selection through actual AST-isolated App callbacks; not native shell/extraction evidence.

## Snapshot preparation / limits

Did not run tests in or write to shell-int/main. Copied exact git snapshot files into shell-sol: `197bf87:src/stores/panes.ts`, and `c34b1e3:src/lib/{shellMenu.ts,shellMenu.test.ts}`. First combined run used my older base browse tests: two obsolete `it.fails` markers unexpectedly passed under the fixed integrated store (browse03/browse28), yielding 2 test-harness failures; shell tests passed. To reproduce the intended integration suite consistently, also copied `197bf87:src/stores/{panes.test.ts,__review__/browse-panes.test.ts}` and their changed `src/lib/glob.ts` dependency. Then all 102 passed as above. No product edits authored; all copied files are exact reviewed/integration snapshots.

Previous versions preserved as `_report/pre-int-*.backup`. All snapshot/test changes and this report remain uncommitted. Existing research acceptance copy unchanged. No new independent tests added; no git metadata writes.
