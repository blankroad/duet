# Browse independent review — round 1

**Verdict: CHANGES on `cf94e9b`, `0fba4eb`, and `49f2413`; APPROVE on the other fourteen reviewed SHAs, within the scopes below.** Four actionable findings: Markdown Enter isolation, global publication overwriting reindex, Unicode cache filename length, and thumbnail failure identity across folders.

Reviewer: browse-sol. Worktree branch `ux-smoke/browse-sol`, HEAD `76b9b6e8b61608168b42a135a7a888422a3b1c60`. Review completed after the lead's explicit resume following 02:05 KST on 2026-11-11. No commit or index write during review; no Cargo, binding generation, full suite, broad rerun after resume, external app, or real SSH. Reviewed commits were applied locally to execute tests; this tree retains those review changes.

## Per-SHA verdicts

Run labels A/B/C refer to exact commands and evidence below. React/App tests use **mocked IPC**, not a live application. Rust probes are isolated source-extracted tests, not full backend integration.

| SHA | Issue / scope | Verdict | Findings | Commands run + results |
|---|---|---|---|---|
| `6bf87a3` | browse-03 filter-hidden selection | **APPROVE** | Permanent pruning is consistent with the stated trade-off. Range/Shift anchor fallback, select-all, invert, pattern, ordinary/additive marquee and same-folder refresh did not revive concealed names. Existing operation, clipboard, drag, context-menu and status checks passed. | `git show 6bf87a3`; A: relevant supplied regressions plus four reviewer filter/marquee/Markdown controls passed (filter/marquee subset passed). |
| `cf94e9b` | browse-08 Markdown links | **CHANGES** | **R1-01, P2:** click/auxclick suppression works, including autolinks and linked images; focused-link Enter still activates the pane's cursor item. `PreviewContent.tsx:31` / `useKeyboardNav.ts:243`. | `git show cf94e9b`; A: supplied pointer regressions and reviewer autolink/image/raw-HTML control passed; reviewer Enter test failed with `onActivate("left")` called once. |
| `86444ef` | browse-09 displayed cursor size calculation | **APPROVE** | Uses displayed entry, respects sorting/filter/parent row, skips `..`. No concrete regression found. | `git show 86444ef`; A: cursor-folder and `..` controls passed in `browse-dir-size-race.test.ts`. |
| `6dece77` | browse-20 late size result | **APPROVE** | Location/tab guard rejects a result after navigation, while preserving same-folder refresh results. | `git show 6dece77`; A: navigation race and same-folder refresh controls passed. |
| `6d2b005` | browse-25 glob classes | **APPROVE** | Negated classes and literal backslashes behave as intended; ranges, both negation spellings, empty class and existing glob modes passed. | `git show 6d2b005`; A: all 10 `glob.test.ts` cases and relevant review regressions passed. |
| `7baf001` | browse-28 computed folder-size sort | **APPROVE** | Sort uses computed sizes and preserves cursor identity when results reorder entries. | `git show 7baf001`; A: ascending/descending computed-size and same-cursor controls passed. |
| `ccfc5db` | SC-20 local content metadata filters | **APPROVE — static** | `opts.accepts(File, size, modified_ms)` is applied before reading content. The returned timestamp is reused correctly. Remote content filtering is outside this explicitly local-only commit. | `git show ccfc5db`; static read of `core/search.rs:281` onward and the existing metadata-filter regression. Cargo frozen: full Rust test/build **not run**. |
| `0fba4eb` | SC-18/27/25 index refresh, hidden, cache naming | **CHANGES** | **R1-02, P2:** subsequent global publication restores stale scanned data after successful reindex. **R1-03, P3:** a 120-character Unicode prefix can exceed a 255-byte filename budget. POSIX root/component-prefix and hidden-scope controls passed. | `git show 0fba4eb`; A: race failed (new hit 1→0), basic cache collision/hidden/validator and prefix/scope controls passed. B: valid nested Korean root generated **348 UTF-8 bytes**, failing the filename-budget assertion. |
| `7d10ad9` | Phase 1 smoke tests | **APPROVE — external dependency noted** | F4 is **external dependency, passes on main**, per lead confirmation of shell UX-SHL-07 integrated as `88f7d99` / `c6aaa3d`. The two F4 failures on this older local tree are not browse defects and do not block this verdict. | Read committed tests; A exercised the relevant smoke cases. Local F4 controls failed before shell integration; no claim that this reviewer reran main. |
| `524a2b6` | UX-BRW-09 remote Ctrl+D toggle | **APPROVE** | Looks up favorite by stable alias/path and removes an existing favorite; no new ephemeral-ID storage. | `git show 524a2b6`; A and C: browse-s11 passed; disconnected-favorite connection/cancellation control passed. |
| `f66dd0e` | Rust probe adaptations | **APPROVE** | Extracts new helpers, passes search scope and flips fixed cache/hidden cases appropriately. Removing obsolete source assertions is reasonable; it does not establish that frozen Cargo tests ran. | `git show f66dd0e`; A: SC-25 collision, SC-26 validator, SC-27 hidden cases passed. Reviewer extensions separately expose R1-02/R1-03. |
| `49f2413` | browse-16 thumbnails | **CHANGES** | **R1-04, P3:** URL invalidation and retry on changed metadata work, but failure identity omits path/source. A failed `/fixture/photo.png` suppresses `/different-fixture/photo.png` with identical metadata. | `git show 49f2413`; C: both supplied regressions passed; new folder-identity regression failed because the new file still renders no image. Backend query handling reviewed statically (`thumbnail.rs:136` uses URI path). |
| `14d173a` | browse-26 session flush | **APPROVE** | Pending-only flush clears timer and saves synchronously before title-bar close / command quit; pagehide uses the same guard. No schema change. | `git show 14d173a`; C: flush/no-pending/no-duplicate/pagehide test and actual mocked title-bar close test passed. Native OS shutdown/close event delivery remains unverified. |
| `7ac5445` | UX-BRW-05 stale search-result click | **APPROVE** | Disables old rows while status is searching and restores activation after the new result arrives. | `git show 7ac5445`; C: browse-s01 plus fresh-result click control passed. |
| `b0c1d18` | UX-BRW-06 content-search cancellation | **APPROVE** | Remembers in-flight content sequence, cancels on close/unmount and prevents an older completion clearing a newer sequence. | `git show b0c1d18`; C: local/remote close cancellation, no cancellation after completion, and no cancellation of a query replacement passed. Actual backend/remote process termination was not tested. |
| `4c4e966` | UX-BRW-07 jumper Enter | **APPROVE** | Enter requires result query to match current query; mouse behavior intentionally remains unchanged. | `git show 4c4e966`; C: pending-query Enter blocked and completed-query Enter opened the fresh folder. |
| `8aedae0` | UX-BRW-08 pane relocation for folder enter/up | **APPROVE — enter/up scope** | Finds current pane by tab ID before applying listing/loading/watcher updates; tab generation still rejects superseded navigation. The explicitly excluded `navigateTo` path remains a separate integration dependency for bookmarks/back/forward and must not be described as fixed by this SHA. | `git show 8aedae0`; C: swap/move during held listing, duplicate/close/reopen isolation, and sync-browse controls passed. |

