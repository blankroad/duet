# archive — status

Lead: ux-archive-lead (w3:p1, Opus 5.5). Base 76b9b6e.
Worktrees: `/tmp/duet-ux-smoke-worktrees/archive` (lead, `ux-smoke/archive`),
`archive-opus` (`ux-smoke/archive-opus`), `archive-sol` (`ux-smoke/archive-sol`).

## Phase

- [x] Read PROTOCOL/CLAUDE/ARCHITECTURE, prior reports (11-08 archive, 11-10 fix-round archive)
- [x] Scope inventory (below, static — code read at base)
- [x] Focused smoke baseline — Sol `a8562c7` (ux-smoke/archive-sol): FE-mock vitest 2/2 pass reproducing AR-01/02; Rust real-tempdir smoke written, **not yet run** (cargo queue). See `sol-baseline.md`.
- [~] R1 primary: TRUE Extract here + Extract each to folder — spec `SPEC-R1b.md` (supersedes SPEC-R1 §1,2,4,5). Opus implementing.
- [~] G-07 / UX-ARC-08 (lead impl): R1 `ddf352f` → Sol R1 **CHANGES** (2×P2: openTab clone loses trail, reopened nested tab lands in temp path; 2 robustness) `sol-review-g07-R1.md` → R2 `eb183e0` fixes all + adopts Sol tests (store 9/9, App 18/18 single-worker, tsc 0, eslint 0) → Sol **APPROVE R2** (`sol-review-g07-R2.md`). **READY** (`READY.json`).
- [ ] R2 / R3 if needed
- [ ] Final report `archive/REPORT.md`

## Scope inventory (static, base 76b9b6e)

| Action | Entry points | Selection | Notes |
| --- | --- | --- | --- |
| Extract ("여기에 압축 해제") | context menu only (`entryMenu.tsx:284`), no commandId → no palette/shortcut | **single only** (`!multi`); `triggerExtract` toasts "하나만 선택" for >1 (`fileActions.ts:632`) | Label says "here" but BE extracts into `<stem>/` folder (`archive.rs:215`). Conflict → silent `.bak` move (archive-21, `plan.conflict` unused). Password retry uses one dialog slot (`ui-dialogs.ts:37`) |
| Browse (double-click) | `App.tsx:528` | single | remote 7z/rar falls through to open |
| Update archive (repack) | browse toolbar button | browse root | fixed U-09 last round |
| Compress | context menu `menu.compress`, no commandId | 1+ (mixed ok) | CompressDialog |

## Candidate issues (to be confirmed by smoke)

- AR-01 (P1 UX, motivating): no way to extract several archives at once — menu hides extract on multi-select, action refuses. Prior note: 11-08 archive.md "여러 아카이브 한 번에 풀기(현재 단일 선택만)".
- AR-02: "Extract here" label vs. extract-to-`<stem>/` behaviour mismatch.
- AR-03 = archive-21: existing `<stem>` folder silently moved to `.bak` (undoable), no prompt — amplified by multi-extract.
- AR-04: multiple encrypted zips → single password dialog slot (would race under multi-extract).
- AR-05: extract/compress not in command palette (no commandId) — keymap/palette is shell-owned registry; coordinate.

Native OS context menu / "More" (Bandizip entries) = shell lead. Archive owns the archive section of the in-app menu.

## Log

- 21:55 cargo freeze relayed to workers. Lead tree bindings.ts copied from main checkout (no BE change in G-07 slice) — not a gen:bindings result.
- Backlog (parked): UX-ARC-06 temp browse path bookmarkable, UX-ARC-07 non-repack browse edits without warning, archive-23 temp accumulation.
- Limits declared in SPEC-R1b: remote extract-here hidden (SFTP rename semantics unverified), no pre-flight conflict listing.
- 22:20 cargo slot (team target `/tmp/duet-ux-archive-target`): Sol baseline `--test ux_smoke_archive_sol` 5/5 (probe, locks OLD behaviour — never READY); Opus engine `9b661ac` `--lib -- core::archive_here core::archive_names` 16/16 (`engine-tests-9b661ac.log`). Slot released.
- Main early review relayed to Opus: password retry must keep batch protect list; don't over-claim atomicity (placeholder rename, bulk child rename, external writers / ancestor symlink races); add batch merge full-undo regression.

## CHECKPOINT (usage limit ~94%, written 22:30)

