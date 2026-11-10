# Batch A independent review — through bc0561e

| Item | Round | Verdict |
| --- | --- | --- |
| A1 — fileops-24, including d4874f4 | 2 | **APPROVE** |
| A2 — e300302, Recycle Bin guards / empty Delete | 1 | **APPROVE** |
| A3 — 756c9fe, same-folder move / copy default | 1 | **CHANGES REQUESTED** |

Inventory `6371b88` and relabel `bc0561e`: **APPROVE** as test changes. Passing expected-failure tests do not mean their underlying issues are fixed.

## A1 round-1 findings resolved

- **R1-01:** `itemsActedOn(plan, "skip")` excludes known conflicting names from consumption in both global and per-file submission paths. The new two-item/one-conflict ordinary assertion preserves the skipped cut entry. Per-file consumption uses each replanned group's conflicts.
- **R1-02:** reservation starts before planning and survives the confirmation dialog and pending enqueue; `beginCutSubmit` runs before closing the dialog, with cleanup in `finally`. New deferred-IPC tests return fresh plan objects, covering repeated paste during planning/enqueue, dialog cancellation, rejected enqueue and retry. Copy clipboard remains reusable.
- Older paste cannot clear a newer snapshot; original repro assertions remain normal passing tests. Partial execution after acceptance remains an explicitly documented limit: clipboard is not reconstructed; backend journaling is unchanged. No new A1 blocker found. Actual App per-file dialog interactions are statically traced rather than rendered by these tests.

## A2 review

**No blocking findings.** Read the shared action guards, toolbar enablement, OS-drop guard, i18n and regression tests. Virtual trash is refused as a transfer source/destination before IPC; Ctrl+C/X and single/batch rename refuse it; existing clipboard data is preserved on refusal. Toolbar Copy/Move disable if either relevant pane is the bin. Empty Delete gives one localized toast and no plan/dialog; nonempty multi-select still plans normally. Entry-menu tests and existing dialog/toolbar regressions pass. Native Windows Recycle Bin and actual OS-drop delivery remain unverified; OS-drop guard itself is static evidence.

## A3 finding — A-R2-01, P2: false same-folder detection blocks valid POSIX/SSH moves

**Locations:** `src/lib/fileActions.ts:652`; `src/lib/planItems.ts:69`. The reused comparator is `src/lib/entryDnd.ts:50–59`.

**Failure scenario:** Same SSH connection, source directory **`/srv/a\b`** (literal backslash in the directory name), destination **`/srv/a/b`** (nested directories), with a selected `report.docx`. These are different POSIX directories. The new `planTransferTo` move guard calls `sameLocationDir`, whose `canonPath` replaces **every backslash with slash**, making both strings `/srv/a/b`. F6/shelf/paste now returns “already in this folder” before `fsMovePlan`; a valid move cannot start. The same distinction exists on local POSIX filesystems. This broadens an existing display-comparison limitation into a new action refusal.

The new copy default also uses that comparison: if the destination has another `report.docx`, `selfConflictsOnly` calls it a self-conflict and overrides the user's configured/remembered default with Keep both, despite copying between distinct directories.

**Evidence class: static source/call-path trace**, not an executed SSH/native test. The focused tests cover local Windows separator variants and ordinary SSH paths, but no POSIX literal-backslash distinction. No extra test process was started.

**Required:** Use source/platform-aware directory equality at these new decision points: SSH/POSIX backslashes must remain literal; preserve Windows local slash/backslash compatibility. Add ordinary assertions that (1) a move between those two paths reaches `fsMovePlan`, and (2) their name conflict is not classified as self-copy and keeps the configured default. Retain the positive Windows separator, same-connection SSH self-copy, and different-source controls.

In-app drag-copy to the same folder remains the explicitly approved DESIGN.md no-op and is **not a finding**. Ordinary same-folder refusal and Keep-both preselection work in the tested paths; A3 approval is withheld only for the incorrect POSIX identity comparison.

## Commands and evidence

Ran from `/private/tmp/duet-ux-smoke-worktrees/fileops-sol`:

```sh
git diff --exit-code
git diff 76b9b6e bc0561e > review-notes/A.patch && git apply review-notes/A.patch
```

Exit 0; applied the combined working-file patch only. Read `batchA.md` and all changed production/test files, including A1 reservation tests and A2/A3 probes.

Exactly **one Vitest process**, with one worker:

```sh
node node_modules/vitest/vitest.mjs run --minWorkers=1 --maxWorkers=1 src/lib/__smoke__/ src/components/__smoke__/fileops-opus-self-copy.test.tsx src/components/pane/__smoke__/fileops-fop01-trash-toolbar.test.tsx src/lib/__review__/fileops-opus-clippaste.test.ts src/lib/entryMenu.test.tsx src/lib/fileActions.errors.test.ts src/components/dialogs/CopyMoveConfirmDialog.test.tsx src/components/pane/PaneToolbar.test.tsx src/stores/clipboard.test.ts src/hooks/useCutNames.test.ts
```

**Exit 0, 11 files / 116 passed, 17.02s.** Includes **8 expected-failure cases**: UX-SHL-11 ×4, UX-SHL-12 ×1, deferred rename-text ux-fileops-02 ×3. Thus 108 ordinary assertions pass; these are **mocked FE tests**, not live app/Windows/SSH tests. File counts: inventory 36, clipboard 20, confirm dialog 17, entryMenu 11, toolbar 8, self-copy 11, errors 5, cutNames 3, trash-toolbar 2, empty-Delete 1, clipboard store 2. Existing Node `--localstorage-file` warnings only.

```sh
node node_modules/typescript/bin/tsc --noEmit
```

**Exit 0**, no diagnostics, executed once. No Cargo, binding generation, build, additional Vitest run or code fix.

`git diff --check`: exit 0. `READY-candidate.json` lists approved items only; A3 is excluded. **Integration caution:** d4874f4 was authored after A3 and touches overlapping code; the approved subset has not been cherry-picked/tested independently. Do not treat the candidate list as evidence that omitting A3 applies without conflicts. Main/lead should resolve the overlap or wait for the scoped A3 correction before integration.

## Cleanup

Patch reversal and tracked-clean check recorded after report creation below. All finding line numbers refer to applied bc0561e.
