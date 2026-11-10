# remote team brief (lead: ux-remote-lead, w7:p1)

Read first: `docs/reviews/2026-11-10-ux-smoke/PROTOCOL.md`, `CLAUDE.md`, `ARCHITECTURE.md`,
`docs/reviews/2026-11-08-functional-review/remote.md` (issue IDs remote-NN), `docs/reviews/2026-11-10-fix-round/README.md`.
Report folder (main checkout, docs only): `/Users/ctmctm/Desktop/01_PROJECT/duet/docs/reviews/2026-11-10-ux-smoke/remote/`.

## Team
| agent | pane | worktree | branch |
|---|---|---|---|
| ux-remote-lead (Opus 5.5) | w7:p1 | /tmp/duet-ux-smoke-worktrees/remote | ux-smoke/remote |
| ux-remote-opus (Opus 5.5, analysis/impl) | w7:p2 | /tmp/duet-ux-smoke-worktrees/remote-opus | ux-smoke/remote-opus |
| ux-remote-sol (Codex gpt-6.1-sol, independent review) | w7:p3 | /tmp/duet-ux-smoke-worktrees/remote-sol | ux-smoke/remote-sol |
Base 76b9b6e8. Only edit your own worktree; reports go under the report folder above (one file per agent).

## Scope (remote module)
Connections/auth/reconnect, SFTP listing, remote command flows (exec, search find, sudo), identity, remote source lifecycle
(banner, auto-reconnect, close, temp dirs). NOT ours: archive dialogs/backends (archive lead), native/More context menu (shell lead),
copy/move/delete engine & undo (fileops), nav/search UI & preview (browse), sync. Touching their files = ask the lead first.

## Still-open remote issues on base (from #[ignore]/it.fails markers)
remote-02 (ProxyJump approval scope, G-11 — contract, main), 03 (symlinks listed as files), 04 (vault bound to alias, G-11),
05/06/07 (session Mutex held while opening channels / no connect deadline / exec blocks list+close, G-10), 08 (cross-device trash),
09 (obs), 10 (reconnect leaves clipboard/shelf/undo on old id), 11/25 (search hidden root / newline), 12 (sudo staging parent),
13 (ssh config syntax), 14 (password fallback bypasses ProxyJump), 15/20 (Windows agent / known_hosts, device-only),
16 (passphrase prompt), 18 (browse temp dirs, G-20), 23/24, 27 (no refresh after auto-reconnect), 28, 29, 30 (user with '@'),
31 (Debug on password struct), 32, 33.
Fixed already: 01, 17 (paths), 19/21/22 (persist), 26 (errors), 35.

## Rules (main guidance)
- Preserve user's uncommitted `src-tauri/src/fs/local.rs` in MAIN checkout — never touch main checkout code.
- `CARGO_BUILD_JOBS=2`. Focused tests first (`cargo test --lib <mod>`, `--test <file>`, `pnpm exec vitest run <files>`).
  Do NOT run full vitest; ask lead before a full `cargo test`/`clippy --all-targets` (serialized across teams).
- Never pipe vitest into tail/head (hides exit code). Run `pnpm gen:bindings` if tsc shows phantom binding errors.
- No new dependencies, no `unsafe`, no system ssh, POSIX helpers for remote paths, no unwrap/expect in prod code.
- SSH tests: docker sshd fixture only, isolated HOME (`scripts/ssh-it.sh` does this). Never real user servers/files.
- Distinguish: live docker IT / unit / mocked vitest (never call mocked tests "live app tests") / static hypothesis.
- One concern per commit, scope prefix (`be/ssh:` `fe/store:` `test:`), attribution trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` for Claude commits.
- Permission prompts: never bypass; if blocked, stop and tell the lead.
