# L4 round 1 — independent review

- **1af2860 — APPROVE** (UX-SHL-03 invoke error feedback).
- **dd80ca6 — APPROVE** (UX-SHL-02 actual background context menu).

No new blocking finding. Applied alongside L2r2 with `_report/l2r2-l4.patch`. **Windows runtime UNVERIFIED**: no real shell verbs, cancel dialogs, background menu contents, Bandizip/7-Zip, or native extraction exercised. No Cargo/build/gen:bindings run.

## UX-SHL-03

`src-tauri/src/commands/system.rs` now awaits the worker result instead of returning unconditional success. `platform/shell_menu.rs:222-232` creates an Invoke oneshot, maps send/receive disconnection to Io, and waits for the actual result. Worker dispatch sends it after `State::invoke`; stale/evicted token yields NotFound before any COM call (`:348-355`). Live token + out-of-range ID yields NotSupported (`:364-372`). Valid IDs invoke the retained session and propagate mapped COM failure, then drop/re-warm the session; no stale token resolves to a newer menu.

`platform/shell_menu_core.rs:170-194` maps 0x800704C7 and E_ABORT to Cancelled and other failures to Io with trimmed message + HRESULT. No message-text matching. Which HRESULT a real shell extension returns on cancellation remains unverified; some extensions may report success after displaying/cancelling their own dialogs.

`src/lib/shellMenu.ts:45-63` awaits command results, catches transport rejection, suppresses **Cancelled** and success, shows the localized expired message for NotFound, and otherwise uses showError. Menu leaf onSelect returns that Promise (`:83`), so the updated old failure repro genuinely awaits the feedback. The Cancelled test confirms zero toast calls. The two new toast keys exist in both en and ko with matching `{{err}}` placeholder use; expiry has no interpolated placeholders. No translation parity issue found.

**Known UX-SHL-06 backlog remains:** `Worker::invoke` awaits `rx` with no timeout. A hung QueryContextMenu/InvokeCommand or earlier STA work can leave the FE promise pending indefinitely. Disconnected channels return errors; a live hung worker does not. Per scope instruction, this is noted, not a new CHANGES request.

## UX-SHL-02 / COM lifetime

`platform/shell_menu.rs:554-558` branches on Background, binds the current folder's absolute PIDL with SHBindToObject, then requests `CreateViewObject<IContextMenu>` from that folder. It does **not** bind the folder's parent/get the folder as an item, and there is no fallback to that old path. File/Directory scopes alone use SHBindToParent/GetUIObjectOf (`:559-570`). Therefore the previous standard Delete/Rename-of-current-folder item-menu route is removed. Exact real menu labels/third-party extensions remain unverified; no claim of filtering arbitrary third-party destructive verbs.

Both command entry points use `shell_target`; background requires exactly one target (`shell_menu_core.rs:72-80`). A nonfolder cannot bind IShellFolder and fails instead of falling back to item semantics. Background and item menus are distinct cache keys via scope. FE background path is still a one-element array.

Session retains the folder interface, context-menu interface and all PIDLs through query and invoke (`shell_menu.rs:575-584`). Drop order remains HMENU destroy, context-menu release, folder release, absolute PIDL free. Partial failures release allocated state. Prewarm passes File scope explicitly. No static COM lifetime defect found. Lazy IContextMenu2/3 submenu population remains the documented existing limitation: New/Send to can be empty, and DefView View/Sort are not provided; not re-reported as this batch's defect.

## Evidence

Independent:

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/shellMenu.test.ts src/lib/__review__/shell-settings-shell-menu.test.ts src/hooks/useShellWarm.test.tsx
# 3 files / 20 passed, exit 0 (success, expiry, cancel silent, Io, old failure repro, warm)
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/__review__/primary-repro.test.tsx -t 'B:'
# 2 passed, 2 skipped, exit 0
```

Opus-supplied, **not rerun**: 1af2860 records core Rust tests **16 passed**, Windows GNU clippy `-D warnings` clean, focused mocked FE tests 18 passed. dd80ca6 records core tests **18 passed** including scope rules and Windows GNU lib clippy clean. Later d32af3b records **21 core + 1 integration passed**, clippy clean over the combined source. Compile-only Windows evidence is not runtime proof.

No product fixes or new reviewer test code authored for L4. The updated `src/lib/shellMenu.test.ts` and `src/lib/__review__/shell-settings-shell-menu.test.ts` are implementer changes brought by the patch and remain uncommitted here; the research acceptance copy remains uncommitted. Reports/backups/patch remain under `_report/`. Prior L1 and L2 work preserved.
