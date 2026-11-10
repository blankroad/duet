# remote — lead report (in progress)

Lead: ux-remote-lead (Opus 5.5), w7:p1, branch `ux-smoke/remote`, worktree /tmp/duet-ux-smoke-worktrees/remote, base 76b9b6e.
Evidence labels: **mocked FE** = vitest with mocked IPC (not a live app test); **unit** = cargo lib test; **docker IT** = live sshd fixture; **static** = code reading.

## Fixes by the lead

| ID | Symptom | Fix | Commit | Evidence | Review |
|---|---|---|---|---|---|
| remote-30 | ad-hoc alias `first.last@corp.com@srv:22` split at first `@` → reconnect/favorites go to `corp.com@srv` | split at last `@` (`src/lib/hostAlias.ts`) | 7ba7bcc | mocked FE: `remote-lead-host-alias.test.ts` (it.fails removed) + `hostAlias.test.ts` 14/14 | Sol R1 APPROVE |
| remote-27 | after auto-reconnect panes keep pre-drop listing | `useConnectionEvents(refresh)`: connecting/error→connected refreshes active tabs on that id | bb2fe92 | mocked FE: `useConnectionEvents.test.tsx` 2/2; **fails 2/2 without fix** (stash check); Sol extra `remote-sol-r1-refresh.test.tsx` | Sol R1 APPROVE |
| remote-NEW-3 / UX-REM-05 | aliases `constructor`/`toString`/`__proto__` look permanently reconnecting; labels render prototype members; sidebar filter throws | `isReconnecting` (Object.hasOwn), registry via fromEntries, prototype-free stateByAlias / nickname store / favGroups, `nicknameOf` at all nickname reads | 445bc89, a40e48d | mocked FE: prototype-alias (3), new3-entrypoints (Sol, 4), hostLabel, sidebar suites | R1 CHANGES → R2 pending |
| remote-NEW-1 / UX-REM-03 | ad-hoc "save host/password" failures close the dialog silently | stores return `DuetError \| null`; dialog shows error toast, keeps connection | 2c09d18 | mocked FE: save-failure (2) | R1 pending |
| remote-NEW-2 / UX-REM-04 | no Disconnect for healthy saved/ad-hoc sessions; saved row state/badge off while connected | saved row matches saved alias and `user@host:port`; Disconnect while connected/connecting | c9cf480 | mocked FE: saved-disconnect (1), sidebar suites 51/51 | R1 pending |
| remote-11 / remote-25 (= SC-29, browse s10) | remote filename search inside a hidden folder returns 0; names with newline split into two fake hits | `build_remote_find_cmd`: `-mindepth 1` + prune hidden descendants; `-print0 \| tr '\012\000' '\000\012' \| head -n N`; parser maps NUL→newline | uncommitted (cargo-gated) | unit tests run the generated command with `/bin/sh` on temp dirs (pending slot) | — |
| remote-12 | sudo upload staging fails every time (`~/.duet-sudo` parent never created); partial staging left on upload failure | create parent (ignore exists), propagate root mkdir error, remove staging on upload error | uncommitted (cargo-gated) | docker IT repro `review_remote_opus_r2`/`sol_ssh` (pending slot) | — |

## Validation log (lead)
- `pnpm exec vitest run src/lib/__review__/remote-lead-host-alias.test.ts src/lib/hostAlias` → 2 files, 14 passed.
- `pnpm exec vitest run src/hooks/useConnectionEvents.test.tsx ...` → pass; with fix stashed → 2 failed (expected).
- Default-worker vitest of `src/components/pane` under memory pressure → 28 timing failures in App-level browse review tests; same files **pass single-worker** on both base (remote-sol tree) and branch → load artefact, not a regression.
- Single-worker: connection/ 7 files 23 passed; sidebar suites 3 files 51 passed; NEW-3/refresh/prototype/hostLabel/dynamicCommands 7 files 64 passed.
- `pnpm exec tsc --noEmit` OK, eslint OK on changed files (after each commit).

## Coordination
- browse lead: remote owns remote find builder/parser in core/search.rs; browse edits only LocalContentSearch body. browse-02/17/18/22 routed to remote (backlog this round).
- sync lead: remote-03 OK with conditions (pure token swap in three_way.rs; link-leaf tests; no mirror_dir/prune_pass).
- fileops lead: OK with mechanical G-10 lock-site edits in ops.rs.
- shell lead: not editing Sidebar.tsx.
- Sol cannot commit (sandbox blocks shared .git index); lead commits Sol's tests with attribution in the message.
