# SYNC frontend smoke baseline — phase 1

Reviewer: ux-sync-sol. Date: 2026-11-10. Worktree: `/private/tmp/duet-ux-smoke-worktrees/sync-sol` (same as `/tmp/duet-ux-smoke-worktrees/sync-sol`). Baseline HEAD verified: `76b9b6e8b61608168b42a135a7a888422a3b1c60`.

## Verdict

**Phase-1 baseline completed after lead supplied generated bindings: focused run 10 files / 51 tests green, including 14 still-expected failures.** No product/test source was edited. No Rust build, full Vitest suite, dependency change, live app, native Windows, or actual SSH test was run. Authored files are this report and `REVIEW-sync-round1-criteria.md`. Independent review of Opus commits has not started (0 rounds).

The initial offline install failed; the lead subsequently installed locked dependencies with an unchanged lockfile. The resumed focused run reached 1 passing file / 5 passing tests, with 9 suites failing during import resolution because `src/types/bindings.ts` is absent. The additional comparison-tree run passed 1 file / 4 tests (combined: 2 files / 9 green tests, including 2 expected failures). These are setup failures, not demonstrated product regressions. `package.json:8` defines `gen:bindings` as `cargo run --manifest-path src-tauri/Cargo.toml --bin export_bindings`; generation was skipped under the lead's explicit no-Cargo instruction. That historical blocker was resolved when the lead supplied gitignored generated bindings; the successful rerun below supersedes it. The reviewer did not generate or edit bindings.

Every finding below is marked **static code trace**, **mocked-FE-test reproduced**, or **unverified**. Reading an existing reproduction test does not count as reproducing it.

## Exact setup and test commands/results

Initial setup:

```sh
pnpm install --frozen-lockfile --offline
```

Exit 1: `ERR_PNPM_NO_OFFLINE_TARBALL`, first missing package `https://registry.npmjs.org/@crabnebula/tauri-plugin-drag/-/tauri-plugin-drag-2.1.0.tgz`. No online retry was performed by this reviewer. The lead resolved dependency installation before requesting resumption.

Resumed focused command:

```sh
pnpm exec vitest run --minWorkers=1 --maxWorkers=2 src/components/dialogs/__review__/sync-compare-* src/components/__review__/sync-compare-xcheck-progress.test.tsx src/lib/__review__/sync-compare-r3-cancel.test.ts src/lib/__review__/sync-compare-errors.test.ts src/components/dialogs/CompareDialog.test.tsx src/components/dialogs/SyncDialog.test.tsx src/lib/fileActions.errors.test.ts --reporter=verbose
```

Exit 1, Vitest 2.1.9, duration 39.36s: **Test Files 9 failed | 1 passed (10); Tests 5 passed (5)**. Passing file: `src/lib/__review__/sync-compare-errors.test.ts` (three ordinary tests and two `it.fails` cases). All other requested suites failed to load with `Failed to resolve import "@/types/bindings"`. `fileActions.errors.test.ts` also depends on that module through product imports. Node additionally warned about `--localstorage-file` lacking a valid path; the reported suite failures were missing-module errors.

Additional related non-review test command:

```sh
pnpm exec vitest run --minWorkers=1 --maxWorkers=2 src/lib/compareTree.test.ts --reporter=verbose
```

Exit 0, duration 41.55s: **1 file passed; 4 tests passed** (grouping, descendant-status rollup, one-side directory leaf, nested folder chain). Content search for non-review `CompareDialog|SyncDialog|ThreeWayDialog|compareView|triggerCompare|triggerSync|triggerThreeWay` found only the two named dialog test files; no ThreeWayDialog/compareView-specific non-review test was found. `fileActions.errors.test.ts` was included, and `compareTree.test.ts` covers the related comparison tree helper.

`pnpm gen:bindings`, `tsc`, Cargo, full Vitest, and browser/live-app commands were **not run**.

### Latest rerun after lead supplied bindings — authoritative current baseline

The exact resumed focused command above was rerun unchanged with `--minWorkers=1 --maxWorkers=2 --reporter=verbose`. Exit **0**: **10 files passed; 51 tests passed**, duration **96.26s** (start 21:53:03 as printed by Vitest). Of these, **37 are ordinary passing tests and 14 are still-expected failures**. No failed suites, unexpected passes, or import errors. Node's `--localstorage-file` warning persisted without test failure. The previous compareTree run additionally passed 4 tests; it was not repeated because no implementation changed.

