# shell — UX smoke final report (2026-11-10 ~ 11-11)

Team (herdr w4): lead `ux-shell-lead` (Opus 5.5) · implementer `shell-opus` (Opus 5.5) · reviewer `shell-sol` (Codex gpt-6.1-sol).
Base `76b9b6e`. Branches: `ux-smoke/shell` (module), `ux-smoke/shell-opus`, `ux-smoke/shell-sol`.
User's uncommitted `src-tauri/src/fs/local.rs` was never touched.

## Outcome

- **Primary user repro fixed in code (Windows):** selecting several archives and opening "More options" now hands **all** selected
  items to the native shell menu, so Bandizip/7-Zip "extract each" can see N archives. Mocked FE tests and research's acceptance
  test (Part B) pass. **Not run on real Windows** — see Limits.
- 6 more fixes reviewed and approved: UX-SHL-02, -03, -04, -07, -11, -12. All 7 fixes have an independent Sol APPROVE;
  every batch finished within 3 rounds. **All shell batches are integrated into main**; main's final native gates are pending.

## Fixed

| ID | User-visible change | Commits (source → main) | Review |
| -- | ------------------- | ----------------------- | ------ |
| UX-SHL-01 | Windows "More options" for multi-selection: all selected items in pane sort order, one native menu (same set as duet's own actions; the store prunes filter-hidden names since browse03) | shell-opus 8aff4f1, 87dd723, d6b4191, d32af3b → main L2 | Sol r1 CHANGES (filter-hidden items dropped; textual parent check) → r2 APPROVE |
| UX-SHL-03 (ss-16) | Native menu action failures show a toast; stale menu → "menu expired"; user cancel stays silent | shell-opus 1af2860 → main L2 | Sol APPROVE r1 |
| UX-SHL-02 (ss-10) | Empty-area "More options" is the folder's background menu, no longer Delete/Rename of the current folder | shell-opus dd80ca6 → main L2 | Sol APPROVE r1 |
| UX-SHL-07 | F4 opens the file in the configured editor (command was never registered since 8c4b836) | 4f80d38 + d6dba8b → 88f7d99, c6aaa3d | Sol r1 CHANGES (tsc cast) → r2 APPROVE |
| UX-SHL-11 | DESIGN.md alternate keys F8 / Shift+F8 / Ctrl+Shift+N / Shift+F6 | bd92c6b → e94719d | Sol APPROVE r1 |
| UX-SHL-12 | macOS Cmd+Backspace moves selection to trash | bd92c6b → e94719d | Sol APPROVE r1 |
| UX-SHL-04 (fileops-36) | Ctrl+C on remote/mixed items no longer leaves duet's previous local copy on the OS clipboard; anything copied elsewhere is left alone (Windows certain, macOS best effort, Linux unchanged) | dfc74b3 + e0ee94e + d0fc43d → 89b590c, fc7da20, 7758a16 | Sol r1 CHANGES (races, lost retry, dangerous test comment) → r2 CHANGES (unreadable marker = not ours) → r3 APPROVE |
| UX-SHL-01 follow-up | Filter test split after browse03 selection pruning (test/comment only) | c34b1e3 → 7984ad7 | Sol APPROVE (UX-SHL-01 round 3) |

Integration state: L1 → main 88f7d99 e94719d c6aaa3d; L2 → main de032ee..2d84c7e; L1-tests → main f90fb82 fa67b2e d2f57fb 8fc67b5;
INT-1 → main 7984ad7; L3 → main 89b590c fc7da20 7758a16. Main regenerated bindings
(shell IPC `shell_menu_open/warm(paths: Vec<PathBuf>, scope)`); main reports tsc passed.

## Evidence (exact)

- `cargo test --lib shell_menu_core` 21 passed; `cargo test --test ux_shell_l2` 1 passed; `cargo clippy --target x86_64-pc-windows-gnu --lib -- -D warnings` clean (shell-opus, per commit).
- `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/shellMenu.test.ts src/lib/__review__/shell-settings-shell-menu.test.ts src/hooks/useShellWarm.test.tsx` 20 passed (Sol); with acceptance `-t 'B:'` on module branch 22 passed / 2 Part-A skipped (lead).
- `pnpm exec tsc --noEmit` exit 0 on module branch with **really generated** bindings (`pnpm gen:bindings` by shell-opus).
- L1: `src/lib/commands.{win,mac}.test.ts`, `src/stores/keymap.test.ts`, Sol dispatch tests — 5 files / 27 passed; F4 test fails without fix (`expected undefined to be 'F4'`); fileops' own repro (6371b88) 5/5 flip.
- UX-SHL-04 r3 (leased slot A, `CARGO_TARGET_DIR=/tmp/duet-ux-target-shell`): `cargo test --lib platform::` 47 passed;
  `cargo test --lib platform::macos::tests::clear_if_owned_clears_only_our_unchanged_contents -- --ignored --exact` passed on real
  macOS NSPasteboard (private named pasteboard; also verifies another app's text is kept); windows-gnu clippy `-D warnings` clean.
  **Never run `platform::macos` with a broad `--ignored`** — `set_file_clipboard_writes_real_pasteboard` overwrites the user's clipboard.
- INT-1: vitest (1 worker) shellMenu + panes + browse-panes + shell-settings-shell-menu + useShellWarm — 5 files / 102 passed on main+c34b1e3; Part B pass.
- `cargo test --test ux_shell_sol_a -- --include-ignored`: ignored repro fails as intended → UX-SHL-10 reproduced on real macOS.

All FE tests mock IPC (and the OS as "windows" where relevant) — **not live app tests**.

## Limits / unverified

- **Windows runtime never exercised**: multi-PIDL `GetUIObjectOf`, Bandizip/7-Zip "extract each" for N archives, Explorer
  multi-select item limits, real cancel HRESULTs, background menu contents (lazy New/Send to submenus may be empty; View/Sort
  come from DefView and are absent). mingw clippy = compile only.
- macOS/Linux have no native "More options" (platform limit).
- macOS F-key hardware behavior for F4/F8 unverified.
- UX-SHL-04: Windows clipboard path compile-only; macOS check→clear is not atomic (small, unbounded gap — another app writing
  exactly then can lose its content); Linux keeps the old behavior (no marker). The nonce is cooperative ownership, not security.

## Backlog (deduplicated, registry IDs)

| ID | What | Evidence |
| -- | ---- | -------- |
| UX-SHL-06 | shell-menu worker `rx.await` has no timeout — a hung shell extension leaves "More options"/invoke pending | static (Sol L4) |
| UX-SHL-10 | macOS "Open with" missing app reports success (`platform/mod.rs:151-168`) | real macOS ignored repro `tests/ux_shell_sol_a.rs` |
| UX-SHL-09 | multi-selection hides Open / reveal / terminal | FE-mock repro (Sol) |
| UX-SHL-08 | macOS palette "Quit" is a no-op (Cmd+Q itself works via native menu) | FE-mock (research) |
| UX-SHL-05 | commands have no availability model (not disabled with reason) | static |
| UX-SHL-04L | Linux: remote Ctrl+C still leaves the old local copy on the clipboard (no ownership marker via wl-copy/xclip) | static, documented limit |
| — (pre-existing) | Windows CF_HDROP `HGLOBAL` not freed when `SetClipboardData` fails (11-08 shell-settings-11 family) | static (Sol L3r2) |

## Rounds

L1 (UX-SHL-07/11/12) 2 · L2 (UX-SHL-01) 2 + INT-1 follow-up = 3 · L4 (UX-SHL-02/03) 1 · L3 (UX-SHL-04) 3 · label commits 1. All ≤ 3.
Reviewer verdicts: `review-L1-sol.md`, `review-L2-sol.md`, `review-L2r2-sol.md`, `review-L4-sol.md`, `review-L3-sol.md`,
`review-L3r2-sol.md`, `review-L3r3-sol.md`, `review-int-c34b1e3-sol.md`; implementer report `opus-R1.md`; Sol baseline `sol-phase-a.md`.

## Process notes

- Sol could not write git metadata (sandbox); lead committed its tests (84a1c41, 47dd1b9).
- One lead Vitest run accidentally started the full suite (zsh glob error); stopped within minutes.
- Cargo ran only under research leases on APFS clones of `/tmp/duet-ux-target-ready` (one shell cargo at a time).
- Paused 22:45–02:05 for the usage limit; work resumed from `STATUS.md` checkpoints, nothing lost.
- ID collisions fixed: integrated commit e94719d's message says "fileops-03/04"; canonical IDs are UX-SHL-11/12.
