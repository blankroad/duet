# SHELL-OPUS-R1 — shell-opus report (ux-smoke 2026-11-10/11)

Worktree `/tmp/duet-ux-smoke-worktrees/shell-opus`, branch `ux-smoke/shell-opus`, base `76b9b6e`. This file is not committed.

## Status (latest first) — **opus cargo done**; no shell-opus cargo running

| commit | id | what | cargo | FE |
|---|---|---|---|---|
| `d32af3b` | UX-SHL-01 R2 be | reject `.`/`..` segments in `shell_selection`; Sol L2 `tests/ux_shell_l2.rs` un-ignored | core 21 passed, ux_shell_l2 1 passed, win-gnu clippy clean | — |
| `d6b4191` | UX-SHL-01 R2 fe | native More gets **all** selected entries in pane sort order (filter/hidden independent) | — | vitest 13 passed, tsc/eslint clean |
| `dd80ca6` | UX-SHL-02 | background More = `SHBindToObject` + `CreateViewObject(IContextMenu)` | core 18 passed, win-gnu clippy clean | — |
| `1af2860` | UX-SHL-03 | invoke failures surfaced (NotFound/Io/Cancelled/NotSupported) + FE toasts | core 16 passed, win-gnu clippy clean | vitest 18 passed, tsc/eslint clean |
| `87dd723` | UX-SHL-01 fe | More options for ≥1 selected | — | vitest 14 passed |
| `8aff4f1` | UX-SHL-01 be | multi-PIDL shell menu | core 13 passed, win-gnu clippy clean | — |

**Cross-clippy answer (lead):** yes. `1af2860` and `dd80ca6` were each checked with
`cargo clippy --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu --lib -- -D warnings`, exit 0, no warnings.
Each run was on exactly the tree that was then committed (nothing else uncommitted except this report).
The final tree at `d32af3b` is also clean on the same command.

Every cargo command used: `CARGO_TARGET_DIR=/tmp/duet-ux-target-shell-opus CARGO_BUILD_JOBS=2`.
Test runs also used `--config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0`.
One cargo process at a time.

## UX-SHL-01 R2 (Sol L2 CHANGES → fixed)

1. **Filter-hidden selection (P2) — `d6b4191` fe/ui.**
   - `shellMenuTarget(os, tab, selected)` / `entryMoreOptions(os, tab, selected)` now take the tab.
   - They use `computeDisplayed({ ...tab, filter: "", showHidden: true })`: the pane's own sort function, with filter and hidden-hiding switched off.
   - From that list they keep the selected names, minus "..". This is the same set as `fileActions.resolveActiveTargets`.
   - Names missing from `tab.entries` are dropped: the kind is unknown and the shell cannot find them.
   - Right-click on an unselected row still targets only that row (`App.tsx` passes `new Set([entry.name])`). Global selection semantics are unchanged. No `panes.ts` change.
   - Sol's repro `UX-SHL-01 L2: native More keeps filtered-out selected items like duet actions` is copied into `src/lib/shellMenu.test.ts` and flipped from `it.fails` to `it`.
   - **Adapted** for the new API: the call is now `shellMenuTarget("windows", tab, tab.selected)`, where it used to be `(…, tab.location, computeDisplayed(tab), …)`.
   - Plus an own case: with filter "a.zip", the displayed list is only `[a.zip]`, but the shell gets a,b,c in name order.
   - Existing cases now build tabs via the real pane store (`setEntries`/`setSort name asc`/`setFilter`) with mocked IPC.
   - The mixed file+dir case now asserts set + scope, not exact order: dirs-first is a user setting.
   - `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/shellMenu.test.ts src/lib/__review__/shell-settings-shell-menu.test.ts` → **2 files, 13 passed**.
   - `pnpm exec tsc --noEmit -p .` clean; eslint 0.
2. **Parent validation (P2) — `d32af3b` be/platform.**
   - After `local_abs`, `shell_selection` rejects any path with a `.` or `..` segment → `DuetError::NotSupported("shell menu: path has . or .. segment (…)")`. Only then does it compare `Path::parent`.
   - Both `Component::CurDir|ParentDir` **and** the raw `/`·`\` segments are checked, because `Path::components()` drops interior and trailing `.` (`/w/./a`, `/w/sub/.`).
   - `.hidden`, `a..zip`, `..b` stay valid.
   - The doc comment explains why there is **no `fs::canonicalize`**: the Windows `\?\` prefix breaks `SHParseDisplayName` input, and canonicalizing swaps a symlink/junction for its target, changing shell-item identity.
   - Consequence (documented): the same folder spelled through different aliases (case, 8.3 names, links) is rejected rather than merged. The FE always builds paths from one pane path, so this is not hit in practice.
   - New unit tests: `dotdot_segment_is_rejected`, `dot_segment_is_rejected` (leading, interior, trailing, Windows-style), `dotted_names_are_not_dot_segments`. The existing same-parent tests stay.
   - Sol's `src-tauri/tests/ux_shell_l2.rs` is copied in with `#[ignore]` removed. It reaches `duet_lib::platform::shell_menu_core::shell_selection`; tempdir only.
   - `cargo test --manifest-path src-tauri/Cargo.toml --lib shell_menu_core …` → **21 passed**.
   - `cargo test --manifest-path src-tauri/Cargo.toml --test ux_shell_l2 …` → **1 passed** (`dotdot_item_and_its_sibling_file_have_different_canonical_parents`).
   - win-gnu clippy `-D warnings` → **clean**.