Evidence is **mocked-FE-test reproduced**, not live app or real SSH. Ordinary tests now independently reproduce the SC-11 injected-NewerLeft overwrite payload, SC-35 1-visible-row/3-decision payload, SC-12 mixed create/overwrite copy list, SC-14 literal `12 B / 40 B` modal/bar output, SC-13 empty-preview/enabled CTA, and SC-36 keyboard skip limitation. Existing non-review recompare/verify-generation tests, Sync readiness/prune-error guards, and fileActions error-toasts tests all pass. No new product code is present in this reviewer worktree.

The independent review checklist is `REVIEW-sync-round1-criteria.md`. Canonical-ID correction: baseline **FE-01 is SC-07**, already present in the prior functional report. It must not be registered as a new issue. FE-02/FE-03/SC-12/SC-14/SC-35 are parked per lead scope.

The successful two-worker run completed before the latest resource update arrived. No test process remains running and no retry was started. Future focused runs require `--maxWorkers=1 --minWorkers=1` and an available team FE slot (Opus priority); skip when uncertain. Cargo remains frozen. Reviewer task is complete and idle; no additional static re-traces are planned.

### Expected-failure inventory

All fourteen `it.fails` markers executed in the latest run and **all remain expected-failing**. Vitest reports them green because their expectations fail; this is not a claim that the defects are fixed:

| File | Cases | Execution status |
| --- | --- | --- |
| `src/lib/__review__/sync-compare-errors.test.ts:69,89` | Truncated merge should explain narrowing scope instead of an I/O label; same-host rsync-missing error should be localized. | **mocked-FE-test reproduced** (formatter-only tests, no IPC/live backend). Both expected-failing. |
| `src/lib/__review__/sync-compare-r3-cancel.test.ts:100,125` | SC-43a Esc during settings must stop later scan; SC-43b old canceled scan must not close newer scan. | **mocked-FE-test reproduced**, both still expected-failing; 2 markers. |
| `src/components/dialogs/__review__/sync-compare-compare-flow.test.tsx:111,220` | SC-11 subsecond remote rows must not default to overwrite; SC-38 list over 200 needs an omitted-count indicator. | **mocked-FE-test reproduced**, both still expected-failing; 2 markers. |
| `src/components/dialogs/__review__/sync-compare-diffpreview.test.tsx:99,114,151` | SC-33 right-side truncation notice; SC-23 changes beyond line 600; SC-46 internal `toolarge` label. | **mocked-FE-test reproduced**, all still expected-failing; 3 markers. |
| `src/components/dialogs/__review__/sync-compare-checksum.test.tsx:116,129` | SC-34 paste a single sha256sum-formatted line; paste a multi-file SHA256SUMS list. | **mocked-FE-test reproduced**, both still expected-failing; 2 markers. |
| `src/components/dialogs/__review__/sync-compare-jumper.test.tsx:79,89` | SC-48 alias label after restart; duplicate React keys for aliases on same IP/path. | **mocked-FE-test reproduced**, both still expected-failing; 2 markers. |
| `src/components/__review__/sync-compare-xcheck-progress.test.tsx:92` | SC-14 counts must not display as bytes. | **mocked-FE-test reproduced**, still expected-failing; 1 marker. |

The passing ordinary error test explicitly confirms that relay-sync refusal now maps to a translated explanation; do not repeat the old raw-English relay error as a current defect.

## Entry-point trace matrix

All entries here are **static code trace**. “Available” means reachable in code, not live tested.

