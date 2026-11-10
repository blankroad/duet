# Browse Phase 1 independent smoke baseline

Worker: browse-sol; branch `ux-smoke/browse-sol`; base `76b9b6e8b61608168b42a135a7a888422a3b1c60`. Phase 2 has not started. Product code is unchanged. Report and run artifacts are untracked, inside this worktree.

Read CLAUDE.md, ARCHITECTURE.md, the orchestration PROTOCOL, the 11-08 browse and sync-compare reports, and the 11-10 browse fix report. Excluded the implementation worker's assigned browse-03/08/09/16/20/25/26/28. No changes to main checkout, remote-owned core/search.rs, dependencies, or generated bindings in git. Offline frozen install succeeded; copied gitignored bindings from main as instructed. No sandbox escalation, native app, real SSH, user-file fixture, full Vitest suite, or Cargo build.

## Evidence definitions

- **Mocked IPC repro test**: real React component/App/store and events, command return values controlled by tests. This is not a live-app test.
- **Isolated Rust repro test**: Vitest extracts current production Rust declarations and invokes std-only `rustc --test`, with ASCII fixtures. No Cargo/Tauri build or real SSH. Unicode helpers are identity stubs, and the frecency query's async lock is replaced with a synchronous lock; its filtering/ranking body is unchanged. No Unicode, persistence integration, transport, or OS behavior is claimed from these probes.
- **Static, unverified**: current source audit, including executable source assertions where noted. These are not runtime backend reproduction claims.
- `it.fails` means the desired behavior fails on this baseline, so the expected-failure suite passes. Negative-control results are recorded below separately.

## Findings

Commands below use these files, always with `pnpm exec vitest run <file> --minWorkers=1 --maxWorkers=1 --testTimeout=30000`:

- S = `src/components/__review__/ux-smoke-browse-search.test.tsx`
- J = `src/components/__review__/ux-smoke-browse-jumper.test.tsx`
- T = `src/components/pane/__review__/ux-smoke-browse-tabs.test.tsx`
- I = `src/lib/__review__/ux-smoke-browse-index.test.ts`

