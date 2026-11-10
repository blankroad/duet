# Current action availability / selection-context trace

Base: 76b9b6e. **All findings STATIC; no tests executed.** Lead requested static default and no cargo builds without prior lead approval. No user files, servers, product edits, commits, full suites, or builds used. Source references are repository-relative. IDs are proposed for lead deduplication, not assigned central IDs. Native Windows/Bandizip behavior remains unverified.

## Shared rules (apply to every inventory row)

- **T (targets):** `src/lib/fileActions.ts:54-72`: selected name set when nonempty, else cursor from **computeDisplayed**, excluding parent `..`. “None” below means no selected names AND no eligible cursor; clearing selection with a cursor still gives one target. File+folder / archive+ordinary mixtures are preserved unless a row says filtered.
- **C (cursor):** cursor only, ignoring selected set. Navigation/preview actions can intentionally be C; not automatically a defect.
- **D (directory/UI):** selection independent: same behavior for none/single/multi/mixed; current location or UI state is used.
- **Menu selection:** App sets active pane/cursor before opening (`src/App.tsx:704-708`); selected clicked item retains the multi-set, otherwise selection becomes only clicked item (744-747). Keyboard Shift+F10 follows the same builder (851-874). Entry menu itself has no zero-item state: blank-area menu is separate.
- **K/P:** registered commands appear in keymap/palette; keyboard uses effective bindings/defaults. `Command` has no availability/enabled predicate (`src/lib/commands.ts:34-47`); palette ranks all commands and directly invokes action (`src/components/CommandPalette.tsx:48-90`). Global dispatch blocks input/textarea unless allowInInput, open context menu, and modal (`src/hooks/useGlobalShortcuts.ts:40-78`). These are interaction gates, not selection/source capability gates.
- **L/R/A:** local / live SSH / archive browse. Archive browse is an extracted temporary ordinary L/R location plus tab.archive metadata (`App.tsx:528-564`). Most actions below do **not** inspect tab.archive. They operate on temporary content; that does not imply persistence into original archive. Update archive is explicit and only supported formats offer it. Restored/disconnected SSH is separately flagged below.

## Entry context menu (complete static menu builder inventory)

All references in this table are `src/lib/entryMenu.tsx` unless qualified. E=entry right-click or Shift+F10; B=blank-area menu. K/P availability comes from registry appendix. No blanket archive-browse exclusion exists.

