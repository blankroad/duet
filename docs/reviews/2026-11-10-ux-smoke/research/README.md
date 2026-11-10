# Research — UX smoke 2026-11-10 (checkpoint ~23:20 KST)

Lead ux-research-lead (w2:p1, Opus 5.5); workers ux-research-opus (w2:p2), ux-research-sol (w2:p3, gpt-6.1-sol). Base 76b9b6e. Research changed no product code.

## Files
- `REGISTRY.md`: canonical IDs (UX-ARC/SHL/FOP/BRW/REM/SYN-nn) with owner, prior aliases, status and evidence class. Only main hashes count as INTEGRATED.
- `opus-prior-issues.md`: ~150 prior items (11-08, 11-10, older), fix-round hashes mapped to main, dup groups, hot list.
- `opus-workflows.md`: per-module workflow → files → tests map.
- `sol-priority-repro.md`, `sol-action-availability.md`: static traces (entry points × selection × local/remote/archive).
- `sol-fe-repros.md`, `repro-tests/*.txt`: FE-MOCK repros (renamed .txt so the suite doesn't collect them).
- `sol-acceptance.md`, `repro-tests/primary-repro.test.tsx.txt`: end-to-end FE-MOCK acceptance of the user repro.
- `opus-evidence-ledger.md`: per-team claims vs evidence, file-overlap watch.
- `CARGO_QUEUE.md`: build slots (two team slots, delegated by main).
- `STATUS.md`: timeline.

## Primary user repro (several archives selected → no extract, no More/Bandizip)
- **UX-ARC-01** (archive): gates at `entryMenu.tsx:284` (`!multi`) and `fileActions.ts:632` (refuses >1). Fix in progress:
  - "Extract here" (true here, conflict-policy dialog, `fs_extract_here`)
  - "Extract each to its own folder" (batch plan)
  - Engine `9b661ac`: 16/16 cargo tests pass. Not READY yet.
- **UX-SHL-01** (shell): gate at `App.tsx:763-766` (`selectedCount===1`, Windows local only), plus a single-PIDL `build_menu`. Fix in progress in shell-opus:
  - `shell_menu_open` / `shell_menu_warm` take `paths: Vec<PathBuf>`
  - Requirements: same-parent validation on the backend, stale-token guard, cache keyed by the full selection.
  - Windows/Bandizip runtime UNVERIFIED.
- macOS has no More menu at all: recorded as a platform limit.
- Acceptance test fails on base for both parts (FE-MOCK). Rerun on the branches when the commits land.

## Integrated by main (per main)
- UX-ARC-08 = G-07 (archive-15, browse-32, browse-34): 8fa018a / cc0bd8f.
- UX-SHL-07 (F4 edit), UX-SHL-11 (DESIGN alt keys), UX-SHL-12 (mac Cmd+Backspace): 88f7d99 / e94719d / c6aaa3d.
  - These are not historical fileops-03/04.

## READY, not yet integrated
- Remote batch 1: 7ba7bcc (UX-REM-06 = remote-30), bb2fe92 (UX-REM-07 = remote-27), tests 33b9199 / 1cbebca. Sol APPROVE, FE-MOCK.

## Evidence limits
- No live-app, Windows-device or real-SSH evidence anywhere this round.
- FE-MOCK tests are not live tests.
- Several Rust repros (fileops, sync, remote, browse) were still waiting for cargo slots at checkpoint.