| ID | Symptom | Root cause file:line | Severity | Evidence type | Test command + result |
|---|---|---|---|---|---|
| browse-s01 | After typing a new search query, the previous result remains clickable and opens its old location while the new search is pending. Enter has a status guard but mouse activation does not. | `src/components/SearchPanel.tsx:345`; results retained by `src/stores/search.ts:63` | P2 | Mocked IPC repro test | S, `-t browse-s01`; expected failure |
| browse-s02 | Closing a pending content search (local or remote) clears UI state but never calls the backend cancellation command. Work remains active until completion or another content search rotates the token. | `src/stores/search.ts:53`; `src/components/SearchPanel.tsx:150` cleanup only clears timer/live flag; cancellation API is `src-tauri/src/commands/search.rs:90` | P2 | Mocked IPC repro test | S, `-t browse-s02`; local + remote expected failures. Does not claim a remote exec process is forcibly terminated by the cancellation token. |
| browse-s03 / SC-42 | Reindex failure is ignored and another search runs against stale cache, without a failure indication. | `src/components/SearchPanel.tsx:77` checks no returned status | P2 | Mocked IPC repro test | S, `-t browse-s03`; expected failure |
| browse-s04 | Change the jumper query and press Enter while its next query is pending: the previous query's highlighted folder opens. Late-response guards alone do not prevent stale activation. | `src/components/FrecencyJumper.tsx:114`, `:130`; old results retained | P2 | Mocked IPC repro test | J, `-t browse-s04`; expected failure |
| browse-s05 / SC-19 | StrictMode mount requests two global index builds. Backend launch has no corresponding in-progress guard. | `src/hooks/useIndexProgressEvents.ts:16`; `src-tauri/src/commands/search.rs:195` | P2 | Mocked IPC repro test (duplicate requests); backend guard absence static | J, `-t browse-s05`; expected failure. Actual drive performance unverified. |
| browse-s06; browse-s07 is same root via moving a tab | Start folder navigation, then swap panes or move the tab to the other pane before the listing resolves: destination is lost and the tab stays at its old folder. | `src/App.tsx:251`, `:267` capture original pane as well as tab ID; `src/stores/panes.ts:581` searches only that pane; moved-pane refresh reads old location | P2 | Mocked IPC App repro tests with explicitly held listing | T, `-t 'browse-s06|browse-s07'`; expected failures |
| browse-s08 / SC-25 | Distinct roots `a-b` and `a_b` map to identical on-disk index filenames, allowing cache confusion after restart. | `src-tauri/src/services/file_index.rs:163` converts every punctuation character to `_` | P2 | Isolated Rust helper repro test; disk reload integration untested | I, `-t browse-s08`; expected failure |
| browse-s09 / SC-27 | A filename query with default hidden exclusion still returns `/fixture/.cache/needle.txt`. Hidden ancestors can consume the 500-result cap. | `src-tauri/src/services/file_index.rs:407` query ignores include_hidden; `:482` collects hidden entries | P2 | Isolated Rust query repro test | I, `-t browse-s09`; expected failure. Windows hidden attributes unverified. |
| browse-s10 / SC-29 | A remote path with an embedded newline parses as multiple hits. The index builder uses the same line-based framing. | `src-tauri/src/core/search.rs:512`; `src-tauri/src/commands/search.rs:120` | P3 | Isolated Rust parser repro test; command index builder is static corroboration | I, `-t browse-s10`; expected failure. Report only; no edit to remote-owned core/search.rs. |
| browse-s11 | Ctrl+D on an already bookmarked SSH folder calls add instead of removing the favorite, unlike the path-bar star. | `src/App.tsx:1107` SSH branch always calls bookmarkLocation; compare `src/components/pane/PathBar.tsx:192` | P2 | Mocked IPC App repro test | T, `-t browse-s11`; expected failure |
| browse-s12 / SC-42 | Search result ArrowDown then Enter still opens the first result; result keyboard traversal is absent. | `src/components/SearchPanel.tsx:185` always chooses results[0] | P3 | Mocked IPC repro test | S, `-t browse-s12`; expected failure |
| browse-s13 / SC-48 | Jumper query `proj src` cannot match `/fixture/proj/app/src`. | `src-tauri/src/services/frecency.rs:142` whole-string contains | P3 | Isolated Rust query repro test, async lock replaced for isolation | I, `-t browse-s13`; expected failure |
| browse-s14, browse-s15 / SC-49 | FE pattern matching and backend compare ignore globs disagree on case (`*.LOG`) and plain substring patterns (`node_modules`). | `src-tauri/src/core/compare.rs:135`; `src/lib/glob.ts` | P3 | Production FE matcher + isolated Rust matcher repro tests | I, `-t 'browse-s14|browse-s15'`; expected failures. This concerns compare ignore rules, not a search-panel glob control. |

## Requested 11-08 item current-state audit