| Action / entry points | Availability / file:line | None / single / multi / mixed | L / R / A |
| --- | --- | --- | --- |
| Open E; Enter/double-click | 217-244: only !multi; App:501-579 routes dir/archive/file | C; E hidden for multi, Enter opens cursor even with multi | L/R; supported archive enters browse, other file OS open; A temporary child |
| Open in other pane E, K/P | 218-234: E !multi dir; App:979-985 | E single dir only; K/P cursor folder or current dir, ignores selected set | L/R/A locations; context metadata caveat |
| Quick Look E, Space, P or rebound K | 246-252: E !multi non-dir; App:1076; QuickLook.tsx:24-29 | C; E hidden multi, Space/P still cursor preview, empty target yields empty preview | L/R/A preview support governs loader |
| Edit and watch E (remote file) | 255-262: !multi non-dir and SSH | single clicked only; no multi | R/A-remote only; sshEditOpen |
| Reveal E | 264-270: !multi and local | single clicked file/dir | L/A-local only |
| Terminal E/B | 271-280 E !multi dir+local; 579-590 B local | E child dir; B current dir, D | L/A-local only |
| Extract here E | 284-295 !dir && !multi && canExtractArchive | none unavailable; one supported archive; multi/mixed hidden; action also exactly one | L suffix list; R restricted suffix list; A temporary content; see priority report |
| Clipboard copy/cut E K/P | 300-313 always E; fileActions:206-228 | T; none toast; all selected incl mixtures | L/R/A retained internally; OS mirror separate |
| Paste E/B K/P | 315-322 / 542-548 disabled if no in-app clipboard; fileActions:235-269 | D destination; single clicked dir -> inside it, else current folder; K/P current folder | L/R/A; virtual trash/self-descendant/same-dir-move guards |
| Rename E K/P | 328-342 switches at multi; fileActions:76-99 | none toast; single inline; multi/mixed batch dialog | L/R/A; no archive guard |
| Delete to trash E toolbar K/P | 344-350; fileActions:689-733 | T; none silent; single/multi/mixed plan | L/R/A; virtual trash routes purge dialog |
| Permanent delete E K/P | 354-364 settings flag; commands.ts conditional registration | T; confirm always; no item when disabled (except virtual-trash dedicated purge) | L/R/A |
| Copy/move to opposite E toolbar K/P | 367-381; fileActions:600-625 | T; none toast; entire mixtures sent to plan | L/R/A; virtual trash source/dest explicitly rejected |
| Add to shelf E K/P | 383-389; fileActions:551-565 | T; none toast, all selected | L/R/A; temp references can outlive browse |
| New folder/file E/B toolbar K/P | 395-410 / 550-563; fileActions:350-360 | D; E single dir inside child, else current folder; K/P current folder | L/R/A; virtual trash returns; no archive guard |
| Compress E only | 413-418; fileActions:659-672 | T; none toast; single/multi/mixed all sent to dialog | L/R/A (backend format support still applies) |
| Calculate size E K/P | 420-427 if clicked dir OR multi; dirSize.ts:23-40 | dirs only; multi files-only still shown then toast; no-selection fallback incorrectly raw-indexed | L/R/A; see BRW-001 |
| Checksum E only | 429-436 if non-dir OR multi; fileActions:676-685 | only kind=file subset, ignores dirs/symlinks; no eligible -> toast | L/R/A |
| Permissions E only | 437-444 SSH OR !Windows; fileActions:370-393 | T filtered to file/dir; no eligible toast; mixed common mode null | Unix L, R, A; excludes local Windows |
| Copy path/name E K/P | 448-461; fileActions:179-193 | T whole set, newline joined; none handled by helper | L/R/A temporary paths when browsing |
| Bookmark E/B, Ctrl+D/P, PathBar | 463-468 E always; 650-655 B; App:1107-1116 | E clicked child only even multi/file; B/K/P current dir | L persists bookmark; R host favorite if live alias; A not gated here |
| Host favorite E/B | 470-479 / 657-666: sshAlias resolved | E clicked child only, B current dir; D irrespective multi | R/A-remote with live alias only |
| More options E/B (Windows native) | App:762-782 E Windows+local+count===1; 812-831 B Windows+local+!virtualTrash | E single only; multi/mixed absent; B current folder | Windows L/A-local only; priority report details IPC |
| Put back E | 203-214 trashRoot+callback; virtual-trash branch 171-201; App:420-442 | T selected restore; entry builder does not require single | virtual Windows trash or tracked trash |
| Virtual trash purge/empty/open OS bin E/B | 171-201 / 510-534 early return | purge targets; empty all; open bin D | dedicated synthetic view replaces normal menus |
| New symlink B only | 564-573 SSH OR !Windows; fileActions:364-366 | D current parent | Unix L/R/A |
| Refresh B toolbar K/P | 575-578; App:584-590 | D; selection independent | L/R/A; restored SSH explicitly returns |
| Sync/compare folders B K/P | 592-603; fileActions:273-346 | D two pane roots, never selected dirs/files | compare L/R/A; sync restricted backend pairs (SYN-001) |
| View details/grid/tiles B toolbar K/P | 605-613; PaneToolbar:93-110 | D changes tab view | L/R/A |
| Sort name/size/mtime/kind/ext + direction B toolbar K/P | 616-632; sort menu builder | D; selected set not consulted | L/R/A |
| Hidden files B toolbar K/P | 635-640 | D toggle | L/R/A |
| Split extension column B only | 642-648 | D UI store toggle | L/R/A |

Parent `..` row has its own menu: Open parent and (when parent exists) copy parent path (`App.tsx:709-742`), D, no batch operation, L/R/A. Archive exit uses onUp rather than targeting `..` as a file.

## Toolbar / navigation additions

