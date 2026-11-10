# L2 independent review — round 1

**CHANGES** for UX-SHL-01 (`8aff4f1` backend + `87dd723` frontend). The primary unfiltered FE repro passes, but selection completeness regresses after filtering, and canonical-parent validation is missing.

Applied the committed batch with plain `git apply _report/l2.patch` (no index/3way, no conflicts). The report's resume header explicitly authorized L2 on these commits. No product fixes authored here. **Windows runtime UNVERIFIED**: no Bandizip/7-Zip/native COM execution was performed.

## Required changes

1. **P2 — native More silently drops filter-hidden selected items. Reproduced by mocked FE test.** `src/lib/shellMenu.ts:105-107` intersects `selected` with `displayed`. `App.tsx:766` passes `computeDisplayed(tab)`. Filtering preserves the selected set (`stores/panes.ts:942-950`), and duet's own actions use **all** selected names (`lib/fileActions.ts:61-67`). Repro: select a.zip/b.zip/c.zip → filter a.zip → native More receives only a.zip, while duet actions still target all three. This can turn a multi-selection action into a single-item shell menu and omit two archives without notice.

   Added `UX-SHL-01 L2: native More keeps filtered-out selected items like duet actions` in `src/lib/shellMenu.test.ts:149`. Temporarily unmarked run fails at **line 170**, expected `[a.zip,b.zip,c.zip]`, received `[a.zip]`:

   ```sh
   pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/shellMenu.test.ts -t 'UX-SHL-01 L2:'
   # with it.fails temporarily changed to it: exit 1, exactly the assertion above
   ```

   Marker restored to `it.fails`. Fix: construct shell selection from the complete selected entries using the pane's current sort policy, excluding `..`, independent of visibility/filtering. Keep right-click-on-unselected-row replacement behavior. Do not change global selection semantics in this bounded fix.

2. **P2 contract/validation gap — compares lexical parents, not canonical parents. Static finding; Rust repro NOT RUN.** `src-tauri/src/platform/shell_menu_core.rs:24-29` applies `local_abs` then compares `Path::parent()`. `platform/mod.rs:109-111` only canonicalizes **non-absolute** Windows inputs; absolute inputs and all non-Windows inputs pass through. Therefore the explicit canonical-parent requirement is not implemented. `Path` comparison handles redundant separators, but not `..` resolution or directory aliases.

   Concrete tempdir repro added, ignored, at `src-tauri/tests/ux_shell_l2.rs:6`: `[tmp/sub/.., tmp/sub/a.zip]` has equal lexical parents but different resolved item parents. The validator currently accepts that pair. `build_menu` then binds only the first item's resolved parent (`shell_menu.rs:515`) and feeds both last-child IDs to it (`:516-524`). Possible wrong-parent native binding is a **static inference**, not Windows runtime evidence. Also equivalent canonical parents spelled through different aliases can be rejected unnecessarily.

   Fix: normalize and validate the actual item parents before permitting one-parent COM binding, keeping shell-item/symlink identity intentional; reject dot/dotdot or unresolved ambiguous inputs as typed errors. Add real tempdir normalization tests. Queued command (NOT executed without a slot):

   ```sh
   CARGO_BUILD_JOBS=2 cargo test --manifest-path src-tauri/Cargo.toml --test ux_shell_l2 -- --include-ignored
   ```

## Passed independent FE checks

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/shellMenu.test.ts src/lib/__review__/shell-settings-shell-menu.test.ts
# original batch: 2 files / 7 passed
# with marked reviewer repro: 2 files / 8 passed
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/__review__/primary-repro.test.tsx -t 'B:'
# PASS: 2 passed, 2 Part-A tests skipped, exit 0
```

Research acceptance copied verbatim from `research/repro-tests/primary-repro.test.tsx.txt`. Part B executes AST-isolated actual App callbacks with mocked IPC: all three differently named archives reach native-menu IPC, as does the complete selection when a plain file is included. This proves FE wiring for the primary unfiltered selection, **not** native verbs, extraction, or full live App behavior. No original App-level test files were changed by the target batch.

## Other requested checks

- Nonempty and ordinary different lexical parents return typed `DuetError::NotSupported`; order preserved. Canonical deficiency above remains.
- Cache key is full ordered `Vec<PathBuf>` plus scope (`shell_menu.rs:129`); reversed selection differs. `SessionCache::resolve` checks current token, and replace/remove/evict remove reverse mappings. No stale token resolves a newer session under normal token lifetime. Stale invocation currently logs/no-ops; user-facing failure is separately assigned UX-SHL-03.
- **COM lifetime/drop order static review: no issue found.** `Session` retains `cm`, parent `IShellFolder`, and every absolute PIDL (`shell_menu.rs:103-107`). `Session::drop` destroys HMENU, then declaration-order field drop releases cm → parent → PIDLs. `AbsPidls::drop` drains/free-once. Partial parse/bind/GetUIObjectOf failure drops earlier allocations; session exists before QueryContextMenu, so query failure cleans it too. Retention covers query and invocation. Native behavior remains unverified.
- Warm wrapper sends `[path]`; prewarm still builds a one-path slice. Background call now sends `[bgPath]` (`App.tsx:805`); actual background semantics remain UX-SHL-02, outside this batch.
- Displayed selection order, `..` exclusion, mixed kinds (`file` if any nondir), local/Windows/virtual-trash gates checked in source and existing mocked tests. Hidden-selection inconsistency above is the exception.
- Bindings were copied from Opus's generated ignored file, without Cargo. Verified `shellMenuOpen(paths: string[], scope)` / `shellMenuWarm(paths: string[], scope)` invoke `{ paths, scope }`; matches backend signatures and all FE call sites. No generated bindings committed.

## Backend evidence supplied by Opus (not independently run)

Per `SHELL-OPUS-R1.md`: focused `cargo test --lib shell_menu_core` rerun after cfg(test) edit: **13 passed**. `cargo clippy --target x86_64-pc-windows-gnu --lib -- -D warnings`: clean after fixing len visibility. Generated bindings succeeded. These are reported evidence only; mingw clippy is **compile-only**, not Windows/runtime acceptance. No Cargo/check/clippy/build run by this reviewer.

## Uncommitted files from this review

- `src/lib/shellMenu.test.ts`: appended marked filter-selection repro (target file itself arrived via patch).
- `src/__review__/primary-repro.test.tsx`: verbatim research acceptance copy, Part B run only.
- `src-tauri/tests/ux_shell_l2.rs`: ignored tempdir canonical-parent repro, **not run**.
- `_report/l2.patch`, `_report/l2-shellMenu-marked.backup`, this report.

Applied target product/test files remain uncommitted alongside prior L1 changes. No checkout/reset, product fix, or commit performed. Round 1 complete; requested changes need implementer follow-up.
