# Primary user repro — R3 acceptance (FE-MOCK)

Test: `src/__ux_research__/primary-repro.test.tsx` (one unchanged acceptance file).
Evidence is **FE-MOCK only**, not live-app, native Windows/Bandizip, actual archive extraction, or SSH. No cargo, binding generation, build, full suite, commits, or team-worktree edits.

## Scenario and acceptance contract

Local Windows pane `C:/fixtures` contains a.zip, b.7z, c.tar.gz; all are selected. A React contextmenu event on b.7z calls the **actual App onEntryContextMenu callback**, which calls the **actual openEntryMenuAt callback** including its real selection handling and More block. Actual buildEntryMenu, shared fileActions, shellMenu adapter, and pane/context-menu stores run. App callbacks are AST-isolated from the branch's App.tsx to avoid unrelated full-App startup effects; no selection gate is copied/reimplemented. Mocked platform returns windows; only generated commands are replaced with a recording mock boundary.

A requires any enabled item whose ID starts with `extract`; invoking it must send all three distinct archive names to an extract-plan IPC. The mock detects extract-plan command names rather than assuming one exact API name. Mixed-file control adds readme.txt: either no extraction action is offered, or the action must submit exactly the three archives and never the plain file.

B requires enabled More options and invokes its lazy loader/action. Shell-menu-open calls (detected by command name) must include all three paths; the mixed control must include all four selected paths. A proxy command mock accepts singular or vector arguments/new shell-menu-open method names. These tests establish FE dispatch, not backend signature compatibility or shell extension support.

## Base — REPRODUCED (FE-MOCK)

Commit: `76b9b6e8b61608168b42a135a7a888422a3b1c60`.

Exact command:

`pnpm exec vitest run src/__ux_research__/primary-repro.test.tsx --maxWorkers=1 --minWorkers=1`

Exit 1. Vitest 2.1.9, duration 3.81s. Exact output summary:

```text
Test Files  1 failed (1)
     Tests  3 failed | 1 passed (4)
```

| Part | Result | Exact assertion output |
| --- | --- | --- |
| A, three archives | FAIL — extraction item absent, IPC assertion not reached | `multi-archive right-click must expose an extract* action: expected undefined to be defined` |
| A, plain-file mixed control | PASS — action hidden; no extraction plan calls | no failing assertion |
| B, three archives | FAIL — More absent, shell IPC assertion not reached | `Windows local multi-selection must expose More options: expected undefined to be defined` |
| B, plain-file mixed control | FAIL — More absent, shell IPC assertion not reached | `Windows local multi-selection must expose More options: expected undefined to be defined` |

Thus the exact primary missing-menu workflow is reproduced; base cannot reach the desired all-target IPC checks. The passing mixed extraction control is not evidence that multi-archive extraction works.

## Team branches — primary fixes not yet on branch

Read-only check at `2026-11-10 13:07:19 UTC`:

`git log --oneline 76b9b6e..ux-smoke/archive -- src src-tauri/src`

```text
eb183e0 fe/store: archive context R2 — new tabs, reopened nested tabs, overlap
ddf352f fe/store: keep archive-browse context on nested exit, Back and Up
```

Archive tip: `eb183e01aa1f290fd1a8cea0dcbb235e27c6cdce`.
**Part A: NOT YET ON BRANCH** (UX-ARC-01 multi-extract remains WIP per lead). Available commits address archive-browse context, not extraction menu/IPC. No relevant primary acceptance patch applied or Vitest run on archive tip; no pass claimed. Part B is shell-owned and not evaluated here.

`git log --oneline 76b9b6e..ux-smoke/shell -- src src-tauri/src`

```text
f52945a test: label alt-key tests with registry IDs UX-SHL-11/12
47dd1b9 test: shell review L1 dispatch tests for F4 and alternate keys
84a1c41 test: shell phase A smoke repros (F4 edit, multi-select open, macOS open -a, keymap)
d6dba8b test: cast the F4 test's partial deps through unknown
bd92c6b fe/ui: add DESIGN.md alternate keys for delete, rename, new folder
4f80d38 fe/ui: register F4 file.edit so the edit key works
```

Shell tip: `f52945a13f18416615fc0534a83a8cbaf5536772`.
**Part B: NOT YET ON BRANCH** (UX-SHL-01 multi More remains WIP per lead). No primary More/backend-selection implementation commit is present; existing changes/tests cover other shell issues. No relevant primary acceptance patch applied or Vitest run on shell tip; no pass claimed. Part A is archive-owned and not evaluated here.

