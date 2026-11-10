# shell team brief (ux-smoke 2026-11-10)

Lead: `ux-shell-lead` (w4:p1, Opus 5.5) — branch `ux-smoke/shell`, WT `/tmp/duet-ux-smoke-worktrees/shell`
Workers (w4 only):
- `shell-opus` (Opus 5.5) — analysis/implementation. WT `/tmp/duet-ux-smoke-worktrees/shell-opus`, branch `ux-smoke/shell-opus`
- `shell-sol` (Codex gpt-6.1-sol) — independent smoke + review. WT `/tmp/duet-ux-smoke-worktrees/shell-sol`, branch `ux-smoke/shell-sol`

Base: `76b9b6e8b61608168b42a135a7a888422a3b1c60`. Protocol: `docs/reviews/2026-11-10-ux-smoke/PROTOCOL.md` (main checkout, read-only for you).

## Rules (read before work)

- Read `CLAUDE.md` + `ARCHITECTURE.md` in your worktree. Edit only inside your own worktree. Never touch the main checkout
  (`/Users/ctmctm/Desktop/01_PROJECT/duet`) — it holds the user's uncommitted `src-tauri/src/fs/local.rs`.
- No new dependencies, no force reset/clean, no shared target dir. `export CARGO_BUILD_JOBS=2`.
- First time in the WT: `pnpm install --frozen-lockfile --offline` (falls back to `--frozen-lockfile`), then `pnpm gen:bindings` if tsc shows phantom binding errors.
- Focused tests only (`pnpm exec vitest run <files>` — never pipe vitest into tail; `cargo test --lib <filter>`). Do NOT run the full vitest suite.
  Full `cargo clippy`/`cargo test` only after asking the lead (serialized across teams).
- Windows code (`#[cfg(windows)]`, `platform/shell_menu.rs`) is checked on macOS with
  `cargo clippy --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu --lib` (mingw-w64 installed). Runtime Windows behavior = **unverified** unless proven on a real machine; say so.
- Mocked FE tests are not "live app tests". Separate reproduced-by-test findings from static hypotheses.
- Focused commits, scope prefix per CLAUDE.md, end messages with `Co-Authored-By:` line for your model. Report hashes to the lead.
- Shared files: `src/lib/entryMenu.tsx` archive section (`extract`, compress) belongs to the archive team — don't edit it; ask the lead.
  Shell team owns: `App.tsx` "More options" blocks in `openEntryMenuAt`/`openEmptyMenuAt`, `src/lib/shellMenu.ts`, `src/hooks/useShellWarm.ts`,
  `src-tauri/src/platform/shell_menu.rs`, `shell_menu_*` commands in `src-tauri/src/commands/system.rs`, open-with/launchers, OS file clipboard, settings/keymap.

## Scope inventory (lead, static, base 76b9b6e)

S-01 (motivating, P1-UX) **Multi-selection has no native "More options".** `App.tsx:758-783` adds `win-more` only when
`selectedCount === 1`; backend `shell_menu_open(path, scope)` / `build_menu` bind one child PIDL
(`SHBindToParent` → `GetUIObjectOf(&[child])`, `platform/shell_menu.rs` `build_menu`), cache key `(PathBuf, ShellScope)`.
So selecting 3 archives and wanting Bandizip/7-Zip "Extract each to folder" is impossible from duet on Windows.
Fix direction: IPC takes `paths: Vec<PathBuf>` (same parent, ≥1), backend binds parent once and passes all child PIDLs to
`GetUIObjectOf` (Explorer behavior), cache key becomes the ordered path list + scope; FE passes all selected entries
(display order, exclude ".."), mixed file/dir allowed (scope = file if any file? decide + document; scope is not used by build_menu today).
Guard: reject paths with different parents / empty list with a typed error; cap count (Explorer has a 16-item limit for some verbs
via MultiSelectModel — do not add a cap unless evidence). Warm path keeps single-item.

S-02 (prior shell-settings-10, P2, unverified on device) Background "More options" binds the current folder as an item (not
`CreateViewObject` background menu) → shows Delete/Rename of the current folder. Same file as S-01.

S-03 (prior shell-settings-16, P3) shell menu invoke failure is silent (`shell_menu_invoke` always Ok, worker ignores result; FE `void`).

Other scope to smoke (sol baseline): open-with / app launchers, external tools (open terminal, reveal, default app, editor command),
OS file clipboard (multi-select Ctrl+C → `set_file_clipboard`), settings dialog, keymap (rebind/conflict/reset), command palette entries for
the above, none/single/multi/mixed selection, local vs remote vs archive-browse tab, cancellation/failure.
