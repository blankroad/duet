# Backend R1 — independent static review

**Current verdict: APPROVE on static review through `4af7519`, with required dependency and execution limits below.** B1/B2 fixes were independently read. One expressly leased Cargo command was executed in Opus's tree; no other tests were started. Required Docker/SFTP evidence and the new default-walker integration tests are still pending; this is not final integration approval.

## Findings / integration conditions

1. **B1 — addressed by `ef9e4f2`, within its documented cleanup window.** `ssh/remote_exec.rs:64–75` retains the pending open and its `Arc<Handle>` after the caller's deadline. A late successful channel is closed without executing the abandoned command or disconnecting unrelated channels. The in-process russh delayed-confirmation test (`ssh/remote_exec.rs:405`) **passed in the leased cargo unit run**: a 50ms caller deadline precedes a 300ms confirmation, and the server observes one open and one close. `services/connection_pool.rs:34` and constructors consistently use Arc. Limit: cleanup waits 120s after timeout; a peer that answers keepalives but withholds confirmation longer can outlive that grace. The comment about keepalive is a silent-peer assumption, not an unconditional resource-cleanup guarantee. A subsequent successful open on the same connection is not asserted by this unit test.

2. **B2 — addressed statically by `96d931b` + `4af7519`.** `fs/mod.rs:87` now propagates an lstat error instead of emitting an unverified Dir; successful non-Dir lstat results replace the display kind. `tests/remote03_walk_links.rs:529` adds failing-lstat/compare-Unreadable and kind-change coverage. The mock's underlying LocalFs remains listable, exercising the former fail-open assumption. **These integration tests were read but not executed by Sol**; the `--lib -- ssh::` lease does not compile integration-test targets. Existing three-way list-error handling is unchanged; its pure token-swap constraint remains satisfied.

3. **B3 — satisfied statically as an explicit integration dependency.** Independently read actual commit `912bf01ab1d8c0c2054b6fca98d9e139d0b57f26` on `ux-smoke/sync-opus`. Its `sync_execute` re-derives `current = decide_fs(src_fs, &plan.src.source, dst_fs, &plan.dst.source)`, rejects unsupported effective strategies, and rejects `current != plan.strategy` before path walking/mirror/prune. `sync_preview` checks the effective strategy before traversal too. This blocks the forged LocalToLocal/Relay raw-IPC path identified in R1; valid same-host execution stays on server rsync, so the retained display-list mirror/prune cannot receive an SshFs through these commands. The new `sync_relay_guard_tests` includes forged LocalToLocal and Relay plans with an untouchable remote mock and an empty-journal assertion. **Static dependency review only: uncompiled/unexecuted by Sol; broader sync review remains with sync's reviewer.** Integrate `912bf01` before remote `9fe7819` and preserve the guards when resolving shared ops.rs conflicts.

## Executed evidence — cargo unit

Explicit lease, in `/tmp/duet-ux-smoke-worktrees/remote-opus/src-tauri`:

```sh
CARGO_TARGET_DIR=/tmp/duet-ux-target-remote CARGO_BUILD_JOBS=2 cargo test --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 --lib -- ssh::
```

Exit 0: **40 passed, 0 failed, 1 ignored, 722 filtered out**. Compile 40.76s; test run 0.41s. Includes delayed channel-open cleanup, direct/jump silent-peer deadlines, and `fs::ssh::` exact-kind/display-vs-walk unit tests (substring filter). The ignored test is the pre-existing remote-02 TOFU repro. The child known_hosts isolation test prints its own one-test result; it is not an additional top-level test. Lead was notified immediately on exit; no further Cargo command ran.

## Preliminary findings already corrected

