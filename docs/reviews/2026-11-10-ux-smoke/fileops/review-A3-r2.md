# A3 round 2 — c6fc958

**Verdict: APPROVE.** A-R2-01 is resolved. No blocking findings. A1/A2 approvals from review-A-r2.md remain unchanged.

Reviewed the combined base→c6fc958 working-file patch and the isolated bc0561e→c6fc958 diff. Resume was requested after the pause deadline (clock verified 2026-11-11 02:09 Asia/Seoul).

- `entryDnd.ts::sameDirStrict` first checks source identity. Only **Windows local** paths use backslash as a separator. SSH (including SSH from Windows) and local POSIX preserve it literally while normalizing repeated/trailing forward slashes.
- `planItems.ts::sameDirForOps` supplies the existing runtime `isWindows()` decision. Both A3 action decisions use this wrapper: same-folder move refusal in `planTransferTo`, and copy self-conflict classification in `selfConflictsOnly`.
- New ordinary assertions pass: SSH `/srv/a\b`→`/srv/a/b` F6 reaches planning; their copy conflict keeps the configured Replace default; local POSIX preserves the distinction; SSH preserves it on a Windows client. Positive Windows separator equivalence, same-connection SSH self-copy/trailing slash, and different-source controls pass.
- `canonPath`, `sameLocationDir`, source comparison and all preexisting `entryDnd` functions are unchanged. The entryDnd diff only adds the strict helper and its private POSIX normalizer. Existing consumers such as cut highlighting, clipboard consumption, rename reveal, self-drag and event matching retain their prior comparator; this correction changes only the two A3 decision points.
- Existing copy-dialog controls still allow another policy, leave the global/remembered default unchanged for self-copy, and keep move dialogs unchanged. Same-folder in-app drag-copy remains the agreed no-op, not a finding.

## Exact checks

```sh
git diff 76b9b6e c6fc958 > review-notes/A3r2.patch && git apply review-notes/A3r2.patch
```

Exit 0, working files only. No index changes or edits to the Opus worktree.

Exactly one Vitest process, one worker:

```sh
node node_modules/vitest/vitest.mjs run --minWorkers=1 --maxWorkers=1 src/components/__smoke__/fileops-opus-self-copy.test.tsx src/lib/__smoke__/fileops-opus-ux.test.ts src/lib/__review__/fileops-opus-clippaste.test.ts src/components/dialogs/CopyMoveConfirmDialog.test.tsx
```

**Exit 0: 4 files / 91 passed, 11.91s.** Counts: self-copy 17, inventory 37, cut/paste 20, existing confirm-dialog tests 17. This includes 8 unchanged `it.fails` cases (shell shortcuts ×5, deferred rename text ×3), so 83 ordinary tests pass. New A3 regression assertions are ordinary tests. Existing Node `--localstorage-file` warnings only.

```sh
node node_modules/typescript/bin/tsc --noEmit
```

**Exit 0**, no diagnostics; executed once. `git diff --check`: exit 0.

These are **mocked FE tests** and static source checks, not live SSH, native app or Windows/NTFS validation. No Cargo, binding regeneration, additional test process, or code fix. No claim to fix unrelated legacy comparison limitations.

## Handoff and cleanup

`READY-candidate.json` updated: all batch A commits approved in chronological order through c6fc958; A3 round is 2. Full approved branch prefix was applied for these checks; main still owns integration gates. Previous 11-file batch-A evidence is retained alongside this focused revision evidence.

Executed `git apply -R review-notes/A3r2.patch` (exit 0), then `git diff --exit-code` (exit 0). `git status --short` shows only `?? review-notes/`. Candidate JSON parses successfully. No tracked changes remain.