## Required changes

### R1-01 — Markdown Enter reaches pane activation (P2, `cf94e9b`)

At `src/components/pane/PreviewContent.tsx:31-40`, the custom anchor only handles click and auxclick. Focus a preview link and press Enter with a file under the pane cursor: the key bubbles to `src/hooks/useKeyboardNav.ts:243-245`, which calls pane activation. The real component/hook test observed one callback, despite the link being intended as display-only. Prevent Enter from reaching the pane handler (stop propagation as well as default behavior), or use a non-navigable presentation element. The global handler does not honor `defaultPrevented`, so default prevention alone is insufficient. Lead reports Opus is acting on this; no follow-up fix SHA was reviewed here.

### R1-02 — global publication overwrites a completed reindex (P2, `0fba4eb`)

`src-tauri/src/services/file_index.rs:318-335` splices fresh folder contents only into the currently published map. A startup/global walker may already have collected that folder into its private builder, then continue walking another subtree. Its later `publish_global` at `:404-407` replaces the entire global index with the old builder snapshot. The isolated production-method probe first observes the new hit after splice, then observes zero after the later publication. This can also restore deleted entries. Preserve reindex overlays/tombstones across every partial/final publication, or invalidate/restart older scan generations; the map's write lock alone cannot reconcile snapshots. Lead reports a fix is in progress; no follow-up SHA was reviewed.

### R1-03 — Unicode cache prefix exceeds byte-limited filenames (P3, `0fba4eb`)

`src-tauri/src/services/file_index.rs:185-191` uses `.chars().take(120)`. A valid nested path with three components of forty Korean characters (120 bytes per component) produces a **348-byte** cache filename. `store_compact` ignores the write error at `:434-435`, so persistence/offline reuse is lost on filesystems with a 255-byte basename limit. Use a bounded ASCII readable prefix, or truncate safely to a byte budget after reserving the hash/suffix. The probe establishes the production helper's output length; no live Linux persistence failure was executed. Lead reports a fix is in progress.

### R1-04 — thumbnail failure leaks across file identities (P3, `49f2413`)

`src/components/pane/EntryGrid.tsx:361-364` stores failure only against `mtime-size`. Grid rows/cells can remain mounted when navigating between folders containing the same basename. After one image errors, a different image with the same basename, size and mtime remains an icon because its metadata version equals the previous failed version. The new mocked component test reproduces this without network/native image decoding. Include full source/path identity in the failed key (for example, the complete versioned thumbnail URL), or remount the thumbnail when that identity changes. The supplied changed-metadata tests still pass.

