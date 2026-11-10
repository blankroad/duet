# Remote FE batch 1 — independent review R1

**CHANGES for 445bc89; remaining commits approved as a batch.** Reviewed actual diffs from base `76b9b6e` through **445bc89**, applied in this worktree using `_report/batch1.diff`. No later branch changes included. No commits attempted; no Cargo, tsc, full suite, or concurrent FE test process started.

## Required change

**P2 / remote-NEW-3: prototype alias handling remains incomplete at entry points.** The reconnect guard and hostLabel fixes work, but sidebar and palette still read the nickname map directly:

- `src/components/Sidebar.tsx:1714` and `:1032`: with an empty nickname map and a config or saved host named `__proto__`, a nonempty sidebar filter passes the inherited prototype object to `matchesQuery` → `foldKey` (`src/stores/sidebarFilter.ts:54`), which expects a string. The sidebar still throws instead of showing the matching host. Both variants reproduced in mocked FE tests.
- `src/components/Sidebar.tsx:1785` and `:1239`: host rows still select inherited functions/objects as nicknames. These display lookups must use the same safe lookup as filtering. Recent/favorite paths already call the repaired `aliasLabel`.
- `src/lib/dynamicCommands.ts:52`: a config alias `constructor` still produces a Connect label containing the inherited Object constructor instead of `Connect: constructor`; the truthy check on line 53 has the same problem. Reproduced in a mocked FE hook test.

Please use one own-property nickname lookup consistently for sidebar filtering/rows and palette labels; preserve genuine own nicknames, including own `__proto__` keys. Coordinate `Sidebar.tsx` with its owner as needed. This is an incomplete fix of the existing issue, not a newly introduced regression. No remaining alias-based `in reconnecting` consumer was found; the sole remaining `id in active` checks full connection IDs (alias plus UUID), not plain aliases.

Repros are in **`_report/remote-new3-review.patch`** (one registry positive test plus three `it.fails` entry-point repros). `git apply --check` passed. Patch only adds a test file; no shared product files changed by the reviewer.

## Per-commit verdict

| Commit | Verdict | Review evidence |
| --- | --- | --- |
| `7ba7bcc` remote-30 | **APPROVE** | Last-`@` split preserves AD/SSSD usernames and existing last-colon IPv6/port parsing (`src/lib/hostAlias.ts:26`). Existing alias suites: 14 tests pass. No other first-`@` endpoint parser found. Rust `connection_supervisor.rs:207` uses `split_once` only for a nonempty-shape classification and does not construct an endpoint; usernames containing `@` still classify correctly. |
| `bb2fe92` remote-27 | **APPROVE** | Reads previous state before upsert (`src/hooks/useConnectionEvents.ts:29`); only connecting/error→connected refreshes; active tab IDs must match (`:67`). App passes a stable `onRefresh`, whose existing tab/navigation checks prevent stale listings and do not push history (`src/App.tsx:584`). Two supplied tests and an independent visible-both/hidden-tab/duplicate-connected test pass. |
| `33b9199` repro tests | **APPROVE with `1cbebca` included** | Actual committed tests match the R1 repros. NEW-1/2 intentionally remain expected failures; NEW-3 banner repro becomes ordinary regression coverage in 445bc89. The MenuEntry narrowing issue is fixed by the following commit. |
| `1cbebca` narrowing | **APPROVE** | Maps separators to null before reading item IDs, then filters null; preserves the same disconnect assertion (`src/components/connection/__review__/remote-sol-r1-saved-disconnect.test.tsx:88`). No production behavior change. No repeated tsc run performed. |
| `445bc89` remote-NEW-3 | **CHANGES** | Registry round-trip for `constructor`, `toString`, `__proto__`, state aggregation, hostLabel and banner regressions pass. Remaining sidebar/palette lookups above still fail. |

## Executed validation

One authorized Vitest process, one worker, **exit 0: 10 files / 52 tests passed**, including **3 expected-failure repros** for the outstanding lookup gaps. All are **mocked FE tests**, not live app/SSH tests. The test captures sidebar render exceptions before asserting successful rendering, so the expected failures demonstrate a render exception, rather than a missing test fixture. Palette repro asserts the exact intended plain-alias label.

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 \
  src/lib/__review__/remote-lead-host-alias.test.ts src/lib/hostAlias.test.ts \
  src/hooks/useConnectionEvents.test.tsx \
  src/stores/__review__/remote-sol-r1-prototype-alias.test.tsx \
  src/lib/hostLabel.test.ts src/stores/connections.test.ts \
  src/components/pane/ConnectionBanner.test.tsx src/stores/reconnect.test.ts \
  _report/remote-batch1-alias-review.test.tsx \
  _report/remote-batch1-refresh-review.test.tsx
```

Independent remote-27 test is also available as **`_report/remote27-review.patch`** (`git apply --check` passed). It verifies first connect does not refresh, only active matching IDs refresh, both visible matching panes refresh once, and duplicate connected events do not refresh again. No test retry or second FE process was run. Node emitted its existing localstorage-file warning; no unhandled test errors.

`git diff --check` passed. Review fixture files were formatted after testing (formatting only). Test process has exited; lead was notified that the team's FE slot is free. Review overlay remains applied for follow-up and can be reversed with `git apply -R _report/batch1.diff`; original R1 repro copies are preserved in `_report/base-repros/`.
