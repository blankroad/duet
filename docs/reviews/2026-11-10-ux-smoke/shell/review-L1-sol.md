# L1 independent review — round 1

Reviewed `4f80d38` and `bd92c6b` by applying `git diff 96ea8eb~1 ux-smoke/shell -- src | git apply` onto shell-sol's `96ea8eb` files. No Cargo, build, dependency changes or git metadata writes. Tests/report remain uncommitted.

## Verdicts

- **4f80d38 — CHANGES** (UX-SHL-07). Runtime registration is correct, but the commit introduces a TypeScript build blocker in **`src/lib/commands.win.test.ts:36`**: the Proxy containing only `permanentDeleteEnabled` and `editFile` is directly cast to `BuiltinDeps`. `pnpm exec tsc --noEmit` exits 2 with **TS2352**, missing `openTab`, `closeActiveTab`, etc. Required fix at line 44: `as unknown as Parameters<typeof buildBuiltins>[0]` (or a fully typed dependency fixture). Left this lead test unchanged so the failure remains reproducible. No functional objection to `file.edit` registration.
- **bd92c6b — APPROVE** (fileops-03/04). Correct `altKeys` registration and macOS merge; no new default/alternate collisions, dispatch duplication, override or input isolation regression found. The batch's sole type-check failure is the first commit's new test above.

## Independent evidence

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/commands.win.test.ts src/lib/commands.mac.test.ts src/stores/keymap.test.ts src/lib/__review__/ux-shell-sol-a.test.ts src/components/settings/ux-shell-keymap-a.test.tsx
# 5 files / 27 tests passed, exit 0
pnpm exec tsc --noEmit
# exit 2: src/lib/commands.win.test.ts(36,7), TS2352
```

- Changed the prior F4 repro to ordinary `it` and registry ID **UX-SHL-07**: `resolveKeyCommand("F4", ...)` resolves and invokes `editFile`. Backlog multi-Open repro retains `it.fails`, now **UX-SHL-09**.
- Added real `window` keydown tests mounting **both `useKeyboardNav` and `useGlobalShortcuts`**. F4 invokes edit exactly once. Shift+F6, F8, Shift+F8 and Ctrl+Shift+N each invoke the intended callback once. Permanent-delete command is absent when disabled.
- Overrides can take F4/F8 for other actions; rebind disables the original command's default/alternate keys. Existing keymap precedence/shadowing tests also pass.
- Windows and macOS default+alternate collision checks pass. On macOS, actual `metaKey+Backspace` dispatches trash exactly once and never parent navigation; rebinding trash disables Cmd+Backspace and F8. F4 remains `file.edit` after mac transformation.
- Input/textarea and the **actual `InlineRenameInput` component** absorb F4, Shift+F6, F8, Shift+F8 and Ctrl+Shift+N; no underlying command or rename completion fires. New commands do not enable `allowInInput`. Source confirms `InlineRenameInput.tsx:154-155` stops propagation and `useGlobalShortcuts.ts:62-66` blocks input/textarea commands.
- `commandLabel` resolves **“Edit file” / “파일 편집”** in en/ko. Palette uses that same helper (`CommandPalette.tsx:49`); no live palette UI claim.

## F4 callback edge inspection (static, existing App callback)

`App.tsx:957-976` rejects empty cursor, directories and `..`; local files call `openPath(loc, true)`, SSH files call `sshEditOpen(loc)`, errors reach `showError`. It reads the current tab/cursor at invocation. In archive browse, it uses the extracted tab's Location, so local content opens with the configured editor and SSH content uses edit-and-watch. The commit does not change archive writeback/lifetime behavior. Multi-selection remains cursor-file editing. These App callback edges were traced in source, **not executed as full-App/real SSH/native tests**. macOS hardware F-key behavior is unverified.

## Uncommitted reviewer test edits

1. `src/lib/__review__/ux-shell-sol-a.test.ts`: F4 `it.fails` → `it`, registry IDs UX-SHL-07 / UX-SHL-09.
2. `src/components/settings/ux-shell-keymap-a.test.tsx`: four dispatch/input/translation/override review tests.
3. `src/lib/commands.mac.test.ts`: default+alternate collision and actual Cmd+Backspace dispatch tests.

`src/lib/commands.win.test.ts` and product/i18n changes are the applied lead diff, not reviewer fixes. `_report/review-L1.md` is uncommitted. No commit created. Phase A tsc recheck before applying this batch had completed successfully (exit 0).

Awaiting next batch; UX-SHL-10 remains backlog/static hypothesis with Cargo pending.

L1 round 2: **4f80d38+d6dba8b — APPROVE**. Applied d6dba8b; `pnpm exec tsc --noEmit` passed (one run, exit 0); `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/commands.win.test.ts` passed (4/4, exit 0). Prior TS2352 blocker resolved. Worktree left as is; no checkout/reset or commit.