`PaneToolbar.tsx:66-84,139-185`: new folder/file disabled **only** for virtual trash; copy/move/delete always enabled, delegated through shared T helpers. runHere sets active pane first (86-89), so clicking inactive pane toolbar correctly scopes operation. Filter and sort controls, view submenu, synchronized-browse toggle, hidden toggle are D and have no selection/source gate (`PaneToolbar.tsx:93-134,190-279`). Synchronized browse is a browser toggle, distinct from mirror sync operation.

PathBar back/forward disable by history, up by parent/archive-exit (`PathBar.tsx:253-279`; `Pane.tsx:134-148`). Breadcrumbs navigate D. New tab at 355-365. Path-edit button hidden in archive/trash (366); edit nonce also suppressed while archive/trash (110). Favorites and bookmark buttons hidden in archive (378/390), unlike menu/palette bookmark. Refresh always rendered (413-420), handler blocks restored SSH. Update archive only if `tab.archive && canRepackArchive(label)` (`Pane.tsx:145-149`; `.zip/.tar.gz/.tgz`, `archive.ts:36,60-62`); handler uses full browse root (`App.tsx:1262-1288`). No palette/keyboard command for Update archive.

Tabs: new/select/close/pin/reopen/reorder/move-to-other operate on tab state, D for every selection/source. Store refuses pinned close (`panes.ts:407`), reorder constrained by pin boundary (`panes.ts:527`); App close command reports pinned reason (1020-1028). Tab navigation callbacks are `App.tsx:1018-1060`. All L/R/A; no file selection effects.

Keyboard navigation outside registry: `useKeyboardNav.ts:140-178` excludes editable targets/menu/modal/bound commands. Arrows/Home/End/Page keys move cursor with Shift range selection; Insert toggles eligible cursor and advances; grid left/right move one cell. Enter opens cursor (not selected batch); Backspace up; Tab swaps active pane; Space previews cursor, Ctrl/Cmd+Space toggles cursor selection; Escape clears pending cut before selection; type-ahead cursor only (`useKeyboardNav.ts:180-284`). These work on displayed entries in L/R/A; parent excluded from selection. These are not all registered/rebindable command IDs.

## Evidence-backed gaps for registry handoff

All rows **STATIC**; suggested tests are proposals, not executed results. No mixed-selection crash established by this trace.