Lead's latest instruction allows recording not-yet-on-branch and finishing rather than waiting/retrying. Once relevant commits arrive, apply the branch's src-only diff inside this research worktree, run this same single-worker test file, reverse the exact patch, verify clean tracked state. If a shell IPC signature changed while copied base bindings are stale, report **INCONCLUSIVE-bindings**, not a product failure. Mock-only argument acceptance cannot establish generated binding compatibility.

## Workspace and permission record

Initial requested throwaway `git worktree add` failed because Git metadata lives outside the sandbox in main .git. The escalated retry was declined/aborted; no throwaway worktree was created. Lead replaced that plan with local reversible patches; none needed application yet because primary fixes were not committed. No permission bypass occurred.

Final tracked diff is empty. `git status --short`:

```text
?? _research/
?? src/__ux_research__/
```

Copied bindings.ts remains gitignored. Research tests/reports remain uncommitted. A store-import Node localstorage warning appeared but all four tests collected and reached intended assertions; no harness collection failure in the base acceptance run.

## Harness preparation update (not executed)

At lead request, Part A now iterates **every enabled** extract-prefixed menu item, resets its IPC capture separately, recognizes `/extract/i` IPC names (not just plan calls), and captures actual useUIDialogs state after invocation. A dialog payload must name all three archives, excluding the plain-file control. The dialog confirmation adapter is deliberately pending the archive commit: it currently reports `INCONCLUSIVE-harness` rather than fabricating a policy or directly issuing an IPC. After the hash arrives, wire the actual dialog/confirm handler and its real batch-plan mock response shape, then run. Part B is unchanged and already accepts path arrays via recursive argument capture. No new test command was run for this preparation; the base results above belong to the prior, executed test version.

## R3b prep

Adapted Part A to the real archive design read from cd072c2 (read-only; no branch execution): batch-plan mock returns ExtractPlanItem-shaped archive/plan/error records, here mock returns archive/task_id/error records, and every enabled extract-prefixed item is exercised independently. Real useUIDialogs payload must contain exactly the three archives. Confirmation lazily loads **real runExtractHere** from extractActions and calls it with payload archives, `keep_both`, and toast, matching the real confirmation path rather than implementing IPC in the harness. A Vite glob avoids a missing-module collection error on base (loader is requested only when extract-here dialog actually opens). Extract detection is `/extract/i`; additional execution-stage assertion prevents plan-only calls from satisfying acceptance. Mixed control forbids readme.txt for each enabled extraction action. Part B remains unchanged and accepts shellMenuOpen path arrays. Preparation only: no tests run at this point.

## R3b shell — TESTED (FE-MOCK)

Source branch: `ux-smoke/shell-opus`, tested tip `87dd723fda62df0433fcdde4d6eb3a418e5fb3b2` (includes platform `8aff4f1` and FE `87dd723`). Research HEAD stayed `76b9b6e8b61608168b42a135a7a888422a3b1c60`; only branch src diff was temporarily applied. This is FE acceptance, not execution of changed native platform code.

Preparation commands (all succeeded):

```text
git diff 76b9b6e ux-smoke/shell-opus -- src > _research/shell-opus.patch
cp src/types/bindings.ts _research/bindings.base.ts
git apply --check _research/shell-opus.patch
git apply _research/shell-opus.patch
cp /tmp/duet-ux-smoke-worktrees/shell-opus/src/types/bindings.ts src/types/bindings.ts
```

The copied regenerated branch bindings were available, so this run is **not INCONCLUSIVE-bindings**. The command proxy still mocks IPC; this does not validate Rust/native ABI or generated-binding type checking.

Exact test command (one process, one worker, one file):

`pnpm exec vitest run src/__ux_research__/primary-repro.test.tsx --maxWorkers=1 --minWorkers=1`

Exit 1; duration 12.16s, 02:07:26 Asia/Seoul. Exact output summary:

```text
Test Files  1 failed (1)
     Tests  1 failed | 3 passed (4)
```

