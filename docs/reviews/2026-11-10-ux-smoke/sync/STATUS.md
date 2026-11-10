# sync status (lead: ux-sync-lead, w8:p1)

- 2026-11-10 setup: worktrees /tmp/duet-ux-smoke-worktrees/{sync,sync-opus,sync-sol} on ux-smoke/* @ 76b9b6e.
  Workers: ux-sync-opus (w8:p2, claude --model claude-opus-5-5 --permission-mode auto),
  ux-sync-sol (w8:p3, codex -m gpt-6.1-sol -c model_reasoning_effort=high, default sandbox).
- Scope: compare / apply / merge / 3-way / sync (+ their dialogs, entry points). Search/index/jumper = browse.
- Prior state: SC-03/04/17/22/28/40 fixed in fix-round. Still-open with `#[ignore]` / `it.fails` repros:
  SC-01 (G-08), SC-02 (D-7 pending user decision), SC-05, SC-06, SC-07, SC-08, SC-10, SC-13, plus FE SC-11/14/15/16 etc.
- Phase 1 (now): opus = Rust smoke baseline of ignored sync repros + action/entry inventory;
  sol = FE focused vitest baseline + entry-point/selection matrix (static vs mocked-test labelled).
- Constraints: CARGO_BUILD_JOBS=2, one Rust build at a time in this team, no edits to fs/local.rs (user WIP).
- Phase 1 note: sol's offline `pnpm install` failed (store missing @crabnebula/tauri-plugin-drag); lead ran
  `pnpm install --frozen-lockfile --prefer-offline` (lockfile unchanged) in sync and sync-sol trees; sol resumed.
- Ownership agreed: fileops owns undo.rs/journal.rs/task_queue/shared copy-move-delete; sync owns compare.rs,
  three_way.rs, sync_*/merge_bidir/apply_compare in ops.rs + dialogs. Search/index/jumper → browse (research confirmed).
  SC-06 needs fs/local.rs → escalate hunk to main; SC-02 blocked on D-7.
- Static (lead): SC-07 still present — `merge_bidir` re-runs `compare_dirs` with no rules (ops.rs:1886).