| Proposed ID | Symptom / root cause file:line | Owner | Suggested focused regression |
| --- | --- | --- | --- |
| ARC-001 | All multi archives lose extract; double gate entryMenu:284 and fileActions:634, singular backend fs_ops:1535. Full evidence/minimal shape in sol-priority-repro.md. | archive | Menu+shared trigger: differently named/suffix archives, mixed file/dir, unsupported SSH suffix, passwords and same-stem collisions |
| SHL-001 | Multi More options absent; App:762-766 plus singular system.rs:689 and one-child GetUIObjectOf shell_menu.rs:474. | shell | FE complete selection arguments; backend selection/cache identity; real Windows Bandizip smoke needed |
| BRW-001 | Calculate size with no marked selection can operate on wrong folder or report select-folder: dirSize.ts:23 indexes raw entries with displayed cursor (parent/sort/filter shift index). Shared resolver correctly computeDisplayed at fileActions:60. | browse (calc-size helper; coordinate fileops) | Unsorted raw list + parent row + filter; Shift+Space cursor folder, assert exact fsDirSize path |
| SHL-002 | F4 edit callback unreachable through registry: BuiltinDeps editFile declared commands.ts:87; App:957-977 supplies it; buildBuiltins never consumes it or emits a file.edit command. Thus local editor action absent from palette/keymap, remote only has context-menu edit-and-watch. | shell (command registry; browse editor callback) | Assert builtins include editor action and configurable default F4; invoke local/remote file; dirs excluded |
| BRW-002 | Multi-selection Bookmark/host-favorite silently records clicked child only, including ordinary files: entryMenu:463-476 has neither !multi nor isDir guard, unlike Open. App bookmark command operates current folder (1107-1116). | browse; remote host-favorite persistence | Two selected dirs then context bookmark: explicit policy/count; ordinary file should be hidden or documented file bookmark; do not assume whole selection |
| ARC-002 | Dangling archive temporary bookmarks possible via menu/palette while PathBar hides bookmark for exactly that reason. PathBar:389-390 vs entryMenu:463/650 and App:1107-1116; bookmarkActions:13 has no archive context. Related prior G-07; do not conflate with fixed repack-root issue. | archive + browse | Browse archive, invoke each bookmark entry point; prohibit temp bookmark or store stable archive identity; exit/reap then activate saved item |
| SYN-001 | Sync remains selectable for local↔SSH/different remote hosts although backend rejects strategy. entryMenu:592-597 / commands file.sync -> fileActions:327-337; core/ops.rs:1187-1195 supports only LocalToLocal/SshSameHost. Prior SC-15/D-8. | sync | Availability matrix local/local, same-host SSH, cross-host, local/remote; unsupported reason before dispatch |
| REM-001 | Restored/disconnected remote Refresh explicitly no-ops (App:587-589), but toolbar create/copy/move/delete has no source lifecycle gate (PaneToolbar:66,139-185); helpers submit restored source to IPC. This is availability asymmetry, not a claimed live-SSH crash. | remote; shared browse/fileops UI | Restored source fixture: disable/defer ops and offer reconnect; assert no dead-connection IPC |
| FOP-001 | Copy/move toolbar remain enabled in virtual trash though entry menu is replaced with restore/purge-only. triggerCopy/Move reject with toast (fileActions:607/621). New create buttons already disabled via canCreate. | fileops | Virtual trash toolbar: consistent disabled state/reason; other pane virtual trash destination also disabled or explained |
| FOP-002 | No-target Delete silently returns (fileActions:695), whereas copy/move explicitly toast (484-490). Palette and toolbar remain active. | fileops | Empty pane/no cursor Delete shows clear disabled state or explanation; ensure parent row never targeted |
| BRW-003 | Multi Quick Look/Open-in-other available through palette/keyboard but hidden in E; they use cursor rather than selected set (App:979-994/1076; QuickLook:24-29). Intentional cursor semantics are plausible; needs explicit entry-point contract, not batch execution by assumption. | browse | Different cursor vs selected set: assert documented cursor target; label or predicate consistency |
| SHL-003 | Quit is registered with Ctrl+Q on macOS as well (commands app.quit), but App:1158-1164 does nothing when userAgent includes Mac. | shell | macOS palette/keyboard Quit contract; no-op should be absent or perform native quit |
| ARC-003 | Non-repack archive shows read-only badge but ordinary mutation actions remain enabled and affect extracted temp files (Pane:145-149 vs entryMenu rename/delete/create/compress; fileActions lacks archive guard). Persistence into source is unavailable. Related G-07; this trace does not claim editing temp files itself crashes. | archive | 7z/rar browse rename/create: clear temporary-only/unsupported persistence policy; zip browse Update remains explicit |

Other verified routing limits, not new defects: checksum intentionally skips folders/symlinks (`fileActions:678-685`); permissions skips symlinks (`373-379`); all-file multi selection still shows Calculate size then explains no folder. Shelf application takes only first source group and explicitly toasts remaining groups (`fileActions:568-595`), so it is partial but not silent. Extraction conflict is sent straight to execution (`fileActions:638-655`), matching prior archive-21; no new test run or new alias assigned here.

## Complete registered-command appendix

Every emitted fixed ID below is available to P and configurable K, regardless of selection/source, except permanent delete registration depends on settings. Runtime behavior is grouped below. This includes commands with no default key (users may bind them). The table gives each definition line and callback; the preceding inventory gives action capability predicates. D means none/single/multi/mixed all identical and L/R/A exposed; T/C exceptions below.

- **T:** file.copy/move/rename/delete/deletePerm/clipCopy/clipCut/copyPath/copyName, shelf.add: shared targets above; calcSize uses flawed raw cursor fallback. clipPaste D destination with clipboard targets. edit.undo/redo/history D global journal state; no selection dependence (`fileActions:103-156`).
- **C:** pane.openInOther, tab.openInNew use cursor folder else current directory (`App:978-994`); view.quickLook uses cursor preview, including multi selection.
- **D:** all other IDs operate tab/location/UI/global state. Select actions change marked set via displayed list (`panes.ts:762-790`); pattern add/remove opens prompt (`App:1139-1146`). Three-way asks base path on active source; compare/sync use two current roots (`fileActions:273-346`). shelf.applyCopy/Move consumes shelf source group, not pane selection. ssh.setupKeyAuth checks SSH only after invocation (`App:1184-1199`); local toasts notRemoteHost. app.quit macOS no-op noted above. tab.gotoN/bookmark.gotoN nonexistent index quietly no-ops (`App:996-1015`).