## UX-SHL-03 — invoke failures surfaced (`1af2860`)
- `shell_menu_invoke` now awaits the worker's result. The worker's `Req::Invoke` carries a oneshot reply.
  - stale or evicted token → nothing runs, `NotFound("shell menu expired; open it again")`
  - `InvokeCommand` error → `Io("shell command failed: <msg> (0xHRESULT)")`
  - `HRESULT_FROM_WIN32(ERROR_CANCELLED)` or `E_ABORT` → `Cancelled`
  - id out of range → `NotSupported`
  - worker gone → `Io("shell menu worker stopped")`
- The mapping (`stale_menu_error`, `invoke_error`) is pure, in `shell_menu_core`, with 3 tests.
- FE: `onSelect` returns `invokeShellItem(token, id)`.
  - NotFound → error toast `toast.shellMenuExpired`, with the raw message as detail
  - Cancelled → silent
  - else → `showError("toast.shellMenuFailed", err)`
  - Thrown Error → `showError` too.
- i18n keys added in en+ko. There is no en/ko key-parity test in the repo.
- `__review__/shell-settings-shell-menu.test.ts` (shell-settings-16) is flipped from `it.fails` to `it`.
- **Unverified:** which HRESULTs real verbs return on cancel or failure.

## UX-SHL-02 — background More options (`dd80ca6`)
- For `scope=background`, `build_menu` does `SHBindToObject(None, folder_pidl, None)` → the folder's `IShellFolder` → `CreateViewObject(hwnd)` → `IContextMenu`. Item menus are unchanged.
- The folder object is owned by `Session._folder`, with the same RAII drop order.
- The commands use `shell_menu_core::shell_target(paths, scope)`: `shell_selection`, plus background requires exactly one folder (NotSupported otherwise). 2 tests.
- Prewarm builds with scope File.
- **Unverified on Windows:** the exact background items.
  - View/Sort come from DefView and won't appear.
  - "New" and "Send to" submenus may be empty, because `enumerate` does not drive `IContextMenu2/3::HandleMenuMsg`. This is pre-existing for item menus too, and a candidate follow-up.

## Remaining / unverified (all items)
- Not run on real Windows:
  - multi-PIDL `GetUIObjectOf` via `ILFindLastID`
  - Bandizip/7-Zip "Extract each" on N archives
  - background menu contents
  - invoke HRESULTs
- macOS/Linux have no "More options" (platform limit).
- Bindings: `pnpm gen:bindings` ran once after UX-SHL-01, with `shellMenuOpen/shellMenuWarm(paths: string[], scope)`. Later commits changed no IPC signatures; only doc comments changed (invoke and warm docs). Main regenerates after integration.

---
## (history) PAUSE CHECKPOINT (2026-11-11, user pause until 02:05 Asia/Seoul + main nudge)

- Stopped on the user pause. No cargo running from shell-opus. Product code was not edited after the pause.
- **UX-SHL-01 is code-complete and green on every check that ran, but NOT committed.** The "commit now"
  checkpoint order and the pause order arrived together. The pause says to only write this file, so I did not commit.
  Main's snapshot of the diff: `docs/reviews/2026-11-10-ux-smoke/shell/wip-shell-opus.patch`.
- UX-SHL-03 and UX-SHL-02: not started.

### Uncommitted files
```
 M src-tauri/src/commands/system.rs        shell_menu_open/warm take paths: Vec<PathBuf>, validated via shell_selection
 M src-tauri/src/platform/mod.rs           pub mod shell_menu_core (not cfg-gated)
 M src-tauri/src/platform/shell_menu.rs    multi-PIDL build, RAII Session/AbsPidls, SessionCache, stale-token guard
?? src-tauri/src/platform/shell_menu_core.rs  pure: shell_selection() + SessionCache<K,V> + 13 unit tests
 M src/App.tsx                             openEntryMenuAt uses entryMoreOptions(); background passes [bgPath]
 M src/lib/shellMenu.ts                    openShellMenu(paths[]), warmShellMenu -> [path], shellMenuTarget/entryMoreOptions
?? src/lib/shellMenu.test.ts               6 mocked Vitest cases
 M src/lib/__review__/shell-settings-shell-menu.test.ts   call site -> array API (still it.fails; flips in UX-SHL-03)
 (gitignored) src/types/bindings.ts        regenerated (see Binding changes)
```

