# L2 round 2 — independent review

- **d6b4191 — APPROVE** (UX-SHL-01 selection completeness/order).
- **d32af3b — APPROVE** (UX-SHL-01 parent-binding validation under lead-approved contract).

The two round-1 CHANGES are resolved within the explicitly revised scope. **Windows runtime UNVERIFIED.** No Cargo/gen:bindings/build run; backend test/clippy evidence below is Opus's, not independently repeated.

## Code assessment

`src/lib/shellMenu.ts:130-139` now takes the tab and derives ordering with the real pane sorter, disabling only filtering/hidden exclusion. It then selects every selected entry, excluding `..`. `App.tsx:763-768` passes the tab and preserves the rule that right-click on an unselected row replaces selection. Selected items hidden by a name filter or show-hidden setting are retained; selected names absent from the listing are omitted intentionally (normal refresh already prunes selection). Scope still follows the full selected items, not only visible items.

The copied former reviewer repro at `src/lib/shellMenu.test.ts:192` is an ordinary **it**, compares native selection with `resolveActiveTargets`, and passes. Additional implementer test confirms filtered selection order a/b/c despite Set insertion c/a/b. The same sorter preserves current pane sort direction and dirs-first policy.

`src-tauri/src/platform/shell_menu_core.rs:35-54` rejects dot segments before same-parent `Path` comparison. `:59-65` checks both components and raw slash/backslash segments, catching interior/trailing `.` hidden by Path iteration while preserving dotted names. Empty selection and disparate parents remain typed `NotSupported` errors. Existing ordered-selection/cache semantics unchanged.

**Contract decision:** this is deliberately not canonical-parent equivalence for arbitrary aliases. Given lead's explicit no-canonicalize decision and that legitimate FE items share one tab folder prefix plus actual entry names, rejection of ambiguous dot segments closes the identified wrong-parent case without rewriting symlink/shell-item identities. Equivalent aliases can conservatively fail validation. I accept that narrowed contract; requiring fs::canonicalize is no longer a blocker. Relative Windows inputs may be normalized by existing local_abs first; the pane-generated paths are absolute. No claim that every externally supplied shell namespace path is accepted.

## Independent FE checks

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/shellMenu.test.ts src/lib/__review__/shell-settings-shell-menu.test.ts src/hooks/useShellWarm.test.tsx
# 3 files / 20 passed, exit 0; includes the ordinary former L2 repro
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/__review__/primary-repro.test.tsx -t 'B:'
# 2 passed / 2 Part-A tests skipped, exit 0
```

Part B is the unchanged research FE-MOCK acceptance: actual AST-isolated App callbacks, three archives and mixed-selection control both submit all selected paths to shell IPC. Not live Windows/native/extraction evidence.

## Supplied backend evidence

`d32af3b` records `cargo test --lib shell_menu_core`: **21 passed**; `cargo test --test ux_shell_l2`: **1 passed** (copied reviewer tempdir repro, ignore removed); Windows GNU lib clippy `-D warnings`: clean. These were not rerun here. `SHELL-OPUS-R1.md` contains older in-progress sections; the supplied commit records cover this round. Windows GNU clippy is compile-only.

## Worktree handling

Saved conflicting previous reviewer test versions to `_report/l2r1-shellMenu.test.backup` and `_report/l2r1-ux_shell_l2.rs.backup`; restored the shellMenu test from 87dd723 using git show (worktree-only), moved the old untracked Rust repro into the backup, then plain `git apply _report/l2r2-l4.patch` succeeded. No index/checkout/reset or git metadata writes. Product changes are applied implementer code, not reviewer fixes. Applied tests/report remain uncommitted; no new reviewer test edits this round beyond adopting the implementer's passing repro. Existing research acceptance copy remains uncommitted.
