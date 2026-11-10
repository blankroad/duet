# Remote FE R3 — final independent verdict

**APPROVE `3cd94c5` and `10719a8`.** The R2 wrong-session Disconnect finding is resolved. Batch 2 is ready for the lead to forward to main; ordered commits and fixed issue aliases are in `_report/READY-batch2.json`.

Reviewed the actual commit diffs and the applied tree through `10719a8702c9edc8303aeadeee3c81136c416fe9`, based on `76b9b6e`. After the user pause and explicit resume, compared all **25 changed source/test files byte for byte** against that commit: **zero mismatches**. No resets, new implementation, or commits performed.

| Commit | Verdict | Evidence |
| --- | --- | --- |
| `3cd94c5` | **APPROVE** | Saved-host state, pane badges and Disconnect now use only `adHocAliasOf(host)` (`src/components/Sidebar.tsx:1257`, `:1258`, `:1259`, `:1273`). The raw display-alias union/fallback and its helpers are removed. A config session sharing the display name is neither used as the saved row's connection nor closed by its Disconnect. The sidebar smoke fixture now models the actual canonical ad-hoc alias (`src/components/__smoke__/sidebar-shell.smoke.test.tsx:427`). |
| `10719a8` | **APPROVE** | Includes the independent R2 tests. The identity repro is now an ordinary passing test: Disconnect closes the target session and leaves the unrelated config session alone. Connected/connecting multi-session close cases, deferred password-save error reporting, and genuine own nicknames for prototype-named aliases also pass. |

## Validation

Executed one single-worker **mocked FE test** process before the user pause; full completion was received before pausing: **exit 0, 11 files / 66 tests passed**. No process remained active during the pause. The unchanged reviewed tree was verified after resume, so this completed result was reused without a redundant test retry.

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 \
  src/components/connection/__review__ \
  src/lib/__review__/remote-sol-r2-own-nicknames.test.ts \
  src/components/__smoke__/sidebar-shell.smoke.test.tsx \
  src/components/__review__/shell-settings-sidebar.test.tsx \
  src/components/__review__/shell-settings-hosts.test.tsx
```

The count includes existing expected-failure markers for other known issues; the NEW-1/NEW-2/NEW-3 regression cases are ordinary passing tests. Existing React `act` and Node localstorage warnings appeared; no unhandled test errors. `git diff --check` passed. No Cargo, tsc, live app, Docker or real-server checks run for this FE review.

## Readiness scope

- `remote-NEW-1 / UX-REM-03`: host/password save errors are reported while retaining the successful connection; deferred vault save is covered. Toast plus close is an accepted UX, as recorded in R2.
- `remote-NEW-2 / UX-REM-04`: saved-host session state/badges and explicit Disconnect use the canonical endpoint alias and preserve unrelated display-alias sessions.
- `remote-NEW-3 / UX-REM-05`: reconnect/nickname prototype-key handling is repaired across banner, store, sidebar and palette; actual own nicknames are preserved.

Prior CHANGES on `445bc89` and `c9cf480` are resolved by their follow-ups. The seven-commit batch is approved as a complete sequence, not as independent approval to integrate either intermediate fix alone. Batch 1 has already been integrated by main, per lead's resume instruction. Palette/keymap Disconnect and direct unsaved ad-hoc lifecycle access remain parked backlog; backend G-10/remote-03 is outside this FE verdict.

Latest routing instruction honored: notify **ux-remote-lead**, which will forward READY to main. No direct main notification required. Reviewer is idle after handoff; no active build or test process.