## UX-SHL-01 — multi-selection native "More options" (Windows)

### Design (as implemented)
- **IPC:** `shell_menu_open(paths: Vec<PathBuf>, scope)` and `shell_menu_warm(paths: Vec<PathBuf>, scope)`. `shell_menu_invoke` is unchanged.
- **Backend validation:** `platform::shell_menu_core::shell_selection` is pure and cross-platform. It runs on every OS before the cfg branch. It applies `local_abs` to each path. An empty list gives `DuetError::NotSupported("shell menu: empty selection")`. If any `Path::parent()` differs from the first one, it gives `NotSupported("… selection spans folders …")`. Parents are compared as `Path` components, not strings, and roots share the "no parent" group. Order is preserved.
  - Note: `NotSupported` was reused. I did not add a new `DuetError` variant, to avoid a FE-wide kind change.
- **Cache key:** `(Vec<PathBuf>, ShellScope)`. The ordered selection is part of the key, so the selection [a,b] and the selection [b,a] get separate cache entries.
- **`build_menu(hwnd, &[PathBuf])`:**
  1. `SHParseDisplayName` for each path. Each result is pushed into `AbsPidls`, so if a later path fails, the earlier PIDLs are freed by Drop.
  2. `SHBindToParent(first, None)` binds the parent once.
  3. Each child is `ILFindLastID(abs)`, the same value as SHBindToParent's ppidlLast.
  4. One `GetUIObjectOf(hwnd, &[all children])` call.
  5. Then `CreatePopupMenu` + `QueryContextMenu`. The Session is assembled before QueryContextMenu, so the HMENU is freed even if QueryContextMenu fails.
- **COM lifetimes (addenda 1 and 2):** `Session { hmenu, cm, _parent: IShellFolder, _pidls: AbsPidls }` is owned by the cache entry.
  - `Drop for Session` calls DestroyMenu. Fields then drop in declaration order: cm Release, then parent Release, then `AbsPidls::drop`, which calls `CoTaskMemFree` once per PIDL via drain.
  - So the absolute PIDLs, and the child PIDLs that point into them, stay alive through QueryContextMenu and InvokeCommand. They are freed exactly once when the entry is dropped (rebuild, eviction, after invoke, or prewarm discard).
  - All `unsafe` stays in platform/shell_menu.rs, with SAFETY comments.
- **Token / stale guard (addendum 4):** the generic `SessionCache<K,V>` keeps `entries`, a `by_token` reverse index, `order`, and `cap=16`.
  - `issue_token()` returns a fresh value for every build; it never reuses a token and never returns 0.
  - `resolve(token)` returns a session only if `by_token[token]` maps to a live entry **whose own token equals `token`**. So an old token is never resolved against a newer rebuild of the same selection.
  - remove, replace and evict all clear `by_token`.
  - `State::invoke` on a stale token runs nothing and logs `tracing::warn!("shell menu invoke ignored: stale token …")`. Surfacing it to the user is UX-SHL-03.
  - The shared snapshot map is updated together with the cache: evicted keys are removed before the new snapshot is inserted.
- **After invoke:** the entry is dropped. The selection is re-warmed only if **every** path still exists.
- **Unchanged:** Prewarm stays single-path. Background (`scope=background`) still sends a single path as `[bgPath]`; the UX-SHL-02 fix is pending.
- **FE `shellMenuTarget(os, location, displayed, selected)`:** windows + local + not virtual trash. It takes the selected entries in **displayed order**, minus "..". Scope is `directory` only if all are dirs, else `file`. Scope is cache-key only; `build_menu` ignores it.
  - `entryMoreOptions` wraps it, adds separator + `win-more` with `loadChildren`, and fires `openShellMenu` immediately, as before.
  - `App.openEntryMenuAt` passes `wasSelected ? tab.selected : new Set([entry.name])`. This is the existing rule: right-clicking an unselected entry makes the selection just that entry.
  - Caveat: selected items hidden by a filter are not sent to the shell menu, because only displayed entries are used. duet's own menu still counts them in `selectedCount`.
- `useShellWarm` is unchanged and still warms one item; `warmShellMenu` wraps it as `[path]`.

### Commands run + results (macOS host)
All cargo runs used `CARGO_TARGET_DIR=/tmp/duet-ux-target-shell-opus CARGO_BUILD_JOBS=2`, one at a time.
1. `cargo test --manifest-path src-tauri/Cargo.toml --lib shell_menu_core --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0`
   → **13 passed, 0 failed**, no warnings.
   - Tests: same-parent order kept, single item, mixed file+dir, across folders rejected, path-not-string compare, empty rejected, roots, unique non-zero tokens, rebuilt key rejects old token, order is part of the key, eviction drops the token, removed token stale, unknown token stale.