| Entry point | Compare | Sync | 3-way | Selection/context behavior |
| --- | --- | --- | --- | --- |
| Empty-space pane context menu | `entryMenu.tsx:598` calls `triggerCompare` | `entryMenu.tsx:592` calls `triggerSync` | No dedicated item | `App.tsx:799` activates the clicked pane first. Background menu retains selected entries but the triggers ignore them. No source-capability/archive gating for these two actions. Virtual Windows trash gets a separate menu. |
| File/folder row context menu | No Compare item in `buildEntryMenu` | No Sync item | No dedicated item | Single/multi/mixed row menus expose other file actions. To compare folders, use background menu, TopBar, or palette. Absence is a discoverability gap, not a broken callback. |
| Toolbar/TopBar | `TopBar.tsx:131` always calls `triggerCompare` | No standalone TopBar sync button | No standalone button | Operates on the active tab plus opposite tab. No selection/source/archive precondition. |
| Command palette | `file.compare`, `commands.ts:538` | `file.sync`, `commands.ts:550` | `file.threeWay`, `commands.ts:544` | `App.tsx:1151-1153` maps to the shared triggers; `CommandPalette.tsx` executes registered action directly, without capability checks. |
| Shortcut | User binding to `file.compare` | User binding to `file.sync` | User binding to `file.threeWay` | These commands have **no default key** in `commands.ts`. `useGlobalShortcuts.ts:48-70` resolves configured bindings and invokes the same action; input/modal/context-menu isolation applies. No source checks. |

`fileActions.ts:273-348`: all three triggers call `resolveActiveTargets` but use only `active` and `opposite`, then read each tab's **current location**. None, one, multiple, mixed file/dir selections, cursor-on-file, and cursor-on-parent therefore all operate on the current folder pair. Selected subfolders/files are not compared or synced directly. When the right pane is active, it becomes logical “left” in the Compare/3-way plan; Sync source is the active pane. This convention is consistent across entry points but the generic “left ↔ right” command label can be confusing.

## Execution trace and source/context matrix

All execution/source claims here are **static code trace**; native I/O and actual remote operations remain **unverified**.

Shared Compare chain: `triggerCompare` → settings (default tolerance 0) → scan modal → `fsCompareDirs` → `commands/fs_ops.rs:867` → `compare_dirs_progress` → `CompareDialog`. Verify operates on Same rows; recompare sends edited rules. Apply/merge are disabled for truncated plans (`CompareFooter.tsx`).

Apply chain: dialog computes all non-skip decisions → `App.tsx:2365` → `fsApplyCompare` → queue `TaskKind::Sync` → `ops::apply_compare:2474` → unrelated-root guard → same-host direct copy or relay copy → backups/journal → progress/task events. There is no second overwrite confirmation; the Compare footer does show create/overwrite counts and backup note.

Merge chain: `App.tsx:2349` sends **only roots plus detectRenames** → `fsMergeBidir` → queue → `ops::merge_bidir:1871` → unrelated-root guard → **fresh comparison with default rules**, then copy LeftOnly/RightOnly in both directions. Existing differing files are not merged. No conflict resolver is provided here.

Sync chain: `triggerSync` → `fsSyncPlan` → unrelated-root + directory/capability checks → SyncDialog dry-run → user confirmation/prune (default OFF) → `App.tsx:1557` → `fsSyncExecute` → queue → core mirror/rsync → progress. Preview is awaited initially; on preview error non-prune execution becomes enabled, while prune is blocked. No automatic Compare navigation is offered on plan failure.

3-way chain: prompt base path on **active pane's source**, prefilled with active path → `fsCompareThreeWay` (directory check, no unrelated-root check) → ThreeWayDialog → `App.tsx:2327` calls `fsApplyThreeWay` without extra confirmation → queue → `ops::apply_three_way:2899` validates all three root pairs and recomputes comparison → copies changes/additions, trashes deletions, skips conflicts. Compare phase has no scan/progress/cancel UI. Valid-base delete actions have only the dialog's generic trash/backup note, not a separate deletion count/confirmation.

