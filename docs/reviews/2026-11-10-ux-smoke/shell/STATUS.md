# shell — status

Updated: 2026-11-10 ~22:00 (round 1 in progress; cargo frozen by main — shell queued #2 in research/CARGO_QUEUE.md)

## Team (w4)

| pane  | agent             | model                    | WT / branch                                                     |
| ----- | ----------------- | ------------------------ | --------------------------------------------------------------- |
| w4:p1 | ux-shell-lead     | Opus 5.5                 | `/tmp/duet-ux-smoke-worktrees/shell` · `ux-smoke/shell`         |
| w4:p2 | shell-opus        | Opus 5.5 (auto mode)     | `/tmp/duet-ux-smoke-worktrees/shell-opus` · `ux-smoke/shell-opus` |
| w4:p3 | shell-sol         | Codex gpt-6.1-sol (default sandbox) | `/tmp/duet-ux-smoke-worktrees/shell-sol` · `ux-smoke/shell-sol` |

All off base `76b9b6e`. Brief: `BRIEF.md`.

## Work items

| ID | registry | what | owner | state |
| -- | -------- | ---- | ----- | ----- |
| S-01 | UX-SHL-01 | Windows "More options" missing for multi-selection (Bandizip/7-Zip "extract each" on N archives impossible). `App.tsx:758-783` gate `selectedCount === 1`; `shell_menu.rs build_menu` binds one child PIDL | shell-opus | R1 implementing |
| S-02 | UX-SHL-02 / shell-settings-10 | background "More options" is the current folder's item menu, not `CreateViewObject` background menu | shell-opus (main: in scope) | queued after S-03 |
| S-03 | shell-settings-16 | shell menu invoke failure silent (stale token / InvokeCommand Err) | shell-opus (main: in scope) | queued after S-01 |
| S-04 | UX-SHL-04 / fileops-36 | remote Ctrl+C leaves stale local files on OS clipboard. Fix: clear OS clipboard only if it still holds duet's last copy (macOS changeCount, Windows GetClipboardSequenceNumber; Linux no-op) | lead | coded in lead WT; cargo slot granted ~22:20, focused tests running on APFS-cloned target |
| UX-SHL-07 | research | F4 `file.edit` never registered (callback only, since 8c4b836) → F4/palette Edit dead | lead | `4f80d38`+`d6dba8b`; Sol APPROVE (L1 r2); **integrated by main as 88f7d99 / c6aaa3d** |
| UX-SHL-11 / UX-SHL-12 | fileops handoff (smoke labels ux-fileops-03/04; NOT 11-08 fileops-03/04) | DESIGN.md alt keys F8/Shift+F8/Ctrl+Shift+N/Shift+F6 missing; mac no Cmd+Backspace trash | lead | `bd92c6b`; fileops' own 5 repros flip; Sol APPROVE (L1 r1); **integrated as e94719d** |
| — | — | open-with/launchers/reveal/terminal/clipboard/keymap smoke baseline | shell-sol | Phase A done → `sol-phase-a.md`, tests `96ea8eb` (ux-smoke/shell-sol) |

## Contract change (main ACKed)

`shell_menu_open(path: PathBuf, scope)` → `shell_menu_open(paths: Vec<PathBuf>, scope)`; same for `shell_menu_warm`.
`shell_menu_invoke(token, cmd_id)` unchanged. Backend validates non-empty + same canonical parent → typed `DuetError`.
Cache key = (ordered paths, scope). Absolute PIDLs + parent owned by the cached session until drop (alive through
QueryContextMenu and InvokeCommand). Stale/evicted token → rejected, never resolved to another menu.
Only callers: `src/lib/shellMenu.ts` (used by `App.tsx`, `useShellWarm.ts`). Bindings regenerated (`pnpm gen:bindings`).

## Coordination

- archive: shell does not edit `entryMenu.tsx` / `fileActions.ts` / archive dialogs. AR-05 palette ids `file.extract`/`file.compress` — archive adds them to `commands.ts` (after `file.calcSize`, no default key, ko+en i18n); shell reviews.
- fileops: shell does not edit `entryMenu.tsx` / `fileActions.ts`; any needed diff goes to fileops first.

## Platform limits

- macOS/Linux: no native "More options" menu at all (Windows-only by design) — platform limit, not a bug.
- Windows runtime (COM multi-PIDL, Bandizip verbs) cannot be executed here; mingw cross-clippy proves compile only → **unverified on device**.

## Backlog (verified or registered, not this round)

- UX-SHL-08 macOS palette "Quit" no-op (Cmd+Q itself is the native menu) — minor.
- UX-SHL-05 no command availability model — design work.
- UX-SHL-06 shell menu worker `rx.await` no timeout (hung shell extension) — Windows device needed.
- UX-SHL-09 multi-selection hides Open/reveal/terminal (`entryMenu.tsx:217`) — feature gap, needs mixed-kind/remote policy.
- UX-SHL-10 macOS `open -a <app>` exit status ignored → missing app reports success (`platform/mod.rs:151-168`) — static hypothesis, Sol ignored repro pending cargo.

## ID note

UX-SHL-11 (DESIGN.md alt keys) and UX-SHL-12 (mac Cmd+Backspace) were labelled "fileops-03/04" in commit e94719d (orig bd92c6b)
and in two test titles (`commands.win.test.ts`, `commands.mac.test.ts`). Those are the fileops-opus smoke labels ux-fileops-03/04,
NOT the 11-08 backend fileops-03/04. Integrated history is not rewritten; test titles get renamed in the next shell test commit.

## CHECKPOINT (~22:45, usage-limit risk)

Done on `ux-smoke/shell` (lead WT `/tmp/duet-ux-smoke-worktrees/shell`):
- 4f80d38 UX-SHL-07 F4 · bd92c6b UX-SHL-11/12 alt keys · d6dba8b tsc cast — Sol APPROVE (L1 r1+r2) → **integrated by main** 88f7d99/e94719d/c6aaa3d.
- 84a1c41 Sol Phase A repros (incl. ignored Rust `src-tauri/tests/ux_shell_sol_a.rs`, NOT compiled yet) · 47dd1b9 Sol L1 review tests (FE 27 pass) · f52945a test relabel UX-SHL-11/12. Not ready until ux_shell_sol_a compiles.
- dfc74b3 UX-SHL-04 clipboard — committed UNTESTED (cargo pending, no review yet). Patch copy: wip/lead-UX-SHL-04.patch. Opus WIP snapshot: wip/shell-opus-UX-SHL-01-snapshot.patch.

In flight:
- shell-opus (w4:p2): UX-SHL-01 multi-select More — code done (BE shell_menu_core.rs + shell_menu.rs Session/AbsPidls, FE shellMenu.ts entryMoreOptions/shellMenuTarget + App.tsx), holds the shell cargo slot: shell_menu_core tests → windows-gnu clippy → pnpm gen:bindings → tsc → commit → SHELL-OPUS-R1.md. Then S-03, S-02 (main: in scope).
- shell-sol (w4:p3): idle → given Phase B L2 instructions (review UX-SHL-01 when Opus commits; report `_report/review-L2.md`).

Shell cargo queue (ONE at a time, team slot granted; targets are APFS clones of /tmp/duet-ux-target-ready; always add `--config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0`, CARGO_BUILD_JOBS=2):
1. shell-opus (running): CARGO_TARGET_DIR=/tmp/duet-ux-target-shell-opus — see above.
2. shell-sol: CARGO_TARGET_DIR=/tmp/duet-ux-target-shell (lead clone, reuse) `cargo test --manifest-path src-tauri/Cargo.toml --test ux_shell_sol_a -- --include-ignored` in lead WT (file is on ux-smoke/shell).
3. lead UX-SHL-04 in lead WT, CARGO_TARGET_DIR=/tmp/duet-ux-target-shell: `cargo test --lib platform::` ; `cargo test --lib -- --ignored --exact platform::macos::tests::clear_if_owned_clears_only_our_unchanged_contents` (private pasteboard only — NEVER run `--ignored` broadly: `set_file_clipboard_writes_real_pasteboard` overwrites the user's clipboard) ; `cargo clippy --target x86_64-pc-windows-gnu --lib -- -D warnings`. Then Sol review, commit, READY.
Send "cargo done shell" to ux-research-lead after 3.

Next step: when Opus commits UX-SHL-01 → run research Part B (`research/repro-tests/primary-repro.test.tsx.txt` → .tsx in shell-opus WT, vitest 1 worker) → Sol L2 review → cherry-pick onto ux-smoke/shell → READY batch L2 (mark Windows runtime/Bandizip UNVERIFIED; main must regen bindings) → send hash to research + main.

## USER PAUSE (recorded 2026-11-11 02:02 KST) — resume only on main's explicit nudge after 02:05 KST

- No shell cargo/vitest running. Sessions/panes kept (w4:p1 lead, w4:p2 shell-opus, w4:p3 shell-sol).
- Branches: `ux-smoke/shell` HEAD `dfc74b3` (lead WT clean). `ux-smoke/shell-opus` HEAD `76b9b6e` + UNCOMMITTED UX-SHL-01 work
  (App.tsx, shellMenu.ts, shellMenu.test.ts, shell-settings-shell-menu.test.ts, commands/system.rs, platform/mod.rs,
  shell_menu.rs, new shell_menu_core.rs) — snapshot `wip-shell-opus.patch` (02:01). `ux-smoke/shell-sol` HEAD `96ea8eb` + uncommitted
  L1 review edits (already copied to lead branch as 47dd1b9); its checkpoint: shell-sol/_report/PAUSE-CHECKPOINT.md.
- Unknown: result of shell-opus's last cargo step (it was cut off by the usage limit); its checkpoint goes in SHELL-OPUS-R1.md.

Next steps after nudge (in order):
1. shell-opus: re-run its cargo steps one at a time (CARGO_TARGET_DIR=/tmp/duet-ux-target-shell-opus, CARGO_BUILD_JOBS=2,
   `--config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0`):
   `cargo test --manifest-path src-tauri/Cargo.toml --lib shell_menu_core` → `cargo clippy --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu --lib -- -D warnings`
   → `pnpm gen:bindings` → `pnpm exec tsc --noEmit` → commit (UX-SHL-01) → SHELL-OPUS-R1.md.
2. shell-sol: L2 review per its PAUSE-CHECKPOINT (incl. research Part B acceptance test).
3. Then shell cargo queue items 2–3 from § CHECKPOINT (Sol's ux_shell_sol_a compile, lead UX-SHL-04 tests).

## Resumed (02:05 KST) — progress

- UX-SHL-01 committed on `ux-smoke/shell-opus`: `8aff4f1` (be/platform) + `87dd723` (fe/ui). Opus: cargo `shell_menu_core` 13 passed, windows-gnu clippy clean, tsc clean vs regenerated bindings, FE mocked 14 passed. Hash sent to research (Part B). **Sol L2 review running.** Lead static read of COM lifetimes: OK.
- Lead cargo queue (02:2x, /tmp/duet-ux-target-shell): `cargo test --lib platform::` 19 passed · private-pasteboard `clear_if_owned_clears_only_our_unchanged_contents` **passed on real macOS NSPasteboard** · `--test ux_shell_sol_a --include-ignored` compiles; ignored repro FAILS as intended → **UX-SHL-10 reproduced** (macOS `open -a` missing app returns Ok) · windows-gnu clippy `-D warnings` clean (lead tree incl. dfc74b3).
- `b9b5ee5` relabels that repro UX-SHL-03 → UX-SHL-10.
- Shell cargo slot back to shell-opus for UX-SHL-03/02.
- Next Sol batch L3: `dfc74b3` (UX-SHL-04) + label-only `f52945a`, `b9b5ee5`.

## FINAL (03:5x KST)

All shell work items done and independently approved; see `REPORT.md` and `READY.json`.
Integrated: L1, L2, L1-tests, INT-1, L3 (main 89b590c fc7da20 7758a16). Nothing pending in shell scope.
Workers idle. No shell cargo running. User's `src-tauri/src/fs/local.rs` untouched.