| ID | Definition | Default key | Callback |
| --- | --- | --- | --- |
| tab.new | commands.ts:223 | Ctrl+T | deps.openTab |
| tab.close | commands.ts:230 | Ctrl+W | deps.closeActiveTab |
| tab.next | commands.ts:237 | Ctrl+Tab | deps.nextTab |
| tab.prev | commands.ts:244 | Ctrl+Shift+Tab | deps.prevTab |
| tab.moveToOther | commands.ts:251 | — | deps.moveTabToOther |
| tab.togglePin | commands.ts:258 | — | deps.togglePinTab |
| tab.reopenClosed | commands.ts:264 | Ctrl+Shift+T | deps.reopenClosedTab |
| tab.moveLeft | commands.ts:271 | Ctrl+Shift+PageUp | deps.moveTabLeft |
| tab.moveRight | commands.ts:278 | Ctrl+Shift+PageDown | deps.moveTabRight |
| nav.back | commands.ts:285 | Alt+Left | deps.back |
| nav.forward | commands.ts:292 | Alt+Right | deps.forward |
| pane.editPath | commands.ts:299 | Ctrl+L | deps.editPath |
| nav.jump | commands.ts:306 | Ctrl+J | deps.jump |
| view.refresh | commands.ts:313 | Ctrl+R | deps.refresh |
| view.toggleHidden | commands.ts:320 | Ctrl+H | deps.toggleHidden |
| view.toggleSidebar | commands.ts:327 | Ctrl+B | deps.toggleSidebar |
| view.focusSidebarFilter | commands.ts:334 | — | deps.focusSidebarFilter |
| view.togglePreview | commands.ts:342 | F11 | deps.togglePreview |
| view.quickLook | commands.ts:349 | — | deps.quickLook |
| view.syncBrowse | commands.ts:355 | — | deps.toggleSyncBrowse |
| view.singlePane | commands.ts:361 | Ctrl+Shift+D | deps.toggleSinglePane |
| view.dropTray | commands.ts:368 | Ctrl+Shift+Y | deps.toggleDropTray |
| view.details | commands.ts:375 | — | deps.viewDetails |
| view.grid | commands.ts:381 | — | deps.viewGrid |
| view.tiles | commands.ts:387 | — | deps.viewTiles |
| sort.byName | commands.ts:393 | Ctrl+Shift+1 | deps.sortByName |
| sort.bySize | commands.ts:400 | Ctrl+Shift+2 | deps.sortBySize |
| sort.byMtime | commands.ts:407 | Ctrl+Shift+3 | deps.sortByMtime |
| sort.byKind | commands.ts:414 | Ctrl+Shift+4 | deps.sortByKind |
| sort.byExt | commands.ts:421 | Ctrl+Shift+5 | deps.sortByExt |
| bookmark.toggle | commands.ts:428 | Ctrl+D | deps.toggleBookmark |
| filter.focus | commands.ts:435 | Ctrl+F | deps.focusFilter |
| search.global | commands.ts:443 | Ctrl+Shift+F | deps.openSearch |
| pane.openInOther | commands.ts:450 | Ctrl+Right | deps.openInOtherPane |
| tab.openInNew | commands.ts:457 | Ctrl+Up | deps.openInNewTab |
| connection.quick | commands.ts:466 | Ctrl+Shift+K | deps.quickConnect |
| select.all | commands.ts:473 | Ctrl+A | deps.selectAll |
| select.none | commands.ts:480 | — | deps.clearSelection |
| select.invert | commands.ts:488 | Ctrl+Shift+I | deps.invertSelection |
| select.byPattern | commands.ts:497 | Ctrl+= | deps.selectByPattern |
| select.removeByPattern | commands.ts:505 | Ctrl+- | deps.deselectByPattern |
| shelf.add | commands.ts:513 | Ctrl+Shift+A | deps.shelfAdd |
| shelf.applyCopy | commands.ts:520 | — | deps.shelfApplyCopy |
| shelf.applyMove | commands.ts:526 | — | deps.shelfApplyMove |
| shelf.clear | commands.ts:532 | — | deps.shelfClear |
| file.compare | commands.ts:538 | — | deps.compareFolders |
| file.threeWay | commands.ts:544 | — | deps.threeWayCompare |
| file.sync | commands.ts:550 | — | deps.syncFolders |
| pane.swap | commands.ts:556 | Ctrl+U | deps.swapPanes |
| settings.open | commands.ts:563 | Ctrl+, | deps.openSettings |
| palette.open | commands.ts:570 | Ctrl+P | deps.openPalette |
| app.quit | commands.ts:577 | Ctrl+Q | deps.quit |
| file.copy | commands.ts:585 | F5 | deps.copy |
| file.move | commands.ts:592 | F6 | deps.move |
| file.rename | commands.ts:599 | F2 | deps.rename |
| file.newFolder | commands.ts:606 | F7 | deps.newFolder |
| file.newFile | commands.ts:613 | Shift+F4 | deps.newFile |
| file.delete | commands.ts:621 | Delete | deps.delete |
| file.deletePerm | commands.ts:632 | Shift+Delete | deps.deletePerm |
| file.clipCopy | commands.ts:641 | Ctrl+C | deps.clipCopy |
| file.clipCut | commands.ts:648 | Ctrl+X | deps.clipCut |
| file.clipPaste | commands.ts:655 | Ctrl+V | deps.clipPaste |
| file.copyPath | commands.ts:662 | Ctrl+Shift+C | deps.copyPath |
| file.copyName | commands.ts:669 | Ctrl+Alt+C | deps.copyName |
| file.calcSize | commands.ts:676 | Shift+Space | deps.calcDirSize |
| edit.undo | commands.ts:683 | Ctrl+Z | deps.undo |
| edit.redo | commands.ts:690 | Ctrl+Shift+Z | deps.redo |
| edit.history | commands.ts:697 | — | deps.openHistory |
| file.contextMenu | commands.ts:703 | Shift+F10 | deps.openContextMenu |
| help.shortcuts | commands.ts:710 | F1 | deps.openShortcuts |
| ssh.setupKeyAuth | commands.ts:717 | — | deps.setupKeyAuth |