| Pane sources | Compare | Apply / Merge | Sync | 3-way |
| --- | --- | --- | --- | --- |
| Local ↔ local, unrelated roots | Both local filesystems; recursive metadata compare | Relay helper on local FS; overwrites backed up on Apply; Merge adds missing items | In-Rust mirror, optional prune | Supported with an explicit third unrelated base on active source |
| Local ↔ remote (either direction) | Both sources resolved; tolerance stays 0 by default | Relay through PC; same generic actions | **Enabled entry point always rejected by sync_plan**; translated explanation recommends Compare → Apply/Merge | Base is restricted to whichever source is active; data operations relay |
| Remote ↔ remote, same host/endpoint | Metadata compare; strategy badge same-host | Host-side copy, avoiding PC relay | Host-side rsync; command availability/permissions still required | Base on active source; same-host direct copy for apply |
| Remote ↔ remote, different host/endpoint | Supported; strategy relay | Relay through PC | **Enabled entry point always rejected**; translated alternative text | Base on active source; left/right application relays |
| Same IP but distinct known endpoint/port | `decide_fs` uses endpoint mismatch to choose relay | Relay | Rejected | Relay |
| Same/nested roots on same real FS | Read-only Compare can show a plan | Apply/Merge guards reject; enabled result buttons can lead to a queued failure | Plan guard rejects before confirmation | Compare accepts; Apply rejects overlap between ANY pair (including base==left) |
| Archive-browse panes | Operates on extracted **temporary directory**, not archive file | Mutates temporary directory if chosen as destination; no automatic repack | Follows underlying local/SSH source rules; temporary tree is sync src/dst | Base stays on underlying active source; same normal guards |

Archive details: `App.tsx:529-566` opens archive for browse and stores temp `Location` plus archive context; triggers do not inspect `tab.archive`. `Pane.tsx:146` offers Update archive only for repackable formats, otherwise `PathBar.tsx:314` displays “read only”. Explicit Update archive uses `App.tsx:1263-1310` → repack confirmation → compression task. Successful Compare Apply/Merge/Sync does not invoke it. Using an archive as source to copy out is legitimate. Mutating a non-repackable archive view has no in-app persistence route; see finding FE-03 below.

Source identity note: same-host decisions use `copy_strategy::decide_fs`, not IP alone. Claims about actual permission reachability, rsync installation/version, remote aliases/jumps and Windows paths require integration/device evidence.

## Priority findings and prior-issue reconciliation

### SC-11 — remote tolerance still defaults to zero (P2)

**static code trace**. `fileActions.ts:284-290` initializes 0 and falls back to 0 even with SSH source(s); `CompareRulesBar.tsx` initializes/prefills 0. `core/compare.rs:350` classifies same-sized files as Same only within tolerance; subsecond local/SFTP timestamp differences can become NewerLeft/Right. `compareView.tsx:129` defaults those statuses to copy toward the opposite side. The footer counts these as overwrites. Users can choose ±2s and Recompare, but must discover this themselves. **mocked-FE-test reproduced** in the latest run: injected three newer rows default to three overwrite decisions; its corresponding desired-behavior test remains expected-failing. This injection tests rendering/payload behavior, not the backend timestamp classifier or initial trigger default. No claim that every remote file is affected. Recommend source-aware default and explicit tolerance hint; preserve deliberately saved user settings.

### SC-14 — file counts sent/rendered as bytes (P2/P3 as lead prioritizes)

**static code trace**. Local sync `ops.rs:1382` emits file counts in `bytes_done/bytes_total`, with files fields defaulted to zero; `emit_merge_progress:2030` does the same for merge, compare apply and 3-way. `ProgressModal.tsx:91,144` uses countOnly only for delete, and `TasksBar.tsx:156` formats all non-delete progress as size. Thus 12/40 items takes the byte formatting path. **Same-host rsync sync is an exception**: its producer emits real transferred bytes (`ops.rs:1566`). **mocked-FE-test reproduced** in the latest run: literal `12 B / 40 B · 30%` in ProgressModal and `12 B / 40 B` in TasksBar; its desired-count-format expectation remains expected-failing.

### SC-15 — unsupported Sync still offered; explanation partially fixed (P2)

**static code trace** for action capability: context menu and palette have no combination check; `sync_plan:1193` rejects local/SSH and cross-host relay. The failure returns before opening SyncDialog. **mocked-FE-test reproduced** for formatter-only behavior: current localized text is “Sync between this PC and a server (or two different servers) isn't supported yet. Use Compare, then Apply or Merge.” Korean likewise gives the alternative (`i18n/ko.json:1395`). The old “raw English/no alternative” relay symptom is **fixed**; there is still no direct Compare button or pre-disabled Sync. Missing same-host rsync and truncated-merge explanations remain expected-failing. Task-level merge/apply errors still label operation by `TaskKind::Sync` (`useTaskEvents.ts:152`), although details retain the task title.

### SC-16 — default base produces a guaranteed Apply dead end; old default-delete scenario blocked (P2)

