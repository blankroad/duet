# browse — UX smoke final report

2026-11-10 ~ 11-11 · workspace w6 · lead ux-browse-lead (Claude Opus 5.5) · implementation ux-browse-opus (Claude Opus 5.5, auto mode) · independent review ux-browse-sol (Codex gpt-6.1-sol high, workspace-write sandbox).
Branches off base `76b9b6e`: module branch `ux-smoke/browse` (lead; Opus commits cherry-picked onto it), `ux-smoke/browse-opus`, `ux-smoke/browse-sol` (Sol never commits; its patches were committed by the lead).

## Summary

- 18 browse issues fixed in a bounded set: 8 known issues that already had failing repro tests (browse-03/08/09/16/20/25/26/28), 5 new workflow bugs from the smoke baseline (UX-BRW-05..09), 4 search/index bugs routed to browse (SC-18/20/25/27), and UX-BRW-03, which is the same bug as browse-09.
- **Integrated by main:** FE1 (12 commits → main `b89f5c8..569e67f`).
- **Integrated by main:** FE2, 4 commits for browse-08 and browse-16 (Sol R2 APPROVE) → main `fa2d520, 8e7e27d, a4cb3c9, 197bf87`.
- **Still in review:** the backend search/index set (SC-18/20/25/27). It is in round 3, the last allowed round — see the round log below for the result.
- Evidence types: frontend tests use mocked IPC (React/store/App with mocked Tauri commands). None of them are live desktop-app tests. Backend fixes were checked with real `cargo test` runs on tempdir fixtures. Sol's "isolated rustc probe" (production functions extracted and compiled with std-only rustc) is labelled STATIC+.

## Fixed