- `02b2a68`: the two stale `Some(Mutex::new(handle))` ActiveConnection constructors at `tests/review_remote_sol_r2.rs:209` and `tests/review_remote_opus_sftp.rs:857` were converted to bare handles there, then to Arc in ef9e4f2. No remaining stale constructor found in tests. This resolves the source type mismatch; library compilation passed; integration-test constructors remain statically checked only.
- `fe126e2`: `tests/remote03_sftp_links.rs` now seeds a counterpart local R tree and is cfg(unix). Earlier, comparing remote L to an empty directory could not produce `real/inner.txt`, because compare recurses only for Dir on both sides (`core/compare.rs:443`, `:456`). The corrected fixture now exercises that branch. Runtime result remains pending.
- `8613828`: exactly three list→list_for_walk substitutions in count/preview plus a test-module registration. Its mock and TempDir tests are read, not run. Local preview now omits folder-link target contents; that changed local behavior is explicitly documented in the commit/test comments. Mirror/prune remain unchanged for sync ownership.

## Per-commit static verdict

| Commit(s) | Verdict | Reason / source |
| --- | --- | --- |
| `d93f9f7` | **APPROVE (static)** | Chaos container can be selected per team; default behavior unchanged. Execution must set DUET_SSH_IT_CHAOS to the owned fixture. |
| `1a08cd1`, `800dc31` | **APPROVE (static)** | Outer timeout encloses the entire direct/jump sequence (`ssh/connection.rs:943`), including tunnel opens, nested handshakes and auth; direct public key/agent/password APIs are also wrapped. Silent direct and first-jump tests passed in the leased cargo unit run. Note the 30s contract is per public connect call; command-level key→password fallback can make two calls. |
| `4067083`, `00a8a00`, `5757f89`, `02b2a68` | **APPROVE (with ef9e4f2)** | Shared Handle use and mechanical caller conversion look sound; russh channel-open/disconnect/is_closed use &self and opens have separate receivers. Session Mutex removal is complete in inspected production sites. B1 fix adds Arc ownership and delayed cleanup; library Send+Sync assertions compiled/passed. Docker concurrency remains pending. |
| `2f1ca61` | **APPROVE (static)** | Only the two read-only SSH search backends use exec_cancellable (`core/search.rs:401`, `:494`); destructive cp/rsync/archive/sudo remain non-cancellable mid-command. No new destructive cancel path found. |
| `0cc062d`, `ebcc8fb` | **APPROVE (static, with 02b2a68)** | Measurements become assertions and Handle/cancel/close coverage is added. Pipeline termination, close latency and paused-peer assertions are not executed evidence yet. |
| `85a9708`, `96d931b`, `4af7519` | **APPROVE (static)** | B2 fail-closed fix and mock coverage read; integration tests pending. |
| `23c08ea`, `e97bb74` | **APPROVE (static)** | three_way.rs is exactly three list→list_for_walk token swaps, preserving error handling. compare has the same two-token change plus formatting; backup collection has one token swap. Local behavior change is documented; tests cover local/remote-like loops and apply/merge target protection, pending execution. |
| `9fe7819`, `fe126e2` | **APPROVE (static; dependency required)** | Exact file_type matching and SshFs display/walk split look correct; fixture repaired by fe126e2. Guard 912bf01 was independently inspected and satisfies B3 statically; it must integrate first. Actual required SFTP execution evidence is still pending; this is not final merge approval. |
| `8613828` | **APPROVE (static)** | Count and both preview walkers no longer consume display Dir links; tests cover remote-like and local relative/absolute/loop links. It does not replace B3's sync execute guard. |

## Recursive-consumer audit

Scanned production FileSystem list/read_dir calls, their recursive callees, dispatch and source reachability; test/store list calls were excluded from the walker inventory. Evidence below is **static reading** throughout.