| Part | Result | Assertion output / evidence |
| --- | --- | --- |
| A three archives | EXPECTED FAIL (archive change absent) | `multi-archive right-click must expose an enabled extract* action: expected 0 to be greater than 0` |
| A mixed control | PASS | Extraction hidden; no plain-file extract IPC. Not positive archive-functionality evidence. |
| B three archives | **PASS (FE-MOCK)** | Real App callbacks → entryMoreOptions → shell adapter produced More options; loader dispatched native-menu IPC containing exactly C:/fixtures/a.zip, C:/fixtures/b.7z, C:/fixtures/c.tar.gz. Complete-selection assertion passed. |
| B mixed control | **PASS (FE-MOCK)** | Same path with readme.txt also selected sent exactly all four selected paths. Complete-selection assertion passed. |

Only failure output:

```text
FAIL src/__ux_research__/primary-repro.test.tsx > A: every enabled extract action sends all three differently named archives to extract IPC
AssertionError: multi-archive right-click must expose an enabled extract* action: expected 0 to be greater than 0
src/__ux_research__/primary-repro.test.tsx:118:94
```

No collection/harness errors. Node emitted its localstorage-file warning, unrelated to the reached assertions. Part B establishes menu availability and full-selection FE dispatch; does not prove real Windows/Bandizip extension population or execution.

Restoration commands (all succeeded):

```text
git apply -R --check _research/shell-opus.patch
git apply -R _research/shell-opus.patch
cp _research/bindings.base.ts src/types/bindings.ts
cmp _research/bindings.base.ts src/types/bindings.ts
```

Final tracked diff empty; status only:

```text
?? _research/
?? src/__ux_research__/
```

No commits, .git writes, cargo/gen:bindings/build, additional test file, or team-worktree edits. Archive acceptance remains pending its approved hash; archive cd072c2 was read only for harness preparation, not applied/tested.

## R3c archive — TESTED (FE-MOCK)

Fix source: `ux-smoke/archive-opus` at `d37f5befaeac0a60cf1e472c673b243001b3f859`. Base/research HEAD: `76b9b6e8b61608168b42a135a7a888422a3b1c60`. Src-only patch applied in research worktree; no Git metadata or team-worktree writes.

```text
cp src/types/bindings.ts _research/bindings.base.ts
git diff 76b9b6e d37f5be -- src > _research/archive-opus.patch
git apply --check _research/archive-opus.patch
git apply _research/archive-opus.patch
cp /tmp/duet-ux-smoke-worktrees/archive-test/src/types/bindings.ts src/types/bindings.ts
```

All preparation succeeded. Bindings supplied by archive-test (generated at d5c8309, unchanged archive IPC afterward per lead).

Harness now renders the **real ExtractHereDialog**, clicks its actual **Extract** button, and calls the real runExtractHere export from the onConfirm path, matching App's close-dialog → runExtractHere flow. Default policy asserted `keep_both`. Both `extract-here` and `extract` IDs/order are asserted for local multi-selection. Each action's IPC capture is reset independently; plan-only evidence does not pass: execution IPC must also contain the three distinct archive names. Batch plan mock returns three distinct successful ExtractPlanItem records; here mock returns three archive/task_id dispatch records. These are mocked IPC responses, not actual extraction.

Exact test command:

`pnpm exec vitest run src/__ux_research__/primary-repro.test.tsx --maxWorkers=1 --minWorkers=1`

Exit 1 (expected shell absence); 02:18:17 Asia/Seoul; duration 3.60s. Exact summary:

```text
Test Files  1 failed (1)
     Tests  2 failed | 2 passed (4)
```

| Part | Result | Evidence |
| --- | --- | --- |
| A three archives | **PASS (FE-MOCK)** | Both enabled actions independently reach extract IPC with a.zip/b.7z/c.tar.gz. Here passes real dialog payload+confirm; folders passes batch plan and per-plan execute. |
| A mixed control | **PASS (FE-MOCK)** | For each enabled extract action, readme.txt never reaches extract IPC; all three archive names reach execution. |
| B three archives | EXPECTED FAIL | Shell patch absent; More options missing. |
| B mixed control | EXPECTED FAIL | Shell patch absent; More options missing. |

Exact failure output (both B cases):

```text
FAIL src/__ux_research__/primary-repro.test.tsx > B: Windows local More retains complete multi-selection (plain-file control=false)
FAIL src/__ux_research__/primary-repro.test.tsx > B: Windows local More retains complete multi-selection (plain-file control=true)
AssertionError: Windows local multi-selection must expose More options: expected undefined to be defined
src/__ux_research__/primary-repro.test.tsx:149:76
```