## Phase 1 results (~22:05)
- Rust repros: NOT RUN (cargo freeze; sync-opus PID 66616 SIGINT'd by lead per main). Static classification of 33
  ignored repros: 20 still failing, 2 stale ignores (SC-03 guard), 2 obsolete, 3 env-only, 6 out of scope (browse/remote).
  Detail: opus-baseline.md. FE: sol-fe-baseline.md (entry-point × source matrix, static + mocked).
- bindings.ts (gitignored, generated after base) copied from main checkout into sync trees so vitest can import.
- Cargo: sync queued #3 in research/CARGO_QUEUE.md.

## Round 1 (in progress) — opus implements, sol writes acceptance criteria then reviews
Targets: SC-11 (2s tolerance default with SSH), SC-16 (3-way base default empty + base/left/right guard),
SC-08 (apply checks source before .bak), SC-05 (3-way unreadable ≠ deleted), SC-07 (merge uses dialog rules;
IPC/binding change), SC-01 (sync partial journal + restore .bak; local path only).
Backlog (parked): SC-02 (D-7), SC-06 (needs fs/local.rs — hunk to main), SC-10, SC-12, SC-13, SC-14,
SC-15/UX-SYN-01 (D-8), SC-35, FE-02 nested-root compare offers failing actions, FE-03 archive-browse compare
mutations (archive coord), SC-43, SC-23/33/34/46, 2 error strings, same-host rsync partial failure.
- Coordination (remote-03): remote owns new FileSystem::list_for_walk (fs/mod.rs default + SshFs) and swaps it into
  compare.rs compare_into, three_way.rs walk, ops.rs collect_backup_files (dir links become leaf rows). Expected
  trivial merge conflict in three_way.rs walk with sync SC-05 (keep both: list_for_walk + SC-05 error handling).
  SC-06 backlog can later reuse list_for_walk instead of editing fs/local.rs.
- Integration rule (main): only Sol-approved focused commits go into sync/READY.json (ordered SHAs, fixed IDs,
  exact tests, reviewer report path) + short note to main. No baseline probes / unreviewed changes / local.rs.
  Round counter: batch R1 = round 1 of max 3 (implementation in progress, 0 reviews so far).
- Browse confirmed: no Compare*/merge edits; SC-07 = sync, SC-35 = sync backlog. browse-03 fix lives in panes.ts setFilter (no overlap).
- Resource rule: vitest --maxWorkers=1 --minWorkers=1, one FE test process per team (opus priority); idle when done.
- Sol can't commit (index.lock outside sandbox): Sol hands patches via <tree>/_report/<id>.patch; lead commits. Opus (Claude) commits itself.
- Research dedup: FE-01 = SC-07 (no new ID); FE-03 ≈ UX-ARC-07 (archive, parked); FE-02 → UX-SYN-02 (sync backlog).
  bindings.ts already copied (~22:00) so the 9 import-failed suites are re-runnable; sol re-running focused files.
- review_sync_compare_sol.rs: browse edits it (SC-20); sync round 1 does not touch it.
- Browse commits 0fba4eb/ccfc5db (ux-smoke/browse) remove 5 #[ignore] lines in review_sync_compare_sol.rs (search items only).
- ~21:57 sol: focused FE rerun with bindings: 10 files / 51 tests green incl. 14 it.fails still expected-failing
  (mocked-FE-test reproduced: SC-11, SC-14, SC-23, SC-33, SC-34, SC-38, SC-43a/b, SC-46, SC-48 + 2 error strings).
  Round-1 acceptance criteria: sol-round1-criteria.md. Sol idle until opus hands off.

## CHECKPOINT (~22:20, Claude usage ~94%, resets 02:00 KST)
Done commits (ux-smoke/sync-opus, UNREVIEWED — not READY):
- 863d38d fe/lib SC-11 (±2s tolerance when a side is remote)
- b3fb471 be/core SC-16 (reject 3-way base equal/nested with left/right)
- ac5554e be/core SC-08 (apply checks source before .bak)
- 093db91 be/core SC-05 (3-way unreadable folder marked, not empty)
- 487ffca be/cmd SC-07 (merge re-compares with dialog rules; IPC change → bindings regen needed)
In flight: ux-sync-opus = SC-16 FE part? + SC-01 (sync partial journal/.bak restore); results → REVIEW-sync-round1.md in its tree.
ux-sync-sol = idle; criteria in sol-round1-criteria.md. Next: review opus commits vs criteria → REVIEW-sync-round1-review.md.
Pending cargo request (queued #3): in /tmp/duet-ux-smoke-worktrees/sync-opus/src-tauri:
  CARGO_BUILD_JOBS=2 cargo test --test review_sync_compare_apply --test review_sync_compare_xcheck_opus \
    --test review_sync_compare_xcheck_sol --test review_sync_compare_r3_sol -- --ignored
  CARGO_BUILD_JOBS=2 cargo test --lib three_way review_sync_failure_ apply_compare merge_bidir sync_
  then pnpm gen:bindings && focused vitest (--maxWorkers=1 --minWorkers=1).
Next step if lead is cut off: main can have sol review 863d38d..487ffca (+ SC-01 commit) against
sol-round1-criteria.md; Rust correctness is static-only until the cargo run. Nothing is in READY.json yet.
- ~22:25 checkpoint artifacts: opus-commits/0001-0005*.patch (format-patch of 863d38d..487ffca);
  wip-sync-opus-uncommitted.patch (SC-01 in-progress diff, ops.rs +87/-21, NOT committed, NOT reviewed).
  Opus told to commit SC-01 only if coherent + write REVIEW-sync-round1.md. No model substitution.
- ~22:35 opus committed a3a271c be/core SC-01 (sync failure/cancel journals partial work + restores original);
  report opus-round1.md; patch opus-commits/0001-*SC-01*. Opus hit Claude usage limit (resumes ~02:00 KST).
  Lead also at usage limit. Sol is reviewing 863d38d..a3a271c (6 commits) → sync-sol/REVIEW-sync-round1-review.md.
  NEXT (whoever resumes): copy sol review here; if APPROVE + cargo slot run passes → write READY.json; else round 2.

## PAUSED (user, until main nudges after 2026-11-11 02:05 KST) — checkpoint 02:02 KST
- Branch ux-smoke/sync-opus HEAD a3a271c (6 commits 863d38d..a3a271c, R1). Untracked only REVIEW-*.md. Nothing READY.
- Sol R1 review PAUSED/incomplete (sol-round1-review.md, sol-checkpoint-paused.md). Sol's tree has opus diff applied
  WITHOUT index + reviewer test edit (CompareDialog.test.tsx:209) — reverse steps in its checkpoint.
  Finding so far (mocked FE): SC-11 rules-bar settings prefill overwrites a user-chosen 0ms tolerance with 2000ms.
  Note: SC-01 fix covers local sync only; same-host rsync partial failure unchanged.
- No cargo/vitest running for sync. Both workers told to idle (opus had auto-resumed at 02:00).
- NEXT after nudge: (1) sol finishes R1 review per its checkpoint; (2) opus fixes confirmed findings (SC-11 prefill
  race first) as R2; (3) request cargo slot (commands above); (4) READY.json only on sol APPROVE + evidence.

## RESUMED 02:05 KST
- Target cache: /tmp/duet-ux-sync-target (cp -cR of /tmp/duet-ux-target-ready). Sync queued #3 for cargo.
- Sol: finishing R1 review of 863d38d..a3a271c (holds team FE test slot). Opus: R2 = SC-11 prefill-race fix
  (code only, vitest after sol releases slot).
- Cargo: research recorded 4-step request; sync runs after fileops + browse (archive + shell hold slots). Waiting for 'sync go'.
- R2: opus d165503 fe/ui SC-11 late prefill no longer overrides user-picked tolerance (+ regression test). Vitest pending until sol releases FE slot.
- R1 review (sol-round1-review.md): APPROVE (static Rust) SC-16 b3fb471, SC-08 ac5554e, SC-05 093db91, SC-07 487ffca.
  CHANGES: R1-01 SC-11 explicit 0ms overwritten by late prefill (mocked-FE reproduced) → R2 d165503 + reviewer test;
  R1-02 SC-01 same-host partial failure unjournaled → LEAD DECISION: accept local-only SC-01 this batch; same-host
  stays OPEN in backlog. tsc fails only on generated ThreeWayStatus lacking 'unreadable' → needs gen:bindings in slot.
- R2 started (round 2 of 3): opus applies sol test, hand-syncs local bindings for tsc, SC-01 conservative stat record.
- Coordination remote-03 #2: remote swaps count_files + preview walkers to list_for_walk; sync R2 adds Relay rejection in sync_execute/sync_preview so mirror_dir/prune_pass stay LocalFs-only (SC-06 local stays backlog).
- fileops Batch A on main; Batch B regions (rename/batch_rename, copy/move self-target, task_queue cancel, error.ts, task toasts) don't overlap sync's files/regions — acked.
- R2 commits (opus): d165503 SC-11 prefill skip user-edited, 6083f1a reviewer test (sol, hand-ported), b16b507 SC-01 local
  conservative record, 912bf01 sync relay guard (preview/execute reject unsupported strategy; ops_paths_tests relay preview
  expectation changed → note for main/remote). FE: tsc 0, vitest 5 files/30 passed (hand-edited bindings). Rust: pending slot.
- R2 review by sol started.
- remote-03 depends on sync 912bf01 (effective-source sync guard); remote holds 9fe7819 until 912bf01 is approved + cargo-verified. Ping remote when done.
- R2 review (sol-round2-review.md): APPROVE all — d165503, 6083f1a, b16b507, 912bf01 + re-approve 863d38d, a3a271c (SC-01
  LOCAL-only); R1 approvals stand. Rust static until cargo.
- CARGO SLOT A granted (~02:20): running cargo-r2/run.sh (lib filters, integ, integ --ignored, clippy, gen:bindings) in
  WT sync-opus @ 912bf01, target /tmp/duet-ux-sync-target. Logs cargo-r2/*.log, summary.txt.
- Cargo slot A results so far: step 1 (lib) did NOT run — lead's syntax error (multiple filters need `--`), exit 1, no compile.
  Step 2a: apply 14/14 pass, r3_sol 5 pass/2 ignored, xcheck_opus 4 pass / 1 FAIL:
  sync_cancel_midway_journals_what_was_already_applied (:175 b_changed.txt = 'old', expected 'NEW-content') — un-ignored
  SC-01 repro vs a3a271c behavior. xcheck_sol not run (fail-fast). Opus analyzing read-only. READY blocked.
- Cargo slot A done (~02:30): 1-lib exit 1 (lead filter syntax, not run); 2a exit 101 (SC-01 cancel test fail; xcheck_sol not
  run); 2b exit 101; 3-clippy exit 101 (ONLY baseline fs/local.rs:637 items_after_test_module, blocked lint of test code);
  4-bindings exit 0 (diff vs main copy = fsMergeBidir +rules, ThreeWayStatus +unreadable). Logs cargo-r2/.
- Opus analysis: code is safe — sorted copy order means fixture's 1st rename is a_new's final rename; b never touched.
- ROUND 3 (last): opus writes contract tests per main (cancel at 1st and 2nd rename, journal manifest, real undo with mocked
  trash → dst == pre-sync snapshot, no orphan .bak); code fix only if contract violated. Then sol R3 review (incl. confirm no
  new items_after_test_module in sync code), then lease #2 (queued after archive → shell → fileops): lib with `--` filters,
  integ --no-fail-fast, integ --ignored, clippy -A items_after_test_module.
- R3: opus 84b5845 test: local sync cancel-recovery contract (cancel at 1st/2nd rename, real undo via tests/support/undo_fixture.rs temp trash). Sol R3 review started (static; cargo lease #2 queued).
- R3 review (sol-round3-review.md): 84b5845 APPROVE (static); no new items_after_test_module in the 7 changed Rust files;
  FINAL batch verdict 863d38d..84b5845 (11 commits) = APPROVE conditional on lease #2 (lib, integ --no-fail-fast,
  integ --ignored, clippy -A items_after_test_module) passing. Waiting for 'sync go' (after archive → shell → fileops).
  If lease #2 fails: no 4th round — report the failing item as unresolved and READY only the commits it doesn't affect.
