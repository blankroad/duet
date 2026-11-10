# browse-opus — Round 1 progress

Worktree /tmp/duet-ux-smoke-worktrees/browse-opus, branch ux-smoke/browse-opus, base 76b9b6e.

## browse-03 (P2) — filter-hidden selection stays an operation target
- Commit: 6bf87a3 `fe/store: drop filter-hidden entries from the selection`
- Fix: `setFilter` (panes.ts ~L942) prunes `selected` to the names visible under the new filter — same policy as `toggleShowHidden`. No fileops call sites / APIs changed.
- Trade-off: pruning is permanent — clearing/widening the filter does not restore previously hidden selections (same as hidden toggle). Positive test added in panes.test.ts.
- Flipped: browse-panes.test.ts:81, browse-sol2-state.test.tsx:117,127,135,156,174 (ops, clipboard, drag, context menu, status bar).
- Test: `pnpm exec vitest run src/stores/panes.test.ts src/stores/__review__/browse-panes.test.ts src/lib/__review__/browse-sol2-state.test.tsx src/components/pane/PaneFilterBar.test.tsx src/components/pane/__smoke__/file-view.smoke.test.tsx src/components/pane/__smoke__/pane-chrome.smoke.test.tsx src/lib/newEntry.test.ts src/lib/renameReveal.test.ts` → 8 files, 137 passed. `tsc --noEmit` 0, eslint 0, prettier clean.

## browse-08 (P2) — markdown preview link navigates the app window
- Commit: cf94e9b `fe/ui: keep markdown preview links from navigating the app window`
- Fix: PreviewContent passes a custom `a` component — click and auxclick (middle) `preventDefault`; href kept, shown as tooltip (`title`). No backend URL-open command exists (`app_launch` requires an existing path), so http(s) clicks are ignored, not opened.
- QUESTION for lead: want external http(s) to open in the OS browser? Needs a new backend command (`opener::open` on a validated http/https URL) + bindings regen — blocked by the cargo freeze and is a contract change.
- Flipped: browse-lead-preview.test.tsx:12, browse-sol2-preview-perf.test.tsx:10; added auxclick + tooltip test.
- Test: `pnpm exec vitest run <lead-preview, sol2-preview-perf, PreviewInspector, PreviewPdf, __smoke__/file-view.smoke>` → 5 files, 34 passed. tsc 0, eslint 0.

## browse-09 (P2) — cursor-only "calculate size" picks the wrong folder
- Commit: 86444ef `fe/ui: compute size for the folder under the cursor`
- Fix: dirSize.ts uses `computeDisplayed(tab)[cursorIndex]` and skips the `..` row.
- Flipped: browse-dir-size-race.test.ts:22, browse-opus2-app.test.tsx:268; added "'..' cursor computes nothing".
- Test: `vitest run browse-dir-size-race.test.ts browse-opus2-app.test.tsx PreviewInspector.test.tsx` → 16/17; the 1 failure was browse-13 (event-flood timing test, unrelated) timing out under load; re-run alone with --maxWorkers=1: passed. tsc 0, eslint 0.

## browse-20 (P3) — late size result lands on a same-named folder elsewhere
- Commit: 6dece77 `fe/ui: drop folder sizes that arrive after the tab moved away`
- Fix: after each `fsDirSize` await, re-read the tab by id; if closed or `!sameLocation`, discard and stop.
- Flipped: browse-dir-size-race.test.ts (browse-20); added "same-folder refresh keeps the result".
- Test: `vitest run --maxWorkers=1 --minWorkers=1 browse-dir-size-race.test.ts PreviewInspector.test.tsx stores/panes.test.ts` → 3 files, 73 passed. tsc 0, eslint 0.