No harness/collection errors; Node localstorage warning only. Restoration succeeded (`git apply -R --check`, `git apply -R _research/archive-opus.patch`, restore bindings, cmp). Intermediate status before combined contained only untracked research directories.

## R3d combined — all four tests PASS (FE-MOCK); real IPC INCONCLUSIVE-bindings

Base: `76b9b6e8b61608168b42a135a7a888422a3b1c60`.
Archive patch: `d37f5befaeac0a60cf1e472c673b243001b3f859`.
Current shell-opus tip captured for this run: **`d32af3b30d52f38418656b810e908e7bd701fdde`**, includes requested R2 d6b4191+d32af3b (not older 87dd723).

```text
git diff 76b9b6e ux-smoke/shell-opus -- src > _research/shell-opus-r3d.patch
git apply --check _research/archive-opus.patch
git apply _research/archive-opus.patch
git apply --check _research/shell-opus-r3d.patch
git apply _research/shell-opus-r3d.patch
cp /tmp/duet-ux-smoke-worktrees/archive-test/src/types/bindings.ts src/types/bindings.ts
pnpm exec vitest run src/__ux_research__/primary-repro.test.tsx --maxWorkers=1 --minWorkers=1
```

**Both patches applied cleanly in sequence. No file/hunk conflicts.** Exact test output:

```text
RUN v2.1.9 /private/tmp/duet-ux-smoke-worktrees/research-sol
✓ src/__ux_research__/primary-repro.test.tsx (4 tests) 596ms
  ✓ A: every enabled extract action sends all three differently named archives to extract IPC 378ms

Test Files  1 passed (1)
     Tests  4 passed (4)
  Start at  02:18:46
  Duration  4.04s (transform 601ms, setup 0ms, collect 1.58s, tests 596ms, environment 826ms, prepare 165ms)
```

Exit 0. **A three archives PASS; A mixed PASS; B three archives PASS; B mixed PASS (all FE-MOCK).** Actual App menu callbacks, archive actions and real extraction-confirm dialog dispatch correct archive sets; native-menu adapter dispatches complete path sets. No direct OS/backend task execution occurred.

**Integration signal — INCONCLUSIVE-bindings for real combined shell IPC:** supplied archive bindings `src/types/bindings.ts:330` still declare `shellMenuOpen(path: string, scope)` and serialize `TAURI_INVOKE("shell_menu_open", { path, scope })`. Shell branch generated bindings declare `shellMenuOpen(paths: string[], scope)` and serialize `{ paths, scope }`; shell backend `commands/system.rs` takes `paths: Vec<PathBuf>`. Mocked commands bypass generated wrappers, so this four-pass FE run cannot certify actual integrated transport or type compatibility. Main must regenerate integrated bindings with both IPC batches before final acceptance. This is a stale-bindings limitation, not a test failure or native Windows regression. Archive IPC wrappers are present in supplied archive bindings.

Restoration (all succeeded, shell first then archive):

```text
git apply -R --check _research/shell-opus-r3d.patch
git apply -R _research/shell-opus-r3d.patch
git apply -R --check _research/archive-opus.patch
git apply -R _research/archive-opus.patch
cp _research/bindings.base.ts src/types/bindings.ts
cmp _research/bindings.base.ts src/types/bindings.ts
```

Tracked diff empty; final status:

```text
?? _research/
?? src/__ux_research__/
```

No commits, .git writes, cargo, gen:bindings, builds, full suites, or concurrent FE test processes. All runs used one file/one worker. Final integrated-main acceptance awaits lead-provided main hash and confirmation that main bindings have been regenerated; no further run started.

## Final archive source equivalence

Verified command: `git diff --stat d37f5be 905bc2f -- src` exited 0 with **empty output**. Thus R3c/R3d's tested archive frontend source at d37f5be is identical to final archive source **905bc2f615bac200de1fe1ab96c7f1ba4401ea60**. No test rerun needed or performed; Rust-only changes are outside FE-MOCK evidence. Current shell-opus tip verified **d32af3b30d52f38418656b810e908e7bd701fdde**, identical to the R3d tested shell tip. The combined result therefore covers the final archive frontend plus current shell frontend, with the previously recorded generated-bindings limitation. Tracked workspace unchanged; only untracked research directories remain. Await integrated-main hash and regenerated bindings confirmation.