| ID | What changes for the user | Module-branch commit(s) | Main | Tests | Sol verdict |
|---|---|---|---|---|---|
| browse-03 | A quick filter drops hidden entries from the selection, so copy/move/delete/drag/clipboard/context menu no longer act on files you can't see. Pruning is permanent, like the hidden-file toggle (main ACK) | ed9b319 | b89f5c8.. (FE1) | browse-panes, browse-sol2-state, panes.test | R1 APPROVE |
| browse-09 / UX-BRW-03 | "Calculate size" with only a cursor measures the folder under the cursor (it used the raw array index before) | 7116980 | FE1 | browse-dir-size-race, browse-opus2-app | R1 APPROVE |
| browse-20 | A folder-size result that arrives after the tab has navigated away is discarded | b49ea77 | FE1 | browse-dir-size-race | R1 APPROVE |
| browse-25 | Pattern select `[!a]*` is negated; `\` inside a class is literal | e260a36 | FE1 | glob.test, browse-panes | R1 APPROVE |
| browse-28 | Size sort uses computed folder sizes; the cursor stays on its item | d453bc1 | FE1 | panes.test, browse-sol2-state | R1 APPROVE |
| browse-26 | Pending session save is flushed on title-bar close / quit / pagehide | 4677366 | FE1 | session.test, browse-sol2-session-toast | R1 APPROVE (native close event unverified) |
| UX-BRW-05 (s01) | Old search results can't be clicked while a new query runs | 6b4268f | FE1 | ux-smoke-browse-search | R1 APPROVE |
| UX-BRW-06 (s02) | Closing the search panel cancels a running content search (`searchCancel`) | d12403f | FE1 | ux-smoke-browse-search | R1 APPROVE (backend process termination not tested) |
| UX-BRW-07 (s04) | Jumper Enter waits until the current query has answered | 068224a | FE1 | ux-smoke-browse-jumper | R1 APPROVE |
| UX-BRW-08 (s06/s07) | Swapping panes or moving the tab while a folder enter/up is loading keeps the navigation. **Enter/up only — `navigateTo` (bookmarks/back/forward) is not covered** | eca6a7b | FE1 | ux-smoke-browse-tabs | R1 APPROVE (enter/up scope) |
| UX-BRW-09 (s11) | Ctrl+D on a starred SSH folder removes the favorite, like the path-bar ★ | 524a2b6 | FE1 | ux-smoke-browse-tabs s11 (negative control fails without fix) | R1 APPROVE |
| browse-08 | Markdown preview links don't navigate the app window (click, middle click, Enter/Space). There is no backend open-URL command, so the click is ignored and the address shows as a tooltip | 23f0c03 + 0ba87da | fa2d520, 8e7e27d (FE2) | browse-lead-preview, browse-sol2-preview-perf | R1 CHANGES (Enter) → R2 APPROVE |
| browse-16 | Grid thumbnails reload when the image changes; failure state is keyed by the full URL | dfccc8c + 997facb | a4cb3c9, 197bf87 (FE2) | browse-thumbnail-refresh | R1 CHANGES (identity) → R2 APPROVE |
| SC-20 | Local content search applies the size/date/kind filters (remote content filtering not included) | ccfc5db | pending BE | cargo `content_search_honors_metadata_filters` | R1 APPROVE (static), cargo pass |
| SC-27 | Filename index search skips dot-hidden entries below the search folder unless "include hidden" is on. Windows hidden attribute not stored → not applied | 0fba4eb | pending BE | cargo `index_respects_hidden_exclusion`, `global_query_hides_dot_entries_unless_asked` | in R3 |
| SC-25 | Index cache filenames no longer collide (`a-b` vs `a_b`) and stay within byte limits for Korean paths | 0fba4eb + 8f9547e | pending BE | cargo `index_cache_names_do_not_alias_different_roots`, `cache_name_stays_short_for_long_unicode_roots` | R1/R2 findings fixed; in R3 |
| SC-18 | Folder [Reindex] updates the global index that search uses, including while a startup global build is running | 0fba4eb + 8f9547e + 7615754 | pending BE | cargo `global_results_reflect_folder_reindex`, `global_publish_during_build_keeps_completed_reindex`, R2 schedule tests | R1 CHANGES → R2 CHANGES → R3 (final) |

Test-only commits: 7d10ad9 (Sol Phase 1 repros browse-s01..s15, FE1), f66dd0e (probe updated for the backend fixes, BE set).

## Commands and results

- FE1 dry run (scratch worktree at main 62c6c37 + 12 picks): `pnpm exec tsc --noEmit` → 0; `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 <14 touched test files> src/components/SearchPanel.test.tsx` → 15 files / 184 passed. Main re-ran the same after integrating: 15 / 184, tsc passed.
- FE2 dry run (main 8fc67b5 + 4 picks): vitest 4 files / 14 passed. tsc errors were only in `src/lib/shellMenu.ts:96,106`, from stale copied `bindings.ts` against shell's IPC change — not browse files.
- Consolidated module branch before FE2: 19 files / 191 passed, 2 failed. Both failures were the F4 edit assertions, which need shell UX-SHL-07; that fix is on main, where they pass.
- Cargo (lead tree, own target `/tmp/duet-ux-browse-target`, JOBS=2, test profile opt-level 0):
  - `cargo test --lib -- file_index core::search` → 35 passed (R1 code).
  - `cargo test --lib --test review_sync_compare_sol -- file_index core::search search index` → lib 38 passed / 1 ignored, integration 8 passed (R2 code; log `/tmp/duet-ux-smoke-worktrees/browse-lead-cargo-r2.log`).
  - R3 run: see the round log below.
- Clippy: not run by browse on the backend set; main's integration gate covers it.

## Rounds

| Round | Implementation | Sol verdict |
|---|---|---|
| R1 | batch A (8 FE) + R1b (UX-BRW-05..08) by opus; SC-18/20/25/27 + UX-BRW-09 by lead | 14 APPROVE; CHANGES: browse-08 Enter, SC-18 publish overwrite, SC-25 byte length, browse-16 identity |
| R2 | 0ba87da, 997facb (opus); 8f9547e (lead) | browse-08/16 APPROVE; 8f9547e CHANGES (R2-01 newer build prunes older build's overlay P2, R2-02 equal-ms stale overlay P3) |
| R3 | 7615754 (lead): sequence-ordered overlays, pruned to oldest running build | APPROVE (static + isolated probe); R3 cargo run still queued, so the BE set is not integrated yet |

## Not fixed — deduplicated backlog (handed off or parked)

| ID | Status | Owner / reason |
|---|---|---|
| browse-19, browse-21, browse-27 | deferred | live in `src-tauri/src/fs/local.rs`, which has the user's uncommitted work (main ACK) |
| browse-32, browse-34 | fixed by archive (G-07, main 8fa018a/cc0bd8f) | archive |
| browse-02, browse-17, browse-22, browse-18 | routed | remote (edit_session.rs, fs/ssh.rs) |
| SC-29 = remote-25 (browse-s10) | routed | remote `-print0` fix in core/search.rs |
| F4 edit unreachable (smoke controls) | fixed by shell UX-SHL-07 (main 88f7d99/c6aaa3d) | shell |
| SC-07, SC-35 | routed / parked | sync |
| SC-42 (search reindex failure silent, ↑↓ traversal; s03/s12) | parked P2/P3 | browse backlog; repros it.fails in ux-smoke-browse-search |
| SC-48 (jumper multi-word, alias/IP label, stale dirs; s13) | parked P3 | browse backlog |
| SC-49 (8 MiB silent skip, FE/BE ignore-glob mismatch; s14/s15) | parked P3 | browse backlog |
| SC-19 (startup full-drive index, duplicate build in StrictMode; s05) | parked | drive scope/persistence is a product decision; only the duplicate-build guard is cheap |
| UX-BRW-01 (multi-select Bookmark records only the clicked child) | parked | needs policy: bookmark all selected folders vs. disable on multi-select |
| UX-BRW-04 (QuickLook / open in other pane use cursor, not selection) | documented as intended | — |
| UX-BRW-08 navigateTo path | parked | bookmarks/back/forward while a listing is pending; the fix covers enter/up only |
| browse-07, 12, 13, 15, 24, 29 | parked (prior 11-08 P2/P3) | big-text preview freeze, shared watcher, event coalescing, failed listing shown as empty, sync-browse notice, cache bounds |
| SC-20 remote content filters | parked | remote content search still ignores size/date/kind (remote-owned command builder) |
| SC-27 Windows hidden attribute | limit | index stores no attribute bit |

## Platform and live limits

- No live desktop run: every frontend result uses mocked IPC. Native window close (browse-26), real webview link navigation (browse-08), real image decode and cache (browse-16), and OS process cancellation (UX-BRW-06) are unverified.
- The backend index runs were macOS tempdir fixtures only. Windows drive roots/UNC prefixes for the reindex splice were checked by path-prefix review only.
- Remote search and SSH were not exercised.

## Coordination

- Selection contract: browse-03 changes only `setFilter` in panes.ts; no API used by fileActions.ts or useEntryDrag.ts changed (fileops informed).
- `core/search.rs`: browse edited only the `LocalContentSearch` body (remote informed). `review_sync_compare_sol.rs`: only 5 `#[ignore]` lines removed (sync informed).
- Archive G-07 regions in panes.ts/session.ts/App.tsx were avoided; FE1 picks were clean on main after G-07.
