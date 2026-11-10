# browse status

Workspace w6 · lead ux-browse-lead (w6:p1, Opus 5.5) · ux-browse-opus (w6:p2, claude-opus-5-5, --permission-mode auto) · ux-browse-sol (w6:p3, codex gpt-6.1-sol high, -s workspace-write).
Worktrees /tmp/duet-ux-smoke-worktrees/browse{,-opus,-sol} on ux-smoke/browse{,-opus,-sol} @ 76b9b6e.

## Inventory (2026-11-10, base 76b9b6e)

Still-open browse issues with failing repro tests on base (it.fails / #[ignore] — static repro, mocked IPC for FE):
browse-03 hidden-by-filter selection still operated on (P2) · browse-08 markdown link navigates app window (P2) ·
browse-09 cursor-only size calc computes wrong folder (P2) · browse-15 failed listing shown as "empty folder" (P2) ·
browse-12 shared watcher dropped when one pane leaves (P2, Rust) · browse-13 fs events not coalesced (P2) ·
browse-16 thumbnail cache not busted (P3) · browse-20 late size result attaches to other folder (P3) ·
browse-25 glob `[!a]` (P3) · browse-26 session not flushed on close (P3) · browse-28 size sort ignores computed sizes (P3) ·
browse-19/21/27 fs/local.rs (blocked: user's uncommitted local.rs — not touched) · browse-32/34 archive-browse nav (ask archive lead) ·
browse-02/17/22 remote edit (ask remote lead) · browse-07 big unknown-ext text preview freezes UI · browse-18 remote du 0 B.
Not covered by prior review: search panel, frecency jumper, tags, selection none/single/multi/mixed in remote/archive contexts.

## Round 1 assignments
- opus: FE fixes batch A (03, 08, 09, 20, 25, 28, 16, 26) — remove it.fails as regression tests.
- sol: baseline smoke of uncovered areas (search, jumper, tags, bookmarks, multi/mixed selection across contexts) → browse/sol-smoke-r1.md; then review opus commits.
- lead: browse-15 / browse-12/13 triage, coordination.

## Ownership decisions (2026-11-10)
- Taken from sync routing: SC-18 (reindex ignores new local files), SC-20 (content search ignores size/date/kind filters), SC-25 (index cache filename collision),
  SC-27 (filename search ignores hidden exclusion), SC-42 (search status text/↑↓), SC-48 (jumper: remote label/key collision/stale dirs), SC-49 (8MiB silent skip, ignore-glob FE/BE mismatch),
  SC-19 partial (in-progress/duplicate build guard only; drive scope/persistence = product decision, not in scope). F-sol-05/06/08/11/12 → verify-current-state by sol.
- Declined: SC-29 (remote newline names) → remote lead's core/search.rs -print0 fix (remote-25). SC-26 already fixed in fix round (persist).
- Not editing core/search.rs (remote lead). Selection contract: browse-03 aims for no signature change; fileops/archive/shell will be notified before any change.
- Routed: browse-32/34 → archive (G-07, likely their R2). browse-18, browse-02/17/22 → remote (fs/ssh.rs, services/edit_session.rs).
- ESCALATION to main: browse-19/21/27 live in src-tauri/src/fs/local.rs which has the user's uncommitted change; browse will not edit it (merge into main checkout would collide). Deferred unless main says otherwise.
- Lead implements SC backend items in /tmp/duet-ux-smoke-worktrees/browse (ux-smoke/browse); sol report path: browse-sol/ux-smoke-reports/ (copied here by lead).

## Lead note to main (2026-11-10)
- Read-tool block on /tmp/duet-ux-smoke-worktrees/browse: lead works there through Bash (git/python edits, cargo/pnpm) which is permitted; no restart needed.
  If main prefers --add-dir restart: lead session id 53a9ded0-225a-430c-bdf0-0af685b49c92.
- ACK main: local.rs 19/21/27 deferred. core/search.rs: lead edits only LocalContentSearch body (SC-20), remote lead informed.

## Progress (R1, 2026-11-10)
- Lead commits on ux-smoke/browse (UNTESTED — cargo frozen by main, queued #1 in research/CARGO_QUEUE.md): ccfc5db SC-20, 0fba4eb SC-18/27/25 (+ un-ignored F-sol-04/05/08/11 and F-sol-06). Not ready.
- Opus commits on ux-smoke/browse-opus: 6bf87a3 browse-03 (selection pruned on filter; trade-off: pruning is permanent like the hidden toggle — needs product ack), cf94e9b browse-08. Remaining batch A in progress.
- Sol phase 1 done → browse/sol-smoke-r1.md. New (research IDs): UX-BRW-05=s01 stale search result clickable, UX-BRW-06=s02 closing pending content search never cancels backend,
  UX-BRW-07=s04 jumper Enter opens previous query's folder, UX-BRW-08=s06/s07 swap/move tab during listing loses navigation, UX-BRW-09=s11 Ctrl+D on bookmarked SSH folder re-adds.
- Plan R1b (opus, after batch A): UX-BRW-05, 06, 07, 09 (cheap FE). UX-BRW-08 if cheap. Parked backlog: SC-42 keyboard traversal, SC-48, SC-49, SC-19, UX-BRW-01 (policy), UX-BRW-04 (doc), browse-07/12/13/15.
- Lead branch ux-smoke/browse now: ccfc5db SC-20, 0fba4eb SC-18/27/25 (cargo pending), 7d10ad9 sol repro tests, 524a2b6 UX-BRW-09 (vitest s11 pass; negative control fails without fix), f66dd0e probe update (isolated rustc: s08/s09 pass).
- Sol review R1 started on opus 6bf87a3/cf94e9b/86444ef(+later) and lead 524a2b6/ccfc5db/0fba4eb. Opus R1b queued: UX-BRW-05/06/07 (+08 if cheap).

## CHECKPOINT (lead, near usage limit)
- Main ACK: browse-03 pruning accepted; no new defects to be added to fix set.
- opus branch ux-smoke/browse-opus (batch A complete): 6bf87a3 b-03, cf94e9b b-08, 86444ef b-09, 6dece77 b-20, 6d2b005 b-25, 7baf001 b-28, 49f2413 b-16, 14d173a b-26, 6a4780f (cherry-pick of sol tests), 7ac5445 UX-BRW-05. R1b in flight (UX-BRW-06/07, 08 if cheap).
- lead branch ux-smoke/browse: ccfc5db SC-20, 0fba4eb SC-18/27/25, 7d10ad9 sol tests, 524a2b6 UX-BRW-09, f66dd0e probe.
- Sol review R1 in flight → browse-sol/ux-smoke-reports/sol-review-r1.md (copy to browse/sol-review-r1.md).
- Cargo slot B granted 2026-11-10: running in /tmp/duet-ux-smoke-worktrees/browse with CARGO_TARGET_DIR=/tmp/duet-ux-browse-target:
  cargo test --lib file_index core::search + --test review_sync_compare_sol (opt-level=0, debug=0, JOBS=2). Send 'cargo done browse' to research after.
- Next: Sol verdicts → fix CHANGES (max 3 rounds) → READY.json with approved FE SHAs first (opus batch A + 524a2b6), BE after cargo pass + review.
- If lead is cut off: ux-browse-sol keeps reviewing; main can integrate approved SHAs listed in sol-review-r1.md.

## PAUSE CHECKPOINT (2026-11-11 02:00 KST, lead)
- Paused on user instruction; resume only on main's nudge after 02:05 KST. Workers told to hold. No cargo/vitest running. Nothing uncommitted in browse or browse-opus trees.
- Cargo: lib run PASSED in lead tree (`cargo test --lib -- file_index core::search` → 35 passed, 0 failed, 1 ignored; log /tmp/duet-ux-smoke-worktrees/browse-lead-cargo-lib.log). Slot released ('cargo done browse').
  Still to run (queue behind archive): `cd /tmp/duet-ux-smoke-worktrees/browse/src-tauri && CARGO_TARGET_DIR=/tmp/duet-ux-browse-target CARGO_BUILD_JOBS=2 cargo test --offline --config 'profile.test.package.duet.opt-level=0' --config 'profile.test.package.duet.debug=0' --test review_sync_compare_sol`
- opus ux-smoke/browse-opus: batch A done (6bf87a3, cf94e9b, 86444ef, 6dece77, 6d2b005, 7baf001, 49f2413, 14d173a) + R1b done: 7ac5445 UX-BRW-05, b0c1d18 UX-BRW-06, 4c4e966 UX-BRW-07, 8aedae0 UX-BRW-08 (6a4780f = sol tests cherry-pick).
- lead ux-smoke/browse: ccfc5db SC-20, 0fba4eb SC-18/27/25, 7d10ad9 sol tests, 524a2b6 UX-BRW-09, f66dd0e probe.
- Sol review R1: started, NO report file yet (sol-review-r1.md missing; partial logs in browse-sol/ux-smoke-reports/review-r1-*.log/json). Nothing is approved → no READY.json yet.
- NEXT on resume: (1) prompt ux-browse-sol to finish review R1 and also cover opus R1b SHAs 7ac5445 b0c1d18 4c4e966 8aedae0; (2) fix CHANGES findings (round 2, max 3); (3) READY.json with approved SHAs (FE first, BE after the review_sync_compare_sol cargo run); (4) final report browse/REPORT.md.

## RESUMED (2026-11-11 02:05+)
- Sol R1 verdict (browse/sol-review-r1.md): APPROVE 14 SHAs; CHANGES cf94e9b (Enter on link), 0fba4eb (global publish overwrites reindex; Unicode cache-name bytes), 49f2413 (thumbnail failure identity). F4 failures = shell UX-SHL-07 (on main), not browse.
- Lead consolidated opus commits onto ux-smoke/browse (cherry-picks, clean). R2 fixes: 0ba87da (Enter), 997facb (thumb URL identity), 8f9547e (reindex overlay + ASCII cache name; cargo pending).
- READY.json FE1 written (12 SHAs) after dry-run on main 62c6c37: tsc 0, 15 files/184 passed. Main notified.
- In flight: Sol R2 review (0ba87da, 997facb, 8f9547e). Cargo browse run queued #2. Opus idle (bounded set done).

## CHECKPOINT (lead, usage limit, ~04:00 KST 2026-11-11)
- FE1 (12) and FE2 (4) integrated by main. FE work complete.
- BE set (ccfc5db, 0fba4eb, f66dd0e, 8f9547e, 7615754) NOT integrated. Sol R3 (final): APPROVE 7615754 "static + probe, Cargo pending" (browse/sol-review-r3.md).
- Only remaining blocker: the R3 cargo run (queued in research/CARGO_QUEUE.md, request 03:20). Exact command when 'browse go' arrives:
  cd /tmp/duet-ux-smoke-worktrees/browse/src-tauri && CARGO_TARGET_DIR=/tmp/duet-ux-browse-target CARGO_BUILD_JOBS=2 cargo test --offline --config 'profile.test.package.duet.opt-level=0' --config 'profile.test.package.duet.debug=0' --lib --test review_sync_compare_sol -- file_index core::search search index
  If green → add BE batch to READY.json (order ccfc5db 0fba4eb f66dd0e 8f9547e 7615754) and send 'cargo done browse'. If red → leave BE unintegrated (no R4) and record the failing test.
- Workers idle (opus done, sol done). Final report: browse/REPORT.md (fill R3 row + cargo result).