**static code trace**. `triggerThreeWay:312-318` pre-fills base with active/left path and accepts it. `compare_three_way` accepts coincident roots; files missing on right can appear RightDeleted, with auto > 0 and enabled Apply. BUT `apply_three_way:2913-2918` now checks base↔left via `ensure_roots_unrelated`; `path_guard.rs:130` rejects identical roots before mutation. Therefore accepting the prompt default cannot execute the old destructive deletion scenario on this baseline. Instead it opens a plausible result dialog whose Apply inevitably fails when there are auto entries. Prompt should start empty or require distinct base, and reject invalid base before showing actionable results. With a valid base, deletion propagation still has no separate deletion-total confirmation and the apply phase re-scans the tree; live behavior remains unverified.

### SC-12 — Sync preview mixes creates and replacements, may overwrite a newer destination (P2)

**static code trace**. `SyncPreview` and `SyncDialog.tsx` expose one copy list (new/changed), not create/overwrite counts. `ops.rs:1328` uses `src.size != dst.size || src.mtime > dst.mtime`: a smaller/older source with a different size still replaces a newer target. `mirror_dir:1362` backs up existing destination before copying, so do not characterize it as unbacked permanent deletion. Local-local confirmation lacks an explicit overwrite/backup count; remote trash text is not a per-file overwrite preview. **mocked-FE-test reproduced** in the latest run: mixed list has the Copy (new/changed) label and no overwrite/backup/.bak text. Recommend separating preview categories and disclosing the overwrite rule.

### SC-35 — search/status filters do not limit Apply (P3 per prior report)

**static code trace**. `CompareDialog.tsx:206` filters displayed rows; `:227-239` builds payload from all plan entries. Searching for docs/readme can leave unseen build files in Apply. **mocked-FE-test reproduced** in the latest run: the ordinary test confirms 1 visible row sends 3 decisions. Footer count exposes total, so this is a scope-clarity issue, not an invisible count. Clarify “all planned changes” versus visible scope or provide an explicit visible-only action. Merge likewise operates beyond the display filter.

### SC-07 (baseline alias FE-01) — Merge discards ignore rules from the displayed comparison (P2)

**static code trace**. Choose ignore `*.log`, Recompare, retain some visible unique file so Merge stays enabled. `CompareDialog:271` passes only detectRenames; App sends roots+flag; `ops::merge_bidir:1884` calls `compare_dirs`, which uses `CompareRules::default()` (`compare.rs:172`). The resulting work includes one-sided files/directories hidden by ignore rules in the displayed plan. Thus Merge can copy excluded artifacts and can hit the 5000-entry truncation limit despite a small displayed filtered comparison. This differs from SC-35: ignore globs define scan scope, not just visibility. This is the prior canonical SC-07; the FE-01 alias in the initial baseline was a duplicate, corrected here. Need a regression test/Opus validation before classifying as test-reproduced. Send current rules or reviewed plan into merge, or block/warn until semantics are explicit; coordinate any IPC contract change with lead.

### FE-02 — Compare can offer mutations for same/nested roots that always fail (proposed P3)

**static code trace**. The scan checks directory kinds but not unrelated roots (`commands/fs_ops.rs:867`, `compare.rs:198`). With distinct contents under parent/child folders, it can show actionable rows, then Merge/Apply queue before `ops.rs:1882,2484` rejects. Safety guard is correct; actionable preview is misleading. Validate mutation eligibility before enabling result actions. Same-root comparison generally has no actions unless user manually chooses a direction on Same rows, so the nested-root case is the clearer user path.

### FE-03 — “Read only” archive views still accept Compare mutations (proposed P2; archive coordination)

**static code trace**. Non-repackable archive browse shows a read-only badge (`Pane.tsx:146`, `PathBar.tsx:314`) but TopBar/palette/background Compare/Sync have no archive capability guard. Compare decisions can target the extracted temp directory, and a valid 3-way can mutate it too. No automatic repack follows; non-repackable format has no Update archive button. Users can see success and changed files while the original archive stays unchanged. Repackable formats have a manual Update archive route, but Compare itself does not tell users that persistence needs this extra step. Suggest gating mutation into non-repackable views and identifying temporary targets/persistence. Copying out remains useful. No live loss test was performed; handling belongs jointly with archive module.

## Cancellation, failure, permissions, and confirmations