2. `cargo clippy --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu --lib -- -D warnings`
   - First run: 1 error (`len_without_is_empty` on `SessionCache::len`). Fixed by making `len` `#[cfg(test)]` and private.
   - Rerun: **exit 0, clean**.
   - The tests in step 1 ran **before** this `len` change. The change only adds a `#[cfg(test)]` attribute and makes `len` private; tests in the same module still use it. A rerun of step 1 is listed below as pending.
3. `pnpm gen:bindings` (same CARGO_TARGET_DIR) → **exit 0**, "bindings written". This also built the macOS lib with no warnings shown.
4. `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/shellMenu.test.ts src/hooks/useShellWarm.test.tsx src/lib/__review__/shell-settings-shell-menu.test.ts`
   → **3 files, 14 passed**. These ran against the hand-edited bindings, which have the same signatures as the generated ones.
   - **These are mocked tests, not live app tests.** The mocked parts are `@/types/bindings` commands, and the OS passed as `"windows"`.
   - Cases: 3 archives (win-more present, `shellMenuOpen(["C:\\work\\a.zip","C:\\work\\b.zip","C:\\work\\c.zip"], "file")` in displayed order even though the Set was inserted c,a,b, `loadChildren` yields the shell item), single selection, mixed file+dir (`file`), dir-only (`directory`), ".." excluded, macos/linux/remote/virtual-trash give no win-more, warm sends `[path]`.
5. `pnpm exec eslint` on the 4 changed FE files → 0. `pnpm exec tsc --noEmit -p .` → clean. prettier `--write` was applied to the changed FE files.
6. `cargo fmt` was applied only to the 3 changed Rust files. `core/archive.rs` was untouched.

### Binding changes (src/types/bindings.ts, gitignored, regenerated with `pnpm gen:bindings`)
- `shellMenuOpen(path: string, scope)` → `shellMenuOpen(paths: string[], scope: ShellScope)`, invoking `shell_menu_open` with `{ paths, scope }`.
- `shellMenuWarm(path: string, scope)` → `shellMenuWarm(paths: string[], scope: ShellScope)`, invoking `shell_menu_warm` with `{ paths, scope }`.
- Doc-comment text updated. No type changes. `shellMenuInvoke` is unchanged.

### Unverified
- **Real Windows runtime has not been exercised.** Unverified: multi-PIDL `GetUIObjectOf` via `ILFindLastID` children, Bandizip/7-Zip "Extract each to separate folder" appearing and working for N archives, and Explorer verb behavior with many items (MultiSelectModel limits; no cap was added).
- Only cross-clippy and the macOS unit and mocked tests have run.
- **macOS/Linux have no "More options"** (platform limit: there is no IContextMenu equivalent). `shellMenuTarget` returns null there.

## Next steps (after main nudges; one cargo at a time, ask lead for the slot)
1. (cargo) Re-run the focused tests after the `len` cfg(test) change:
   `CARGO_TARGET_DIR=/tmp/duet-ux-target-shell-opus CARGO_BUILD_JOBS=2 cargo test --manifest-path src-tauri/Cargo.toml --lib shell_menu_core --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0`
2. Commit UX-SHL-01 as 2 commits:
   - `be/platform: UX-SHL-01 multi-item shell menu (one parent, all child PIDLs)` with the 4 Rust files.
   - `fe/ui: UX-SHL-01 More options for multi-selection` with App.tsx, shellMenu.ts, shellMenu.test.ts and the __review__ test.
   - Both messages end with the Co-Authored-By line and an honest test-status line.
3. UX-SHL-03, 1 commit:
   - Worker `Req::Invoke` gets a oneshot reply. `shell_menu_invoke` returns `Err` for: stale token → `NotFound("shell menu expired")`; `InvokeCommand` Err → `Io(...)`; HRESULT_FROM_WIN32(ERROR_CANCELLED) → `Cancelled`; out-of-range id → `NotSupported`.
   - FE `onSelect` returns the promise. NotFound → i18n `toast.shellMenuExpired` (ko+en). Cancelled → silent. Otherwise → `showError("toast.shellMenuFailed", err)`.
   - Flip `__review__/shell-settings-shell-menu.test.ts` from `it.fails` to `it`.
   - Then run cross-clippy, `vitest run` on that file and `shellMenu.test.ts`, and `gen:bindings` (no signature change expected).
4. UX-SHL-02, 1 commit: background menu via `IShellFolder::CreateViewObject(hwnd, IID_IContextMenu)` on the current folder, instead of `GetUIObjectOf` on the folder as an item. Then cross-clippy.
5. Fill this report with commit hashes, then tell lead "opus cargo done".