**Done / READY**
- G-07 / UX-ARC-08 (archive-15, browse-32, browse-34): `ddf352f`+`eb183e0` (ux-smoke/archive), 2 rounds, Sol APPROVE R2. Main integrated as `8fa018a`+`cc0bd8f`.

**In flight**
- ux-archive-opus (w3:p2, `/tmp/duet-ux-smoke-worktrees/archive-opus`, ux-smoke/archive-opus): engine `9b661ac` committed (true extract-here, `core/archive_here.rs`, `archive_names.rs`; 16/16 lead-run cargo). Uncommitted: each-to-folder batch (`archive_batch.rs`), commands (`fs_extract_here`, `fs_extract_here_retry`, batch plan) in `fs_ops.rs`/`lib.rs`, FE (`extractActions.ts`, `ExtractConflictDialog.tsx`, password FIFO in `extractPending.ts`/`useTaskEvents.ts`/`App.tsx` dialog block), i18n. Must also fix MAIN review: (1) retry keeps batch protect list + test, (2) docs must not over-claim atomicity, (3) batch merge full-undo regression. Then Addendum A (palette, after shell `4f80d38`; i18n keys BEFORE `cmd.file.calcSize`). Report → `archive-opus/_report/opus-R1.md`.
- ux-archive-sol (w3:p3): static review of `9b661ac` in progress (see below); full R1 review when Opus commits.
- Research acceptance test `research/repro-tests/primary-repro.test.tsx.txt` Part A: research-sol adapting to /extract/i IPC + dialog confirm; needs commit hash + item ids + dialog component name from lead.

**Pending cargo (team target `/tmp/duet-ux-archive-target`, queued FIRST at research)**
- After Opus commits next slice: `cd <detached copy>/src-tauri && CARGO_TARGET_DIR=/tmp/duet-ux-archive-target CARGO_BUILD_JOBS=2 cargo test --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 --lib -- core::archive_here core::archive_names core::archive_batch core::archive` (run from `git worktree add --detach /tmp/duet-ux-smoke-worktrees/archive-test <sha>` — reuse existing detached tree: `git -C /tmp/duet-ux-smoke-worktrees/archive-test checkout --detach <sha>`). Then gen:bindings in that tree for tsc (lead-run; report it as real gen output only if it ran). Send "cargo done archive" after.