**static code trace**: scan cancel calls `fsCompareCancel`; `triggerCompare` has no generation check around awaited settings/result. Esc before `fsCompareDirs` starts can cancel an old/nonexistent token and then start the new scan; late canceled A unconditionally opens `kind:none` over B. These are SC-43a/b, not new issues; both are **mocked-FE-test reproduced** in the latest run and remain expected-failing. Recompare/verify have their own local generation checks in CompareDialog; existing non-review stale-response tests both pass in the latest run.

**static code trace**: ProgressModal offers task cancellation; Esc/X backgrounds the running task, with outside dismiss disabled. Local sync checks cancel between entries; large copy calls themselves and same-host rsync wait do not establish prompt mid-operation cancellation. Same-host rsync holds the session lock while waiting (SC-24); actual latency not tested. Three-way initial comparison has no progress/cancel token; apply is queued and cancellable between entries (SC-44). Core mutation failures should not be represented as tested rollback/undo guarantees here; Rust baseline belongs to Opus.

**static code trace**: Sync dry-run hides subtree list errors via `unwrap_or_default` in preview walks (`ops.rs:1740,1772`), leaving an apparently successful incomplete preview (SC-13). FE also intentionally allows execution after preview failure when prune is OFF, while prune requires preview. Permission errors during queued operations flow via task failure and explainError; there is no sync-specific elevation retry registration in these trigger chains. No real permission test ran.

**static code trace**: Sync has a confirmation dialog with route and prune warning (prune default false). Compare Apply shows aggregate create/overwrite count and backup note but no second confirmation. 3-way has generic backup/trash text and conflicts count; no deletion-total confirmation or per-conflict resolution control. Recompute during merge/3-way can act on state changed after preview. Export overwrite confirmation is native and remains unverified.

## Evidence/read-command index and limits

Read required `CLAUDE.md`, `ARCHITECTURE.md`, prior functional sync report, fix-round README, and main review `PROTOCOL.md` (main path was read only). Initial combined output was truncated, so architecture and sync report were reread separately. No AGENTS.md was found in the worktree/checked ancestor paths. Git status initially clean; resumed status contained only this untracked report.

Representative exact discovery commands executed (all from this worktree):

```sh
git rev-parse HEAD
git status --short
rg --files -g AGENTS.md
rg --files src | rg '\.test\.' | rg -i 'compare|sync|three|fileactions'
rg -n 'CompareDialog|SyncDialog|ThreeWayDialog|compareView|triggerCompare|triggerSync|triggerThreeWay' src --glob '*.test.*' --glob '!**/__review__/**'
rg -n 'it\.fails|test\.fails|SC-1[12456]|SC-35' src/components/dialogs/__review__/sync-compare-* src/components/__review__/sync-compare-xcheck-progress.test.tsx src/lib/__review__/sync-compare-{r3-cancel,errors}.test.ts docs/reviews/2026-11-08-functional-review/sync-compare.md
rg -n 'gen:bindings' package.json
cat src/components/dialogs/CompareDialog.tsx src/components/dialogs/SyncDialog.tsx src/components/dialogs/ThreeWayDialog.tsx src/components/dialogs/compareView.tsx
cat src/hooks/useGlobalShortcuts.ts
cat src-tauri/src/core/three_way.rs
sed -n '1173,1253p' src-tauri/src/core/ops.rs
sed -n '1699,1793p' src-tauri/src/core/ops.rs
sed -n '1871,1957p' src-tauri/src/core/ops.rs
sed -n '2470,2520p' src-tauri/src/core/ops.rs
sed -n '2895,3040p' src-tauri/src/core/ops.rs
sed -n '2300,2405p' src/App.tsx
```

Early guessed discovery paths (`EntryContextMenu*`, `useKeyboard.ts`, `commands/compare.rs`, `commands/sync.rs`, `keyResolve.ts`, archive hooks) did not exist; searches were corrected to `entryMenu.tsx`, `useGlobalShortcuts.ts`, `commands/fs_ops.rs`, `stores/keymap.ts`, and App/pane/archive code. These discovery misses are not product/test failures. No main checkout file was edited. This pass intentionally does not claim live workflow reproduction, Windows correctness, native dialog behavior, real remote capability, cancellation timing, rollback, or undo durability.