| Consumer | Source / recursion decision | Assessment |
| --- | --- | --- |
| Compare | `core/compare.rs:386`; recursive only when both kinds Dir (`:456`) | list_for_walk; no newly followed SFTP folder links. Root is explicitly selected by user; a remote symlink root is intentionally followed by stat/list. |
| Three-way | `core/three_way.rs:183` | Three pure token swaps; requested sync condition satisfied. |
| Same-host sync backup collection | `core/ops.rs:1641` | list_for_walk; link is collected as one backup, not traversed. |
| Count / copy-preview / prune-preview | `core/ops.rs:1208`, `:1735`, `:1771` | list_for_walk after 8613828; new tests pending. |
| In-Rust mirror / prune | `core/ops.rs:1341`, `:1410` | display list remains; independently reviewed dependency 912bf01 excludes remote effective strategies and forged flags. Integrate the guard first (B3). Same-host execution uses server rsync. |
| Relay copy_tree | `fs/mod.rs:408`, `:413` | Each recursive child rechecks lstat before descending; parent list kind is not the descent decision. File links copy contents; folder-link copy fails rather than recursing (existing behavior). |
| SFTP recursive remove | `fs/ssh.rs:737` | Each child lstat + exact entry_kind; unlink links, descend real dirs. |
| Stamp/digest walk | `core/stamp.rs:134`, `:137` | Lists names then re-lstats each child; error propagates, link is a leaf. Older stamps containing previously misclassified remote links can become stale on undo (safe skip, documented by Opus). |
| Sudo staging upload | `core/sudo.rs:135`, `:138` | Recursion is based on metadata/stat before listing, so links were already followed before this change. Existing G-12 risk, not a new list-kind regression. |
| dir_size | `fs/mod.rs:218`; `fs/ssh.rs:183` | SshFs overrides the trait recursion with server du; no fallback into default list recursion. Local/default recursion unchanged. |
| Search/index | `core/search.rs`, `commands/search.rs:109` | Server find, not a FileSystem list walker; default no-follow command form unchanged. |
| Pane, remote volumes, repack plan, path-name resolution | `commands/pane.rs:25`, `commands/system.rs:613`, `core/archive.rs:1029`, `core/compare.rs:316` | Non-recursive listings, or finite traversal of explicitly supplied path components; not whole-tree list walkers. |
| Undo empty-dir inspection / cleanup | `core/undo.rs:215`, `:346`; `core/undo/cleanup.rs:293` | Non-recursive list checks; directory removal uses empty-dir operations. |
| Local archive/elevated/native walkers | std::fs/tokio read_dir sites | Local path implementation only; do not receive an SshFs. Remote archive recursion runs on server, pre-existing link policy unchanged. |

## G-10 boundaries / pending execution

- No SSH session guard spans an await in the reviewed code. Pool locks are released before network I/O. Existing rsync-availability cache locks still span the detection exec; these are narrower cache locks, not session locks, and do not block listing/health/close.
- 20s bounds session-channel opening; later SFTP init/requests use the library's request timeout. General exec intentionally has no overall deadline. Search cancellation is checked before run and during output pumping; a cancellation arriving during channel-open/start is not observed until that phase completes (up to the open limit). This latency is not covered by the healthy-channel cancel test.
- TERM/close are best-effort queued requests; whether the remote process group is gone must be established by the provided Docker test. Source review is not proof of OpenSSH signal handling.
- Channel-open timeout occurs before exec is submitted, so treating that ConnectionFailed as retryable does not itself repeat a partially executed destructive command. ef9e4f2 handles late opens within its 120s grace; see the explicit residual limit above.
- Required remote-03 scenarios are represented in test source: symlink root, relative/absolute target, broken link, self/parent loop, permission-denied directory. Non-UTF8-name behavior is a printed observation, not an asserted contract. Docker outcomes and default-walker integration tests remain **pending**; the leased SSH library results are recorded above.

`git diff --check 76b9b6e 4af7519` passed. No production edits or test patches were applied to either tree. Later commits `bd8e57b` (accept already-completed read-only search before cancellation) and `0a9f59b` (ProbeFs lstat override for its real mock directories) were also read statically: APPROVE, not executed by Sol. They do not change the production assessment above. Further Cargo requires a fresh explicit lease.