## browse-25 (P3) — glob `[!a]*` and `\d` in class
- Commit: 6d2b005 `fe/ui: read [!...] as a negated glob class and \ inside a class literally`
- Fix: lib/glob.ts — `[!` and `[^` both negate; `\` inside a class escaped to a literal; empty `[!]` stays literal.
- Flipped: browse-panes.test.ts (browse-25), browse-sol2-state.test.tsx (2 tests); added range/negation + `[!]` tests in glob.test.ts.
- Test: `vitest run --maxWorkers=1 --minWorkers=1 src/lib/glob.test.ts src/stores/__review__/browse-panes.test.ts src/lib/__review__/browse-sol2-state.test.tsx src/components/pane/SelectPatternBar.test.tsx` → 4 files, 54 passed. tsc 0, eslint 0.

## browse-28 (P3) — size sort ignores computed dirSizes
- Commit: 7baf001 `fe/store: sort folders by their computed size`
- Fix: `sortEntries` takes `dirSizes`; folders use computed size when present. `setDirSize` now wraps with `keepCursor` so a reorder doesn't move the cursor to another entry. (Not in the archive-owned regions.)
- Flipped: browse-panes.test.ts (browse-28), browse-sol2-state.test.tsx (browse-28); added cursor-follow test.
- Test: `vitest run --maxWorkers=1 --minWorkers=1 src/stores/panes.test.ts src/stores/panes.tabs.test.ts src/stores/panes.refresh.test.ts src/stores/__review__/browse-panes.test.ts src/lib/__review__/browse-sol2-state.test.tsx src/lib/__review__/browse-dir-size-race.test.ts` → 6 files, 152 passed; plus `PaneToolbar.test.tsx src/stores/session.test.ts` → 2 files, 22 passed. tsc 0, eslint 0.

## browse-16 (P3) — thumbnail not invalidated after image change
- Commit: 49f2413 `fe/ui: refresh grid thumbnails when the image file changes`
- Fix: `thumbUrl(location, version?)` appends `?v=<mtime>-<size>`; backend `thumbnail.rs` parses only `request.uri().path()` (checked statically, no Rust change). `Thumb` remembers failure per version, so a changed file is retried.
- Flipped: browse-thumbnail-refresh.test.tsx:69; added "failed thumbnail retried after change".
- Test: `vitest run --maxWorkers=1 --minWorkers=1 browse-thumbnail-refresh.test.tsx browse-preview.test.tsx` → 2 files, 5 passed; `__smoke__/file-view.smoke.test.tsx __smoke__/pane-chrome.smoke.test.tsx` → 2 files, 25 passed. tsc 0, eslint 0.
- Not verified: real webview cache behaviour (device check).

## browse-26 (P3) — title-bar close doesn't flush pending session save
- Commit: 14d173a `fe/store: save the session before the window closes`
- Fix: new `flushSessionSave()` in session.ts (runs pending debounced save; no-op when nothing pending). Called from TopBar close button and App `quit` command (~L1162; not in archive-owned regions — App.tsx import block grew by 4 lines, so the archive-owned line numbers shift by +4). `pagehide` listener added in `initSessionPersist` as a backup path.
- Flipped: browse-sol2-session-toast.test.tsx:52; added flush/no-op/pagehide test in session.test.ts.
- Test: `vitest run --maxWorkers=1 --minWorkers=1 src/stores/session.test.ts src/components/__review__/browse-sol2-session-toast.test.tsx` → 2 files, 18 passed; `shell-settings-localstorage.test.ts __smoke__/tabs.smoke.test.tsx __smoke__/sidebar-shell.smoke.test.tsx browse-sol3-app.test.tsx` → 4 files, 67 passed. tsc 0, eslint 0.
- Not verified: macOS Cmd+Q / OS-level close actually firing pagehide (device check).

## Batch A summary
All 8 issues fixed, 8 commits on ux-smoke/browse-opus (6bf87a3..14d173a). No cargo run, no bindings change, no fileops API change, archive-owned regions untouched. Open question: browse-08 external-link opening (needs a backend command).

# Round 1b

Cherry-picked lead test commit 7d10ad9 → 6a4780f (clean, no conflict).

## UX-BRW-05 (browse-s01) — stale search result clickable while new query pending
- Commit: 7ac5445 `fe/ui: block clicks on stale search results while a new search runs`
- Fix: SearchPanel result rows `disabled` (dimmed) while `status === "searching"`; Enter already had the guard.
- Flipped s01; added "results clickable again once the new search finishes".
- Test: `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/components/__review__/ux-smoke-browse-search.test.tsx src/components/SearchPanel.test.tsx` → 2 files, 12 passed; `sync-compare-search.test.tsx sync-compare-xcheck-search.test.tsx` → 2 files, 7 passed. tsc 0, eslint 0.

## UX-BRW-06 (browse-s02) — closing a pending content search never cancels backend
- Commit: b0c1d18 `fe/ui: cancel a running content search when the search panel closes`
- Fix: SearchPanel remembers the in-flight content-search seq; on `isOpen → false` (button, Esc, any store close) or unmount it calls `commands.searchCancel()`. Query changes don't cancel (next search rotates the backend token). Existing binding only — no IPC change.
- Flipped s02 (local + remote); added "no cancel after finished search" and "no cancel on query change".
- Test: `vitest run --maxWorkers=1 --minWorkers=1 ux-smoke-browse-search.test.tsx SearchPanel.test.tsx sync-compare-search.test.tsx sync-compare-xcheck-search.test.tsx` → 4 files, 21 passed. tsc 0, eslint 0.
- Not claimed: that the remote exec process is actually killed by the backend token (backend not touched).

## UX-BRW-07 (browse-s04) — jumper Enter during pending query opens previous result
- Commit: 4c4e966 `fe/ui: ignore jumper Enter until the new query has answered`
- Fix: FrecencyJumper tracks `resultsQuery`; Enter acts only when it equals the current input. Mouse click on a visible row unchanged (explicit choice of a shown path).
- Flipped s04; added "Enter works once the new query answered".
- Test: `vitest run --maxWorkers=1 --minWorkers=1 src/components/__review__/ux-smoke-browse-jumper.test.tsx src/components/__smoke__/dialogs-palette.smoke.test.tsx src/components/dialogs/__review__/sync-compare-jumper.test.tsx` → 3 files, 20 passed. tsc 0, eslint 0.

## UX-BRW-08 (browse-s06/s07) — swap panes / move tab during pending listing loses navigation
- Commit: 8aedae0 `fe/ui: keep a pending folder change when its tab switches panes` (~20 lines)
- Fix: new `paneOfTab(state, tabId)` helper in panes.ts (next to `activeTab`); App `navigate()` (~L250-300, used by folder Enter L526 and Up L499) resolves the pane that holds the tab when the listing arrives and applies setEntries / watcher / loading-reset there.
- NOT fixed (needs your OK): `navigateTo()` has the same pattern (bookmarks, back/forward, open-in-other-pane, sidebar) but is in the archive-owned region — left unchanged. Same 3-line change would apply there.
- Pre-existing swap gap (not touched): swapPanes/moveActiveTabToOther don't re-point backend watchers (`paneWatchSet` is per pane id).
- Flipped s06, s07.
- Test: `vitest run --maxWorkers=1 --minWorkers=1 src/components/pane/__review__/ux-smoke-browse-tabs.test.tsx` → 6 passed, 2 failed — the 2 failures are "remote/archive selection and F-keys" at test L409 (F4 → sshEditOpen/openPath never recorded). They fail identically on base 76b9b6e + this test file (checked in a scratch worktree, then removed), so they are pre-existing / test-harness issues, not caused by these commits. Please check with sol whether that test passed on their side.
- `vitest run --maxWorkers=1 --minWorkers=1 src/components/pane/__smoke__/tabs.smoke.test.tsx src/components/pane/__review__/browse-sol3-app.test.tsx src/components/pane/__review__/browse-opus2-app.test.tsx src/stores/panes.tabs.test.ts` → 4 files, 70 passed. tsc 0, eslint 0.

## Line-shift note for archive-owned App.tsx regions
My App.tsx edits are outside the archive regions, but imports grew (+4 session import, +1 paneOfTab) and navigate grew +5, so navigateTo is now ~L310-350 and onUp archive branch ~L490-495.

## All commits (base 76b9b6e)
6bf87a3 fe/store: drop filter-hidden entries from the selection (browse-03)
cf94e9b fe/ui: keep markdown preview links from navigating the app window (browse-08)
86444ef fe/ui: compute size for the folder under the cursor (browse-09)
6dece77 fe/ui: drop folder sizes that arrive after the tab moved away (browse-20)
6d2b005 fe/ui: read [!...] as a negated glob class and \ inside a class literally (browse-25)
7baf001 fe/store: sort folders by their computed size (browse-28)
49f2413 fe/ui: refresh grid thumbnails when the image file changes (browse-16)
14d173a fe/store: save the session before the window closes (browse-26)
6a4780f test: add browse UX smoke repro tests (cherry-pick of lead 7d10ad9)
7ac5445 fe/ui: block clicks on stale search results while a new search runs (UX-BRW-05)
b0c1d18 fe/ui: cancel a running content search when the search panel closes (UX-BRW-06)
4c4e966 fe/ui: ignore jumper Enter until the new query has answered (UX-BRW-07)
8aedae0 fe/ui: keep a pending folder change when its tab switches panes (UX-BRW-08, navigate() only)

## Open questions for lead
1. browse-08: open external http(s) links in the OS browser? Needs a new backend command + bindings regen (cargo-frozen, contract change).
2. UX-BRW-08: OK to apply the same paneOfTab fix inside navigateTo (archive-owned region)?
3. ux-smoke-browse-tabs.test.tsx F-keys tests fail on base too (L409) — test issue for sol/lead.

## CHECKPOINT — USER PAUSE (until 2026-11-11 02:05 KST, resume on main's nudge)
- Worktree: /tmp/duet-ux-smoke-worktrees/browse-opus · branch ux-smoke/browse-opus · HEAD 8aedae0
- Uncommitted files: none (src/types/bindings.ts is a gitignored copy, not committed)
- No running builds/tests. Batch A + round 1b are complete and committed.
- Next command on resume: none queued. Waiting on lead's answers to the 3 open questions above; if (2) is approved, the next step is the paneOfTab change in App.tsx navigateTo(), then `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/components/pane/__review__/ux-smoke-browse-tabs.test.tsx src/components/pane/__smoke__/tabs.smoke.test.tsx`

# Round 2

## browse-08 follow-up (Sol review of cf94e9b) — Enter on a focused preview link activates the pane item
- Commit: da7dfc2 `fe/ui: keep Enter/Space on a preview link from reaching the pane`
- Fix: MarkdownLink `onKeyDown` stops propagation for Enter and Space, so the window-level useKeyboardNav handler never sees them (Enter → onActivate, Space → Quick Look). The click Enter generates is still cancelled by the existing onClick preventDefault. Other keys (arrows etc.) still reach the pane.
- Test: added `browse-08 (R2): Enter|Space on a focused preview link does not reach the pane` in browse-lead-preview.test.tsx (real useKeyboardNav + PreviewContent; Enter control case on document.body does call onActivate). Confirmed both cases fail without the fix (stash test, entry dropped afterwards), pass with it.
- Commands: `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/components/pane/__review__/browse-lead-preview.test.tsx src/components/pane/__review__/browse-sol2-preview-perf.test.tsx src/components/pane/PreviewInspector.test.tsx src/hooks/useKeyboardNav.test.tsx` → 4 files, 19 passed. `pnpm exec tsc --noEmit` 0. eslint on touched files 0.
