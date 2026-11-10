# Remote FE batch 2 — independent review

Reviewed actual code through **0454ba0**, using `_report/batch2.diff` over base `76b9b6e` after reversing the R1 overlay. **CHANGES for c9cf480; APPROVE the other three commits.** No Cargo, tsc, full suite or concurrent FE test process run.

## Required change — P2 / NEW-2 wrong-session disconnect

`src/components/Sidebar.tsx:1294` closes `host.alias` as well as `adHocAliasOf(host)`. The saved alias is a user-supplied display name, while its actual ad-hoc session alias is `user@host:port`. A live config connection may share the display alias and point to a different endpoint/user. Once that config alias is removed and hosts are reloaded, the saved row becomes visible; Disconnect on that row closes the unrelated config connection too.

Mocked FE fixture: saved `saved-box → u@box.lan:22`; active target session `one` has alias `u@box.lan:22`, user `u`, IP `10.0.0.2`; another active session `unrelated` has alias `saved-box`, user `different-user`, IP `10.9.9.9`; current config-host list is empty after reload. Clicking the saved row's Disconnect should call close only for `one`. The new expected-failure test fails that assertion because the handler also calls close for `unrelated`. The same harness passes normal connected/connecting cases with two canonical sessions each.

Use the canonical `adHocAliasOf(host)` to close saved-host sessions; a raw display-alias fallback needs actual endpoint validation before it can be treated as that saved host. The new badge/state union at `Sidebar.tsx:1271` / `:1275` should follow the same identity rule: it can presently show the saved row as connected based solely on the unrelated config session. This is a local targeting correction, not a request to expand into the parked G-11 identity redesign.

Test patch: **`_report/remote-r2-review-tests.patch`**, `git apply --check` passed. Contains two positive multi-session close cases, one `it.fails` wrong-session repro, passing deferred-save coverage and own-nickname preservation coverage. Product files were not edited beyond applying the lead's batch overlay.

## Per-commit verdict

| Commit | Verdict | Evidence |
| --- | --- | --- |
| `2c09d18` NEW-1 | **APPROVE** | Accept the revised UX: connection succeeded, so close/connect normally while reporting persistence failure in an error toast and notice history. Existing host/password disk-full cases pass. Independent deferred vault-unlock/save failure test also passes: connection stays connected, callback runs once, password save is attempted, error toast appears and raw error reaches notice detail. All `saveHost`/`vaultSet` callers were checked; no boolean-result caller remains. |
| `c9cf480` NEW-2 | **CHANGES** | Canonical saved-host Disconnect appears and closes connected/connecting sessions correctly, but the raw saved display-alias fallback can close an unrelated session (`Sidebar.tsx:1294`), as reproduced above. |
| `a40e48d` NEW-3 follow-up | **APPROVE** | Repairs all R1 sidebar/palette direct nickname lookups with `nicknameOf`; null-prototype store and favorite group maps handle inherited names. R1 entry-point repros pass as ordinary tests. Independent JSON-loaded own `__proto__`/`constructor`/`toString` nicknames remain intact and resolve to their real display names. No remaining unguarded production nickname lookup found. |
| `0454ba0` reviewer tests | **APPROVE** | Imports the R1 entry-point/refresh fixtures with expected-failure markers removed for repaired cases. Active-both, hidden-tab and duplicate-connected-event assertions still pass. Minor React act warnings in the sidebar filter fixtures are test hygiene, not failures. |

## Executed validation

One authorized single-worker **mocked FE test** process: **exit 0, 15 files / 53 tests passed**, including the one new expected-failure wrong-session repro and existing known remote-04/10 markers. NEW-3 entry-point regressions are ordinary passing tests now. No test retry.

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 \
  src/components/connection \
  src/stores/__review__/remote-sol-r1-prototype-alias.test.tsx \
  src/lib/hostAlias.test.ts src/lib/hostLabel.test.ts \
  src/hooks/useConnectionEvents.test.tsx \
  src/hooks/__review__/remote-sol-r1-refresh.test.tsx \
  _report/remote-batch2-disconnect-review.test.tsx \
  _report/remote-batch2-vault-review.test.tsx \
  _report/remote-batch2-nickname-review.test.ts
```

`git diff --check` passed. New review fixtures formatted after execution (formatting only). No live app or SSH behavior claimed. Palette/keymap Disconnect stays parked per handoff; direct unsaved ad-hoc sessions still lack that lifecycle entry, outside this saved-host change. FE process exited and slot release was sent to lead. Cargo remains idle until the explicit team-slot grant; shared-target/profile instructions recorded.