| Prior ID | Still reproduces? | Current evidence/test |
|---|---|---|
| SC-18 | Source still shows defect; runtime **unverified** | I has a passing explicitly static source audit: `index_search` prefers global results while `index_reindex` only calls folder `build_index_for`/`build_local`. Existing ignored Rust reproduction `services/file_index.rs::review_sync_compare::global_results_reflect_folder_reindex` remains present but was not run. |
| SC-19 | **Yes**, duplicate frontend build requests | browse-s05. Restart full-drive scan and removable/network-volume traversal remain **static, unverified** at `file_index.rs:185`, `:297`; native cost/permission prompts not claimed. |
| SC-20 | Source still shows defect; runtime **unverified** | I passing static audit confirms both LocalContentSearch and SshContentSearch omit metadata filter application. Local content body reads and emits matching files without opts.accepts; remote command uses only case/hidden/max-results. Filename metadata controls are separately covered by existing SearchPanel.test.tsx, not evidence of content filtering. |
| SC-25 | **Yes**, filename collision | browse-s08. |
| SC-26 | **No** in the isolated validator probe; load integration static | I positive test rejects bad array lengths, offsets and UTF-8 boundaries; `load_from_disk` calls `is_consistent` before using a cache at `file_index.rs:219`. No full backend panic/integration test run. |
| SC-27 | **Yes**, default filename query exposes hidden ancestor | browse-s09. |
| SC-29 | **Yes**, newline parser corruption | browse-s10. No actual SSH or remote filename creation. |
| SC-42 | **Yes** | browse-s03, browse-s12 plus existing `sync-compare-search.test.tsx` for indexing status taking precedence over hit count and missing reindex busy feedback. |
| SC-48 | **Yes**, multiple subitems | browse-s13 multiword query; existing `sync-compare-jumper.test.tsx` checks saved host alias falling back to IP and duplicate React keys when aliases share IP/path. Alias-based reconnect callback and IME control are positive tests. Removed-directory history retention and initial-consonant search remain source-only/unverified for the jumper backend. |
| SC-49 | **Yes** for FE/BE glob mismatch; 8MiB limit is **static, unverified** | browse-s14/s15. I static audit confirms `CONTENT_MAX_FILE_BYTES = 8 * 1024 * 1024` and silent continue at `core/search.rs:281`. No live large-file search was run. |

## Coverage and boundaries

Search entry is the built-in `search.global` (shortcut/palette, opens the active tab's location). No dedicated search item in the file context menu/toolbar. Selection does not change the root. Tests exercise local/remote roots, content/name rerun, result activation, close/Escape, failure, and discarding late responses. Existing App navigation tests establish result navigation with full source; this review does not claim live navigation/SSH results.

Jumper entry is `nav.jump` (shortcut/palette). Tests exercise query changes, pending Enter, alias callback on disconnected entries, IME, and stale remote labels/keys. No selection-specific target or separate context-menu/toolbar entry exists.

Bookmarks: path-bar star, Ctrl+D/palette, sidebar add/remove/context actions share stores but remote toggling differs (s11). Added positive mocked tests cover local add/dedup/rename/remove, stable bookmark tag ID, and refusing to save a dead ephemeral SSH ID. App control covers the palette's disconnected SSH favorite command opening a connection dialog and cancelling without an SSH listing. No actual connection is made.

Tags: the feature is for sidebar `host:<alias>`, `bm:<id>`, and `fav:<id>` keys, not files. There is no file multi-selection tag/untag, file-rename tag migration, or file-move tag migration contract to exercise. These requested file cases are **not applicable**, rather than a reproduced bug. Positive tests cover sidebar tag/untag, prompt cancellation, stable bookmark rename key, active filter recovery after final tag removal, and existing error-toast tests. Backend tag persistence is not integration-tested here.

Remote/archive selection: real App keyboard controls exercise Shift range, Ctrl+A, invert, pattern selection (store action), Ctrl toggle (store action matching Pane handler), mixed file/folder selection, F2 batch-rename cancellation, F4 edit dispatch, F5/F6/Delete plan failure, and F7 mkdir cancellation. These verify correct source and selected names reaching mocked IPC. Archive edits operate on extracted temporary content by current design; no repack/discard or live SSH semantics are claimed. Mouse Ctrl/Shift are inspected in Pane.tsx but this new App test uses the shared selection actions for Ctrl-toggle and pattern selection. Existing local file-view smoke tests cover actual pointer entry.

Tabs: duplicate/close/reopen during a held listing, swap/move during a held listing, sync-browse success/counterpart failure, and duplicate/close/reopen during a pending preview. Sync-browse's silent missing-counterpart behavior is already browse-24 and is not counted as new. Listing and preview controls use only fixture locations.

## Verification

Pending final run and negative-control assertion audit. No product fixes are included. Phase 2 is waiting for the lead's prompt.
