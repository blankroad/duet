# Shell-sol Phase A — 2026-11-10

Base `76b9b6e`; branch `ux-smoke/shell-sol`; tests intentionally **uncommitted** per lead (git worktree metadata lies outside sandbox); lead will commit. Mocked FE tests and static inspection only: **not live app testing**. Windows/native runtime and real SSH **unverified**. No product code changed.

## Ranked findings

| Rank / disposition | Symptom and evidence | Root cause / proposed fix |
| --- | --- | --- |
| 1. **UX-SHL-01, P2 — fix this round** | Configured-editor workflow unreachable: F4 does nothing, Edit absent from palette/keymap. **Reproduced by test:** unmarked `expect(id).toBeDefined()` receives `undefined`, `ux-shell-sol-a.test.ts:60`. | `src/lib/commands.ts:87` accepts `editFile`, but `buildBuiltins` never registers/references it; implemented callback stranded at `src/App.tsx:957`. Register `file.edit`, F4, translations, `action: deps.editFile`; retain existing no-file/dir guard. Maps to lead **UX-SHL-07**; lead reports fix in lead worktree, pending independent Phase B verification. No implementation requested here. |
| 2. **UX-SHL-02, P3 — backlog** | Multi-file external Open absent. **Reproduced by test:** two selected files have no `open` item; expected true, received false (`ux-shell-sol-a.test.ts:74`). | `src/lib/entryMenu.tsx:217` deliberately hides Open/reveal/terminal for multi-selection. Future explicit selected-file open action needs mixed file/dir policy, all-file iteration, per-item errors and remote-download handling. Feature gap, not a new regression. Native Windows multi-selection is already shell-opus's S-01; do not duplicate it. |
| 3. **UX-SHL-03, P3 — backlog, STATIC HYPOTHESIS** | Missing macOS associated app may fail without FE error. Tempdir-only ignored Rust repro added, **static hypothesis, Cargo pending**. Native symptom unverified. | `src-tauri/src/platform/mod.rs:151-168` spawns `/usr/bin/open -a`, discards stderr and reports success without checking exit status. Proposed macOS fix: await short-lived launcher and propagate nonzero exit; retain normal process spawning for actual Windows/Linux app processes. |

## Known issues — current verification, not new reports

- **fileops-36: still present statically; existing fix candidate this round.** `commands/system.rs:875` calls `local_paths_of`; SSH/mixed input returns at `:850-853` before any OS clipboard mutation, leaving prior local file data intact. FE `fileActions.ts:202` ignores Result. Mocked tests prove both selected local refs reach backend for copy/cut, and unsupported remote export preserves the in-app queue; they do not inspect OS clipboard contents. Backend fix should deliberately clear stale file payload on remote export, retain in-app targets, and avoid exporting only a local subset. Native regression plan: tempdir A/B copy → inspect file-list formats → remote copy/cut → assert A/B unavailable and in-app remote targets retained; cover mixed sources and clipboard-busy failure. **Native state unverified.**
- **S-03 / shell-settings-16 unchanged, static only.** `commands/system.rs:751-763` returns Ok after queueing; `platform/shell_menu.rs:175-176` drops send error and `:361` drops InvokeCommand error; FE `shellMenu.ts:48` ignores Result. Propagate worker completion/error to toast. Backlog unless included in existing bounded S-01 work. **Windows runtime unverified.**
- **S-02 / shell-settings-10 unchanged, static only.** `platform/shell_menu.rs:457` ignores scope; `:471-474` uses parent/item `GetUIObjectOf`, never background `CreateViewObject`. Existing high-impact candidate: true background binding or withhold background More; lead controls scope. **Windows menu contents unverified.**
- Known remote temp-name collision remains (`commands/system.rs:391-399`, shared `<temp>/duet-opened/<basename>`). Keep existing remote-temp backlog. Download/fs errors propagate to App error feedback (`App.tsx:575`); no real SSH exercised.

## Entry points / selection baseline

| Context | Result / evidence |
| --- | --- |
| None / single | Mocked empty listing copy/cut does not export; cursor fallback intentional when a row exists. Single local Open/reveal and directory terminal covered by existing menu tests; new mocked reveal/terminal/launcher error-feedback test passes. |
| Multi / mixed | Copy/cut passes both local refs; in-app copy/move modes retained. OS cut mirror intentionally means copy. Multi Open/reveal/terminal absent for files or mixed kinds (shared static gate). Enter opens **cursor only**, not all selected entries (`App.tsx:680`, `:571`, static). No cross-platform per-selection Open with chooser: Settings associates extensions; launcher strip launches app/args without selected paths (`AppLauncherStrip.tsx:205`). |
| SSH | Reveal/terminal hidden; single Open downloads first, Edit and watch uses separate roundtrip action. Remote copy in-app retention tested with mocked unsupported export. Actual download/app launch/server behavior unverified. |
| Archive browse | Static: actions use extracted `tab.location` (local or SSH). Local reveal/terminal/Open therefore target temp content; activating archive files enters browse. Lifetime/repack belongs to archive team. No live archive tests. |
| Keyboard/settings | `file.contextMenu` is a builtin with Shift+F10 (`commands.ts:703`), opening entry/background menu (`App.tsx:856`): reveal/terminal/More indirectly keyboard/palette reachable; no direct commands/rebindings. Keymap UI conflict cancel→replace→reset cancel→reset accept passes. Existing override/shadowing and Open-with save rollback checks pass. F4 exception above. |

## Validation

Offline install passed. Initial FE collection failed because generated bindings were absent. Reused main's existing ignored bindings after verifying same base and clean command/type/export sources; no generation or generated file committed. Early binding builds were intentionally SIGINT-cancelled for resource control, not product failures. No Cargo starts without lead grant.

```sh
pnpm exec vitest run --minWorkers=1 --maxWorkers=2 src/lib/__review__/ux-shell-sol-a.test.ts src/components/settings/ux-shell-keymap-a.test.tsx src/lib/entryMenu.test.tsx src/stores/keymap.test.ts src/lib/commands.win.test.ts src/components/settings/OpenWithSection.test.tsx
# 6 files / 22 passed (before two additional baseline tests)
pnpm exec vitest run --minWorkers=1 --maxWorkers=2 src/lib/__review__/ux-shell-sol-a.test.ts
# final file: 7 passed (two it.fails repros + five baseline cases)
pnpm exec vitest run --minWorkers=1 --maxWorkers=2 src/lib/__review__/ux-shell-sol-a.test.ts -t UX-SHL
# temporarily it.fails → it: exit 1, exactly two failures described above; markers restored
```

Prettier and rustfmt checks passed. `pnpm exec tsc --noEmit`: initial run found the test Proxy cast (TS2352); fixed to `as unknown as BuiltinDeps`, recheck pending.
Queued command: `CARGO_BUILD_JOBS=2 cargo test --manifest-path src-tauri/Cargo.toml --test ux_shell_sol_a -- --include-ignored`. Mac hypothesis remains static until executed.

Phase B has not started.