Generated families: `tab.goto1..9` (`commands.ts:157-164`, Alt+1..9), `bookmark.goto1..9` (171-178, Alt+Shift+1..9). macOS overrides sort keys to Ctrl+Alt+1..5, hidden to Ctrl+Shift+., preview to Ctrl+Shift+P; edit-path alternate Ctrl+Shift+G (`commands.ts:189-201`). Ctrl represents Command on macOS in normalization.

Dynamic P/configurable K IDs (`dynamicCommands.ts:48-91`): host.connectConfig:<alias>, host.connect:<alias>, bookmark.open:<id>, favorite.open:<id>, alias:<id>. Existence of stored record is registration predicate; selection independent in every none/single/multi/mixed case. Connect/favorite may initiate a connection; bookmark opens its own source (`App:1788-1800`), alias navigate/connect branches use active pane (`1756-1782`). These are not external-tool file-selection templates in this revision.

Unregistered menu-only actions: extract, compress, checksum, permissions, symlink, reveal, terminal, remote edit/watch, native More options, split extension, host favorite, trash-specific actions, Update archive. No built-in open-with chooser or general external-tool command is emitted by current registry; native Windows extension entries are opaque backend menu items and cannot be individually enumerated statically.

## Validation / boundaries

Read-only rg/nl/cat traces against current worktree; no tests run. Suggested tests above are not TESTED evidence. Prior functional-review README/archive and fix-round README were read to distinguish known context/sync issues; Opus worker owns full prior alias inventory. No claim of Windows native, actual SFTP, or live-app reproduction. Scope is top-level entry menu, pane/path toolbar, global navigation keyboard, and complete fixed/dynamic command registry; dialog-internal buttons and sidebar-specific context menus are outside this assignment's entry-action matrix.