**Next steps**
1. Opus done → lead cherry-picks `ux-smoke/archive-opus` commits onto `ux-smoke/archive`, runs cargo above + focused vitest (`--maxWorkers=1 --minWorkers=1`) + acceptance Part A.
2. Sol R1 review of the batch (guarantees per main: no-replace only vs items existing at reservation; cooperating tasks serialized; external writers/ancestor symlink = best-effort).
3. ≤3 rounds; on APPROVE append to READY.json, notify research.
4. Final `REPORT.md` (fixed IDs, commits, tests, limits: remote extract-here hidden, no pre-flight conflict listing, Windows symlink placement unverified; backlog UX-ARC-06/07, archive-23).
- CHECKPOINT 2: Opus BE fully committed on ux-smoke/archive-opus: `9b661ac` engine, `eba92c6` batch plan + KeepBoth reserves at execute, `ce08b80` pre-check, `377ab7e` batch commands, `0c18851` review fixes (protected sources, honest guarantees), `d5c8309` retry keeps batch protection. FE WIP (uncommitted) saved: `wip/opus-wip-2209.patch` + `wip/opus-untracked-2209.tgz` (ExtractConflictDialog.tsx, extractActions.ts, extractNotices.ts). Detached test tree moved to `d5c8309`; cargo requested (`--lib -- core::archive`, then clippy --lib, then gen:bindings).
- CHECKPOINT 3 (lead hit usage limit): Opus stopped at limit. Branch ux-smoke/archive-opus = BE `9b661ac..d5c8309` (main's 3 fixes done, tests written not yet run beyond 16/16 engine) + WIP FE `225ceeb`, `cd072c2` (NOT type-clean). Remaining TODO + cargo list in `opus-R1.md`. Cargo queued #1 at research ("archive go" pending) — run list in opus-R1.md from the detached tree at `d5c8309` (`/tmp/duet-ux-smoke-worktrees/archive-test`). Nothing new READY. Sol doing static review → `archive-sol/_report/sol-review-here-R1-static.md`.

## RESUME (02:05 KST, 2026-11-11)
- Sol static review of extract-here BE `9b661ac..d5c8309`: **CHANGES** (`sol-review-here-R1-static.md`): P1 journal-push failure leaves changes un-undoable (bounded mitigation asked; full WAL = cross-cutting backlog), P2 leftover staging path lost on non-Io errors, P2 placeholder wording. This counts as review round 1 of the extract-here batch.
- Opus resumed: (A) finish FE type-clean + vitest + acceptance Part A, (B) Sol #2/#3 + #1 mitigation, (C) palette last.
- Cargo slot A granted: running `--lib -- core::archive` at `d5c8309` (detached `/tmp/duet-ux-smoke-worktrees/archive-test`), then clippy, then gen:bindings + tsc.
- Slot A results at `d5c8309`: `core::archive` 118 pass / 0 fail / 22 ignored (`_be-tests-d5c8309.log`); clippy `--lib --tests -D warnings` exit 101: new `archive_batch_tests.rs:450` needless_range_loop (Opus fixing) + baseline `fs/local.rs:637` (user WIP area, untouched) (`_clippy-d5c8309.log`); REAL gen:bindings OK (`_gen.log`) → copied into archive-opus tree replacing hand patch. "cargo done archive" sent.
- 02:20 Opus done: ux-smoke/archive-opus `9b661ac..d37f5be` (12 commits; WIP squashed; Sol R1 #1-#3 + main fixes + palette Addendum A). Cherry-picked onto ux-smoke/archive as `df32c91..fe719d7` (on top of G-07). Lead tree: tsc 0 (real bindings from d5c8309), vitest 7 files / 51 pass single-worker (extract actions/dialogs/commands/entryMenu + G-07 store + archive-notice).
- Sol ROUND 2 review assigned (full validation + invert baseline tests as patch). Cargo at d37f5be requested (archive next). Research-sol running acceptance Part A on d37f5be.
- 03:20 lease A @905bc2f: `core::archive` 121 pass / 0 fail / 22 ignored (`_be-tests-905bc2f.log`); clippy only baseline `fs/local.rs:637` (`_clippy-905bc2f.log`). d37f5be's test build had not compiled (E0382 in a new test) → fixed in 905bc2f (lead branch `c98159f`). "cargo done archive" sent.
- 03:30 Extract-here batch: R1 (Sol static) CHANGES → R2 (Sol full, `sol-review-here-R2.md`) **CHANGES**: P1 folder-mode Replace can move a selected source (`a.zip.gz`+`a.zip`), P1 password FIFO mounted-state carry-over + late close, P2 rollback stat-error honesty. **R3 (last) assigned to Opus**; required tests per main: real-tempdir byte preservation, rendered A→Cancel→B + late submit, injected PermissionDenied failed rollback. No R4: if R3 still CHANGES, batch stays unintegrated.
- Research acceptance Part A **PASS** on 905bc2f (`research/sol-acceptance.md` R3c/R3d) — mocked FE, does not override blockers.
- Lead branch: baseline `4cc4fea` + Sol inverted regressions `a6b867d` (FE 2/2 pass; Rust part unrun, include in next lease).

## CHECKPOINT 4 (lead usage limit, ~03:55)
- Extract-here batch R3 (LAST): Sol **APPROVE** (`sol-review-here-R3.md`; tsc 0, vitest 4 files/28 pass). Research acceptance Part A PASS (905bc2f; re-run on 37d3ec5 by research-sol in progress).
- Lead branch ux-smoke/archive head `37d3ec5`. Batch commits for READY (after G-07 already integrated): `df32c91 caf1a50 e1653b7 8b1756b 9fd81a6 c767fde 4b33b2a d5a9927 d5de6b6 e5505cc 95b6d67 fe719d7 c98159f 4cc4fea a6b867d dd8b394 785889b 37d3ec5`.
- Lease B @37d3ec5: clippy ran → only baseline `fs/local.rs:637`. The two test commands first failed on a lead shell-quoting bug (did not run); rerun IN PROGRESS → logs `/tmp/duet-ux-smoke-worktrees/archive-test/_be-tests-37d3ec5.log`, `_smoke-37d3ec5.log`. **"cargo done archive" NOT yet sent — send it when they finish.**
- NEXT: if both logs show 0 failed → append batch to READY.json (cite sol-review-here-R1-static/R2/R3, research/sol-acceptance.md R3c/R3d, logs) and notify research; then final REPORT.md. If any failure → not READY; report exact blocker (no R4).