## Commands and evidence

All Vitest commands use exactly one worker and were sequential. No broad repeat after resume. Existing expected-failure tests count as Vitest passes, not proof that those unrelated defects were fixed.

**A — saved initial review batch (before pause):**

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/stores/panes.test.ts src/stores/__review__/browse-panes.test.ts src/lib/__review__/browse-sol2-state.test.tsx src/lib/__review__/browse-dir-size-race.test.ts src/lib/glob.test.ts src/components/pane/__review__/browse-lead-preview.test.tsx src/components/pane/__review__/browse-sol2-preview-perf.test.tsx src/components/pane/__review__/ux-smoke-browse-tabs.test.tsx src/lib/__review__/ux-smoke-browse-index.test.ts src/components/pane/__review__/ux-smoke-review-r1.test.tsx --testNamePattern='review-r1|browse-03|browse-08|browse-09|browse-20|browse-25|browse-28|browse-s(08|09|11)|SC-26|mocked IPC|palette favorite|크기 정렬|빠른 필터|patternToMatcher' --testTimeout=30000 --reporter=json --outputFile=ux-smoke-reports/review-r1-results.json
```

Actual intended `src/` files: **46 passed / 5 failed / 96 skipped**. Failures were R1-01, R1-02, the initial Unicode-length case, and two F4 checks now classified as external shell dependency. Vitest's substring file filters also discovered two backup copies, so raw aggregate JSON is **51 passed / 8 failed / 106 skipped**, with a backup index-suite compile error. Those backup artifacts are not product findings; they were renamed with `.backup` suffixes to prevent rediscovery. No broad rerun was used to replace these totals. Log: `review-r1-test.log`; JSON: `review-r1-results.json`.

**B — saved valid-path refinement of R1-03 (before pause):**

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/__review__/ux-smoke-browse-index.test.ts --testNamePattern='review-r1 SC-25' --reporter=json --outputFile=ux-smoke-reports/review-r1-unicode-valid-path.json
```

**1 intended failure / 11 skipped**, generated filename 348 UTF-8 bytes. This replaced the initial single-component fixture with a valid multi-component path. Log: `review-r1-unicode-valid-path.log`.

**C — six additional Opus commits, focused run after authorized resume:**

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/components/pane/__review__/browse-thumbnail-refresh.test.tsx src/stores/session.test.ts src/components/__review__/browse-sol2-session-toast.test.tsx src/components/__review__/ux-smoke-browse-search.test.tsx src/components/__review__/ux-smoke-browse-jumper.test.tsx src/components/pane/__review__/ux-smoke-browse-tabs.test.tsx --testNamePattern='browse-16|browse-26|browse-s0[12467]|browse-s11|results become clickable|palette favorite|duplicate, close, reopen|sync-browse mirrors' --testTimeout=30000 --reporter=json --outputFile=ux-smoke-reports/review-r1-additional-results.json
```

**18 passed / 1 intended failure / 23 skipped**. The sole failure is R1-04; all selected supplied regressions passed. No F4 retest on the older local tree. Log: `review-r1-additional-test.log`; JSON: `review-r1-additional-results.json`.

`git diff --check` passed. No Phase 2 tsc/eslint/Cargo results are claimed. Static `git show <SHA>` reads covered every SHA listed above.

## Limits and handoff

- Isolated Rust probes extract current declarations. Unicode normalization helpers are identity stubs for ASCII matching fixtures; the filename byte-length case does not use those helpers. Async lock calls are replaced with synchronous `RwLock` calls for deterministic state-method interleavings. These are not Tauri, filesystem-walker, live concurrency, Windows, or SSH integration tests.
- POSIX root `/`, sibling component prefix `/a` versus `/ab`, and search scope inside a hidden folder passed isolated controls. Windows `C:\`/drive-case behavior remains static and unverified. New hashed filenames intentionally orphan old cache names; no migration/cleanup or offline-upgrade test was executed.
- Native webview Enter synthesis, image HTTP caching, and native window teardown still require platform checks; mocked event-handler behavior is recorded explicitly.
- **F4: external dependency, passes on main**, lead-confirmed shell UX-SHL-07 integration `88f7d99` / `c6aaa3d`; not a browse defect or reason for CHANGES here.
- Supplemental reviewer-only repro patch: `ux-smoke-reports/sol-review-r1-repros.patch`. It contains the new reviewer frontend file, index probe extensions relative to lead `f66dd0e`, and thumbnail identity test relative to Opus `49f2413`. It excludes reapplied product commits. No commit was attempted.
- No later remediation commits are approved by implication. The original SHA verdicts above remain the round 1 result. Worker returns idle after this report.
