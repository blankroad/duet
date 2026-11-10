# remote — status

Updated: 2026-11-10 22:10

## Team (w7)
- w7:p1 ux-remote-lead (Opus 5.5) — /tmp/duet-ux-smoke-worktrees/remote, ux-smoke/remote
- w7:p2 ux-remote-opus (Opus 5.5, --permission-mode auto) — remote-opus, ux-smoke/remote-opus
- w7:p3 ux-remote-sol (codex gpt-6.1-sol, -s workspace-write) — remote-sol, ux-smoke/remote-sol

## Inventory (base 76b9b6e)
Still open from 2026-11-08 (by #[ignore]/it.fails markers): 02, 03, 04, 05/06/07 (G-10), 08, 10, 11/25, 12, 13, 14, 16, 18 (G-20), 23/24, 27, 28-33.
Fixed earlier: 01, 17, 19, 21, 22, 26, 35. Full table in BRIEF.md.
Live SSH env: Docker Desktop was not running; lead started it (`open -a Docker`) for the sshd fixture.

## Round 1 plan (evidence-backed, user-workflow breakage first)
- opus: live docker smoke baseline; G-10 (remote-05/06/07: session lock + connect deadline + exec cancel); remote-03 (symlinks listed as files).
- lead: small FE/BE fixes — remote-30 (user with '@'), remote-27 (refresh after auto-reconnect), remote-10 (clipboard/shelf rebind on reconnect), remote-12 (sudo staging parent), remote-11/25 (remote find; coordinating with browse).
- sol: independent inventory of remote entry points × selection × failure, then review.
- Out of scope / contract (to main): remote-02/04 (G-11 identity), remote-13 (config parser, large).

## Commits (ux-smoke/remote)
| commit | what | review |
|---|---|---|
| 7ba7bcc | remote-30 user with @ | Sol APPROVE (R1) → **integrated main 513f16d** |
| bb2fe92 | remote-27 refresh after auto-reconnect | Sol APPROVE (R1) → **integrated main 6cd9f11** |
| 33b9199, 1cbebca | Sol repros NEW-1/2/3 (+tsc fix) | Sol APPROVE → **integrated main 670bf88, 62a9702** |
| 445bc89 + a40e48d | remote-NEW-3 (UX-REM-05) prototype-named aliases | R1 CHANGES → fixed in a40e48d, R2 review pending |
| 2c09d18 | remote-NEW-1 (UX-REM-03) save failures reported | R1 review pending |
| c9cf480 | remote-NEW-2 (UX-REM-04) Disconnect on saved hosts | R1 review pending |
| 0454ba0 | Sol review tests | pending |
| (uncommitted) | remote-11/25 find, remote-12 sudo staging | waiting cargo slot (#6) |

Opus worker: G-10 (session lock/deadline) in progress; remote-03 approved by sync lead with conditions (pure token swap in three_way.rs, link-leaf tests, audit of all walkers). Cargo-gated.

## Backlog (parked, verified elsewhere)
remote-02/04 (G-11, main), UX-REM-02 restored-tab toolbar actions, palette/keymap Disconnect command, browse-02/17/18/22 (routed to remote), remote-13/14/16/18.


## CHECKPOINT (usage limit, ~22:30)
- FE batch 2 on ux-smoke/remote (in order): 445bc89, 2c09d18, c9cf480, a40e48d, 0454ba0, 3cd94c5, 10719a8.
  Sol R2: APPROVE 2c09d18 (NEW-1), a40e48d (NEW-3 complete), 0454ba0; CHANGES c9cf480 → fixed in 3cd94c5 (+ tests 10719a8). R3 review handed to Sol
  (/tmp/duet-ux-smoke-worktrees/remote-sol/_report/HANDOFF-R3-FE.md); Sol writes review-r3-fe.md + READY-batch2.json there and notifies main directly. Copy into this folder when approved.
  Reports: sol-review-r1-fe.md, sol-review-r2-fe.md here.
- Uncommitted lead Rust work saved: wip-lead.patch (remote-11/25 find builder+tests in core/search.rs; remote-12 sudo staging in core/sudo.rs). Not compiled yet.
  Next: `cd /tmp/duet-ux-smoke-worktrees/remote/src-tauri && CARGO_TARGET_DIR=/tmp/duet-ux-target-remote CARGO_BUILD_JOBS=2 cargo test --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 --lib core::search core::sudo` (when research grants remote slot, queue #4), then commit, then Sol review.
- Opus (ux-smoke/remote-opus): G-10 commits 1a08cd1, 4067083, 2f1ca61, 0cc062d + fixups 800dc31, 00a8a00, ebcc8fb (uncompiled); remote-03 in progress (uncommitted; asked to save wip-opus.patch + _report/opus.md). Next cargo (team target /tmp/duet-ux-target-remote): `--lib ssh:: fs::ssh services::connection_pool core::search services::retry`, then docker IT `--test 'ssh_it_*' --test review_remote_opus_handle --test review_remote_opus_chaos -- --ignored --test-threads=1` (container duet-remote-opus-ssh :2232). G-10 also needs main's full lib+clippy gate.
- Sol cargo pending: `--lib ssh::` (same target, after lead).


## PAUSE checkpoint (2026-11-11 02:01 KST) — resume after 02:05 + main nudge
- No running cargo/vitest for remote team.
- Lead branch ux-smoke/remote head 10719a8; uncommitted core/search.rs + core/sudo.rs saved as wip-lead.patch (uncompiled).
- Opus branch ux-smoke/remote-opus: all committed, uncompiled (rustfmt clean): d93f9f7; G-10 1a08cd1(+800dc31), 4067083(+00a8a00), 2f1ca61, 0cc062d(+ebcc8fb);
  remote-03 85a9708, 23c08ea(+e97bb74), 9fe7819. Audit table + next cargo commands: /tmp/duet-ux-smoke-worktrees/remote-opus/_report/opus.md.
- Sol: R3 FE review NOT started yet (HANDOFF-R3-FE.md pending).
- Next on resume: (1) Sol R3 review of 3cd94c5+10719a8; (2) request remote cargo slot → lead `--lib core::search core::sudo`, then Sol `--lib ssh::`, then Opus lib + docker IT; (3) Sol review of G-10 and remote-03.


## 02:20 KST
- FE batch 2 integrated by main: 59418e7 f631500 1e47531 2cc4f01 96a0742 8173e0a 62c6c37 (Sol R3 APPROVE). FE work done.
- Remaining (bounded): BE — lead remote-11/25 + remote-12 (wip-lead.patch, uncompiled); Opus G-10 + remote-03 (uncompiled). Sol static BE review R1 in progress. Cargo queued #4 (research).
- remote-03 dependency: sync lead will make sync_execute/sync_preview reject Relay plans (sync R2, hash TBD); our 9fe7819 (SshFs Dir classification) must integrate AFTER it. We token-swap count_files + preview_copy_walk/preview_prune_walk to list_for_walk; mirror_dir/prune_pass untouched (sync SC-06).
- Sol BE R1 (static) CHANGES: B1 channel-open timeout leak (Opus), B2 list_for_walk lstat-error fail-closed (Opus), B3 sync guard on effective sources → sync 912bf01 (ux-smoke/sync-opus; derives from decide_fs on actual sources; uncompiled, sync Sol R2 pending). 9fe7819 depends on 912bf01 being integrated first.

## 03:50 KST
- Lead BE: ababa6d (remote-11/25), 6a8330d + fixup 2fa109f (remote-12 + staging shape guard). Sol static APPROVE (review-lead-be-r1). Executed: core::search+sudo 32/0 (before guard). Pending step (7): core::sudo re-run + docker r12/c21.
- Opus BE: G-10 + remote-03 + B1/B2 fixups; executed lib 77/0, docker IT 21/0, walk_links 9/0, sftp_links 1/0, Sol ssh:: 40/0. Two test-bug fixups (bd8e57b chaos, 0a9f59b ops mock) → step (8) re-run. Sol: B1/B2 APPROVE; 9fe7819/fe126e2 APPROVE conditional on sync 912bf01 integrated first.
- Next: steps (7)+(8) on next free slot → autosquash → cherry-pick Opus onto ux-smoke/remote → Sol final check → READY BE (G-10 needs main full lib+clippy gate).

## 03:57 KST checkpoint (lead usage limit)
- Slot A granted 03:55. Step (7) running (lead script /tmp/duet-ux-smoke-worktrees/remote/.step7.sh → .step7.log). Opus instructed to run step (8) after EXIT_C21 appears, then send "cargo done remote".
- Sol instructed: BE R2 = independent assessment of test-bug fixups bd8e57b, 0a9f59b + rerun evidence → remote-sol/_report/review-be-r2.md, notify main.
- Remaining for lead: copy review-be-r2.md; autosquash lead (2fa109f→6a8330d) and Opus fixups; cherry-pick Opus BE onto ux-smoke/remote with 9fe7819 after sync 912bf01; BE READY entry with all final hashes; final REPORT (lead.md) + backlog.
- step7: test result: ok. 10 passed; 0 failed; 2 ignored; 0 measured; 746 filtered out; finished in 0.02s
- step7: EXIT_SUDO=0
- step7: EXIT_R12=1
- step7: EXIT_C21=1
- step7 docker r12/c21 did NOT run: HOME override hid rustup toolchain (script bug). Re-run handed to Opus with RUSTUP_HOME/CARGO_HOME set.
