# Prior issue inventory (research-opus, TASK A)

Base: `76b9b6e` (worktree `/tmp/duet-ux-smoke-worktrees/research-opus`, branch `ux-smoke/research-opus`).
Author: ux-research-opus. Date: 2026-11-10. **Static research only. No builds or tests were run for this file.**

Sources read in full: `docs/reviews/2026-11-08-functional-review/*` (README + 6 team reports),
`docs/reviews/2026-11-10-fix-round/*` (README + 6 team reports). Skimmed: `2026-11-04-component-ux-review.md`,
`2026-10-13-file-creation-remote-ux-review.md`, `2026-09-05-ux-benchmark-review.md`, `2026-09-11-*.md`.

## How to read this

- **Status** comes from the 11-10 fix-round reports. A fix-round report lists *team-branch* hashes. Those commits
  were cherry-picked onto main, so the hashes in the reports are **not ancestors of 76b9b6e**.
  I mapped each one to its main commit by identical subject: all 150 mapped, sample-checked with `git log -1`.
  **Hashes below are main hashes**, unless marked `team:`.
  - `FIXED <main hashes>`: a fix-round report claims it fixed this.
  - `PARTIAL`: the report says some of it was fixed, or only the wording was fixed.
  - `DEFERRED`: named as out of scope, or waiting on a user decision (D-x).
  - `OPEN`: never assigned in the fix round.
- **Evidence (prior)** is how the issue was originally shown:
  - `cargo` = Rust repro test
  - `FE-mock` = Vitest with IPC mocked. **This is not a live-app test.**
  - `docker-IT` = docker sshd integration test
  - `static` = code reading only
  - `device` = the report asked for a Windows, real-server or live-app check that was never done
  - Nothing in either round was checked in the live app or on a real Windows machine.
- **Repro marker @76b9b6e** comes from a mechanical scan (script:
  `.../scratchpad/idscan.py`, a Python scan over `src/`, `src-tauri/src`, `src-tauri/tests`).
  It records which test files mention the ID, and whether an `#[ignore …ID…]` or `it.fails(…ID…)` marker is still
  present. That marker means the repro is still expected to fail, so the issue is still open in the test suite's view.
  This is a strong signal, not proof; the scan matches IDs within a 4-line window.
- **Verify @base**:
  - `verified static`: I read the current code at 76b9b6e and it matches the stated status.
  - `marker`: the scan signal only.
  - `not checked`: no check at all.
- **Dup** = cross-report duplicate group (`G-xx` from the 11-08 README, plus extra links I found).
- **Module** = PROTOCOL owner (archive | shell | fileops | browse | remote | sync).
  Items with two owners are marked `a+b`; the first owner leads.

---

## 0. FIRST: multi-selection archive extract, native "More"/OS menu, Bandizip, multi-selection gating

### 0.1 What prior reports said

**Short answer: nothing in either round reports multi-selection extract ("extract here" / "extract each") or a
multi-selection native/OS "More" menu. These are new territory for this smoke round.** The only nearby prior items:

| Prior alias | Symptom | Module | Status | Evidence | Verify @base |
| --- | --- | --- | --- | --- | --- |
| 11-08 ss-10 (shell-settings-10, P2) | Windows: right-clicking empty space → "More options" shows the menu for the **current folder itself** (Delete/Cut/Rename/Properties), not the background menu. Choosing Delete sends the open folder to the Windows Recycle Bin, outside duet's journal (no Ctrl+Z) | shell | OPEN (not in fix round) | static + device | **verified static.** `platform/shell_menu.rs:455-476` `build_menu(_scope)` ignores scope and always does `SHBindToParent` → `GetUIObjectOf([child])`. `App.tsx:815-831` still passes `"background"` |
| 11-08 ss-16 (P3) | Shell-menu item fails silently (e.g. token expired after ~5 min) | shell | OPEN | FE-mock (`shell-settings-shell-menu.test.ts`) + device | **verified static**: `src/lib/shellMenu.ts:48` `void commands.shellMenuInvoke(...)` ignores the result. Marker: it.fails still present |
| 11-08 ss "improve" | Shell-menu worker `rx.await` has no timeout → "More options" can spin forever on a hung shell extension | shell | OPEN | static + device | not checked |
| 11-08 ss-11 (P3) | Windows OS file clipboard (`OpenClipboard(NULL)`): failure leaks HGLOBAL; FE ignores the result | shell | OPEN | static + device | not checked |
| 11-08 archive-06 → 11-10 archive | Zips made by 7-Zip/**Bandizip** with BZip2/LZMA/Zstd/XZ/PPMd methods would not extract or browse | archive | FIXED `184118b` (tests), `0f4c310` (zip 9 + methods) | cargo | marker: none left. Not re-run |
| 11-08 archive-04 (U-05) → 11-10 | CP949 zip names (Korean Windows Explorer, **Bandizip**, ALZip) showed as mojibake | archive | FIXED `67d0eb2`, `252ba7a`, `ec30c85` | cargo | `core/zip_names.rs` present. A real Bandizip/ALZip output is **still a device check** (fix-round archive.md §기기 확인) |
| 09-05 CF-10 | No per-file "Open with ▸" in duet's menu. Only Windows gets an OS Open-with, through the shell "More options ▸" (single selection) | shell | OPEN (never in a fix list) | static | **verified static**: no open-with item in `entryMenu.tsx`. Launchers only via the `OpenWithSection` extension map |
| 09-05 CF-11 / 11-04 file-view B-02 | Context menu ~20 flat items, over the DESIGN spec. No "More ▸"/"Tools ▸" submenus and no Properties | shell | OPEN / DEFERRED (11-04 "보류") | static | **verified static**: `buildEntryMenu` is still a flat list |
| 11-04 dialogs "명령 가용성" | Commands that do not apply (remote/local, selection) should be disabled with a reason | shell+browse | DEFERRED (11-04 보류) | static | **verified static**: `src/lib/commands.ts` has no enabled/when/availability field at all |
| 11-08 archive-21 (P3) | Extract: if the destination folder exists, it is moved to `.bak` without asking (`plan.conflict` unused in FE) | archive | OPEN | static | **verified static**: `core/archive.rs` `extract_execute` ~236 "dest 충돌 → backup 으로 mv". `fileActions.ts:632-656` never reads `plan.conflict` |
| 11-08 archive-26 (P3) | Extract notice doesn't show the new names. zip/7z/rar had no notice | archive | PARTIAL (archive-07 `252ba7a` added zip/7z notices; new names still not shown) | FE-mock | marker: it.fails still present (`archive-notice.test.ts`) |
| 11-08 archive-22 → U-04 | Compress whose output is inside the selection | archive | FIXED `f278420` | cargo | not re-run |

### 0.2 Current state at base (spot-check only; the Sol worker owns full availability tracing)

- **Extract is single-selection only, in three places:**
  - Menu: `entryMenu.tsx:284` `!isDir && !multi && canExtractArchive(...)` hides the item when more than one item is selected.
  - Action: `fileActions.ts:632-637` `triggerExtract` refuses any selection count other than 1 with the toast `toast.extractSelectOne` ("압축 해제: 아카이브를 하나만 선택하세요").
  - IPC: `fsExtractPlan(target)` takes a single `EntryRef`.
  - No command palette or keymap entry for extract exists (`commands.ts` has none).
- **Label mismatch:** the menu says "여기에 압축 해제" (`menu.extractHere`), but `core/archive.rs:214-216` extracts into
  `<parent>/<archive_stem>/`. That is "extract to folder", not "extract here". There is no true "extract here",
  no "extract to…" picker and no "extract each". All `STATIC`.
- **Windows "More options ▸" is single-selection, local only:** `App.tsx:763-779` requires `selectedCount === 1`.
  The backend `shell_menu_open(path, scope)` takes one path, and `build_menu` gets an `IContextMenu` for exactly one
  child PIDL. With multiple items selected there is no OS menu, so Bandizip's or 7-Zip's multi-item shell verbs are
  unreachable from duet. `STATIC`. Behaviour on a real Windows machine is unverified.
- **Multi-selection gating in `buildEntryMenu`** (`multi = selectedCount > 1`):
  - Hidden on multi: Open, Open in other pane, Quick Look, Edit (remote), Reveal, Terminal, Extract.
  - Changed on multi: Rename becomes Batch rename. Paste-into-folder becomes plain Paste.
  - Kept on multi: Compress, Calc size, Checksum, Permissions, Copy path/name, Shelf.
  - Bookmark is always built from the right-clicked `entry`, even with multi (`entryMenu.tsx:461-466`). Possible gap;
    `STATIC`, not checked further.
  - Checksum on multi relies on the dialog to handle folders.
- **`selectedCount` comes from the right-click** (`App.tsx:745-747`): right-clicking an unselected item replaces the
  selection; right-clicking a selected one keeps the whole selection. `resolveActiveTargets` uses raw `tab.selected`.
  Hidden or filtered selected items are therefore still targets (browse-03 below; marker still present).

### 0.3 Implications for module leads

1. Multi-archive extract (archive) is a **feature gap, not a regression**. It touches the FE (menu gating,
   `triggerExtract`) and the IPC (single `EntryRef`). The minimal FE-only route is to loop `fsExtractPlan`/`Execute`
   per selected archive, each a separate task. CLAUDE.md §4 makes each one a separate journal entry, so one Ctrl+Z
   undoes only one. Decide whether "extract here" should mean the same folder or `<stem>/`, and fix the label either way.
2. A multi-item OS menu (shell) needs `shell_menu_open` to accept N paths that share one parent, then
   `GetUIObjectOf(&[child1..childN])`. That is an IPC signature change (Rule 1/§3 IPC first) and needs real Windows
   evidence. Fix ss-10's background scope (`IShellFolder::CreateViewObject`) in the same area; it is the existing P2.
3. Both teams edit `entryMenu.tsx`/`App.tsx` (`openEntryMenuAt`). PROTOCOL says to coordinate there.

---

## 1. Full inventory

Columns: Alias | Symptom (one line) | Module | Status | Evidence(prior) | Repro marker @76b9b6e | Verify @base | Dup.
Marker values: `ign` = Rust `#[ignore]` still present; `fails` = Vitest `it.fails` still present; `—` = repro exists, no
marker (fixed or never failing); `none` = no repro test mentions the ID.

### 1.1 archive

| Alias | Symptom | Module | Status | Evid. | Marker | Verify | Dup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archive-01 (U-01) | tar hard-link fallback follows a symlink and writes or reads outside the extract folder (security) | archive | FIXED `9863914`, `d757bd2` | cargo | — | not checked | G-15 |
| archive-02 (U-09) | "Update archive" from a browse subfolder rebuilds the archive from that subfolder only | archive | FIXED `baeb7b4` (BE guard), `41ba1ba` (FE root) | cargo + FE-mock | — | **verified static** (`repack_plan` rejects `is_browse_subfolder`; `lib/archive.ts:66` `repackBrowseRoot`) | G-07 |
| archive-03 (U-06) | Compress/repack failure or cancel leaves the original stranded at `.bak.<ts>` and a broken zip under the original name; no undo | archive | DEFERRED (G-08) | cargo | ign | **verified static**: `archive.rs` ~913-962 moves dest to backup and then `compress_*().await?` returns with no restore | G-08 |
| archive-04 (U-05) | CP949/Shift-JIS zip names shown as CP437 mojibake | archive | FIXED `67d0eb2`, `252ba7a`, `ec30c85` (Shift-JIS still open) | cargo | ign (`archive_review_sol` = `sol_zip_sjis_names`, kept on purpose) | not checked | G-13 |
| archive-05 | Windows client: remote repack overwrites with no backup; zip keeps deleted entries | archive+remote | FIXED (paths G-05) `5dca186` and others | static + device | none | not checked | G-05 |
| archive-06 | BZip2/LZMA/Zstd/XZ/PPMd zips (7-Zip/Bandizip) fail | archive | FIXED `184118b`, `0f4c310` | cargo | — | not checked | — |
| archive-07 | zip/7z lack Windows name and link handling (links, `?*<>`, `:` ADS, CON) | archive | FIXED `252ba7a`, `db6ef4a`, `78f5ffb` | cargo + device | — | not checked | G-15 |
| archive-08 | tar with read-only dirs (0555) fails | archive | FIXED `a348bca` | cargo | — | not checked | — |
| archive-09 | Extract-rollback failure leaves the old folder in `.bak`, no notice | archive | DEFERRED (G-08) | cargo | ign | not checked | G-08 |
| archive-10 | Compress follows symlinks (one dangling link fails everything) | archive | FIXED `09012af` | cargo | none | not checked | G-15 |
| archive-11 | Repacking an encrypted zip produces an unencrypted zip, no notice | archive | OPEN | cargo | ign | not checked | — |
| archive-12 | duet-made zips: mtime 1980, no exec bit | archive | OPEN | cargo | ign | not checked | — |
| archive-13 | Files over 4 GiB fail zip compression | archive | OPEN (wording fixed via archive-32 `95ae362`) | cargo | ign | not checked | — |
| archive-14 | Cancel during extract/compress does nothing | archive | DEFERRED (G-09) | cargo | ign | **verified static**: cancel is only checked before work starts (`archive.rs:267`, `:937`) | G-09 = fileops-16 |
| archive-15 | Archive inside archive: leaving the inner one loses the outer context | archive+browse | DEFERRED (G-07) | FE-mock | fails | marker | G-07 = browse-32/34 |
| archive-16 | Remote AES zip gets wrong advice; English raw errors | archive | FIXED `95ae362`, `1ad4030` | FE-mock | — | not checked | G-17 |
| archive-17 | Case-only name collision silently overwrites (7z mixes name and content) | archive | FIXED `f3ee546`, `e025f8d` | cargo | — | not checked | G-25 |
| archive-18 | Encrypted zip extract drops links and exec bits | archive | FIXED `252ba7a` | cargo | — | not checked | — |
| archive-19 | rar folder entries skipped → empty dirs missing | archive | OPEN | static + device | none | not checked | — |
| archive-20 | ZipCrypto wrong password passes the header check 1/256 → "corrupt", no retry | archive | OPEN | cargo + FE-mock | ign + fails | marker | — |
| archive-21 | Extract moves an existing same-name folder to `.bak` without asking | archive | OPEN | static | none | **verified static** (see §0.1) | — |
| archive-22 | Compress selection includes the output archive itself | archive | FIXED `f278420` | cargo | — | not checked | G-04 |
| archive-23 | Local browse temp dirs pile up during a session; no warning when leaving edited browse without update | archive | OPEN (G-07 deferred) | static | none | not checked | G-07 |
| archive-24 | Compress naming: `x.tgz`→`x.tgz.tar.gz`, `photo.jpg.zip`, `..`, `con` | archive | OPEN | static | none | not checked | — |
| archive-25 | Remote browse failure leaves `~/.duet-tmp/browse-*` | archive+remote | DEFERRED (G-20) | static + device | none | not checked | = remote-18 (G-20) |
| archive-26 | Extract notice omits new names; zip/7z/rar had none | archive | PARTIAL (zip/7z notices `252ba7a`) | FE-mock | fails | marker | — |
| archive-27 | Remote names: `\` turned into `/` in host commands | archive+remote | FIXED `fa69b92` (G-05) | static | none | not checked | G-05 = remote-01, SC-30 |
| archive-28 | Single `.gz` with trailing zero padding fails | archive | OPEN | cargo | ign | not checked | — |
| archive-29 | zstd skippable frames (pzstd) fail | archive | OPEN | cargo | ign | not checked | — |
| archive-30 | Split archives (`.7z.001`, `.z01`) not recognized | archive | OPEN | static | none | not checked | — |
| archive-31 | Remote zip password on the `unzip -P` command line (visible in `ps`) | archive+remote | DEFERRED (D-11) | static | none | not checked | G-27 |
| archive-32 | Raw remote unzip exit 1/50 and missing-codec errors | archive | FIXED `95ae362`, `1ad4030` | FE-mock | — | not checked | G-17 |
| archive-33 | Windows: tar folder link created as a file link | archive | PARTIAL `9976971` (target-after-link case open) | cargo + device | — | not checked | G-15 |
| archive-34 | §5: Rust password `String` not zeroized | archive | OPEN | static | none | not checked | G-27 |
| fix-round new | Remote zip compress (`zip -r`) follows links (needs `-y`). Windows non-admin browse→repack silently drops skipped links | archive | OPEN (fix-round "후속") | static | — | not checked | — |

### 1.2 shell (settings, keymap, toasts, notices, OS integration, shell menu)

| Alias | Symptom | Module | Status | Evid. | Marker | Verify | Dup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ss-01 (U-03) | One corrupt store file → app won't start (Windows: nothing appears) | shell+fileops | FIXED `7c87d1a`, `477c441`, `cf3ccb0`, `50de31e`, `e6b7ce9`, `75dea52` and others | cargo | — | **verified static** (`fs/persist.rs` exists). Live boot with a corrupt file = device | G-02 = fileops-01, remote-19 |
| ss-02 | Failed save keeps the new value in memory; permanent-delete permission can flip on silently | shell | FIXED `50de31e`, `e6b7ce9`, `5b9e3c5`, `c0ee585`, `07f1991` | cargo | — | not checked | G-03 = remote-22 |
| ss-03 | Legacy SSH-bookmark migration deletes the source even when the favourite save fails | browse | FIXED `0ea182f` | FE-mock | — | not checked | — |
| ss-04 | Immediate-failure toasts lose the file name (explainError regression) | shell | FIXED `7a71ad4` +12 (showError) | FE-mock | — | **verified static** (`src/lib/errorToast.ts`) | G-16 = browse-30 |
| ss-05 | Korean IME: Enter/Esc misfire in the sidebar filter, launcher name, dialogs | shell | FIXED `4cce989` | FE-mock + device | — | not checked | — |
| ss-06 | Mixed-source shelf: "re-apply" always handles only the first group | fileops | OPEN (G-26) | FE-mock | fails | marker | G-26 |
| ss-07 | Windows: "Open in duet" on `C:\` opens nothing (`\"` argv) | shell | FIXED `d16998e`, `f9f3976` | static + device | ign (`platform/mod.rs`, Windows-only test kept ignored) | not checked | G-24 |
| ss-08 | Cold start: last left tab was SSH → OS "open path" fails | browse | FIXED `4e191fc`, `4a3947a` | FE-mock | — | not checked | G-06 ⊂ browse-05 |
| ss-09 | Windows client: remote places/volumes built as `/home/u\Documents` | remote | FIXED (G-05) `d17e78c`, `e947e0a` | static + device | none | not checked | G-05 |
| ss-10 | Windows empty-space "More options" shows the current folder's own menu | shell | OPEN | static + device | none | **verified static** | — |
| ss-11 | Windows OS clipboard failure leaks memory; FE ignores the result | shell | OPEN | static + device | none | not checked | — |
| ss-12 | Bad keymap.toml edit while running: no notice | shell | FIXED `e6b7ce9`, `c49027a` | cargo | — | not checked | G-02 |
| ss-13 | Drag-to-sidebar bookmark toast shows `“{{name}}”`; allows duplicates and files | browse | OPEN | FE-mock | fails | marker | — |
| ss-14 | errno table merges macOS and Linux (wrong reasons) | shell | FIXED `b1bc009` | FE-mock | — | not checked | G-17 |
| ss-15 | Words in file names ("bad header") flip the error reason | shell | FIXED `8084c5a`, `dfeef18`, `890740b` | FE-mock | — | not checked | G-17 |
| ss-16 | Shell-menu item failure gives no feedback | shell | OPEN | FE-mock + device | fails | **verified static** | — |
| ss-17 | Warm-start relative path resolved against the first process's cwd (CLI) | shell | OPEN | static | none | not checked | — |
| ss-18 | keymap watcher ignores a first external "clear all"; brief empty keymap | shell | FIXED `e6b7ce9`, `34d05eb` | cargo | — | not checked | — |
| ss-19 | Deleting a bookmark/favourite/host leaves ghost tag chips | browse | OPEN | FE-mock | fails | marker | — |
| ss-20 | Reorder with duplicate IDs loses or duplicates items (UI-unreachable) | browse | OPEN | cargo | ign | not checked | — |
| ss-21 | macOS NFD names not found by the sidebar filter or palette | shell | FIXED `cbf0c1e` | FE-mock | — | not checked | G-14 |
| ss-22 | Connection error dot has no tooltip; status-bar tooltip shows raw text; a11y | shell+remote | OPEN | FE-mock | fails | marker | — |
| ss-23 | Toasts vanish while hovered or focused | shell | FIXED `d5e9725` | FE-mock | — | not checked | = browse-31 (G-18) |
| ss-24 | With 4 error toasts up, a new success toast is dropped (product choice) | shell | DEFERRED (D-14) | FE-mock | fails | marker | G-18 |
| ss-25 | Notice badge: read state after the cap, focus after "clear all", focus trap | shell | FIXED `3c27b16`, `e553270`, `e81e436` | FE-mock | — | not checked | G-18 |
| ss-26 | Settings "editor command" saves on every keystroke → dropped chars | shell | OPEN | FE-mock | fails | marker | — |
| ss-27 | Hard-coded English user text (toast prefixes, dynamic commands, shelf "Main", BE task titles) | shell | PARTIAL `796d1f2`, `041812f` (toast prefixes only) | static (AST) | none | not checked | G-17, SC-39 |
| ss-28 | Bad-shaped localStorage values throw (recents, palette, sidebar) | shell | OPEN | FE-mock | fails | marker | — |
| ss-29 | AltGr+digit triggers custom Ctrl+Alt+digit shortcuts | shell | OPEN | FE-mock | fails | marker | — |
| ss-30 | Host with a nickname can't be found by its alias in the sidebar filter | remote | OPEN | FE-mock | fails | marker | — |
| ss-31 | Shelf apply proceeds into a virtual-trash pane | fileops | OPEN | FE-mock | fails | marker | G-26 |
| ss handoff | `secret_vault.rs:33` `unsafe` vs CLAUDE.md §8 | remote | DEFERRED (D-3) | static | — | not checked | G-27 |
| 11-04 B-01 / SC-50 | List navigation keys hard-coded (rule: all keys configurable); `useEffect` data fetching | shell | DEFERRED (D-12) | static | — | not checked | — |
| 11-04 dialogs | "Command availability: disable with a reason" | shell+browse | DEFERRED | static | — | **verified static** (no gating field) | §0 |
| 09-05 CF-10 | No per-file "Open with ▸" (macOS/Linux have no way to open with another app) | shell | OPEN | static | — | **verified static** | §0 |
| 09-05 CF-11 / 11-04 B-02 | Context menu too long; no "More ▸"; no Properties | shell | OPEN | static | — | **verified static** | dup pair |
| fix-round errors | Non-error English text (dynamic commands, shelf names, BE task titles); structured BE errors | shell | OPEN (follow-up) | static | — | not checked | ss-27 |

### 1.3 fileops

| Alias | Symptom | Module | Status | Evid. | Marker | Verify | Dup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fileops-01 | Concurrent or interrupted journal append corrupts the journal → app won't start | fileops+shell | FIXED `75dea52`, `8045ff3` | cargo | — | not checked | G-02 |
| fileops-02 (U-02) | Ctrl+Z of a copy permanently deletes the copy, including later edits | fileops | FIXED `4bbbf6f`, `2529e5d`, `c6b09af`, `584c866`, `e5a541f` | cargo | — | **verified static** (`core/undo/cleanup.rs` trashes) | G-01 = SC-04 |
| fileops-03 (U-10) | Undo/redo of rename or move overwrites a new same-name file | fileops | FIXED `cd71b86`, `00c074f`, `dafe724` | cargo | none (tests renamed) | not checked | — |
| fileops-04 (U-04) | Copying a folder into its own subfolder self-replicates (Windows ×105) | fileops | FIXED `f008fb0`, `e016875`, `9081ca3`, `707766b`, `ffdec3f`, `167b285` and others | cargo + FE-mock | — | **verified static** (`core/path_guard.rs`) | G-04 = SC-03, browse-14, archive-22, 11-04 B-05 |
| fileops-05 (U-12) | Same IP, different port/server treated as same-host → writes on the wrong server | fileops+remote | FIXED (minimal) `ad0e605`, `c6d2a0c`, `af92787`, `f04d4a0` | static (+docker) | none | not checked | G-11 |
| fileops-06 (U-11) | One un-undoable entry blocks Ctrl+Z forever | fileops | FIXED `bbd739e`, `3dea183`, `dd1b4c0` | cargo | — | not checked | — |
| fileops-07 | macOS: undoing a trash-delete always errors | fileops | FIXED (skips as stale) `bbd739e` | cargo | — | not checked | ⊂ fileops-06 |
| fileops-08 | Case-only rename (a→A) fails on macOS/Windows | fileops | OPEN (G-25) | cargo + FE-mock | ign (`ops.rs`) | marker | G-25 |
| fileops-09 | Failed folder Replace hides the original at `.bak.<ts>`; only "Permission denied" shown | fileops | PARTIAL: FE wording `655db94`, `dedf781`. Rollback (G-08) deferred | cargo + FE-mock | ign (`ops.rs`, `elevate.rs`) | marker | G-08 |
| fileops-10 | UAC/sudo folder Replace permanently deletes the old folder (§4) | fileops | DEFERRED (G-12) | cargo | ign | not checked | G-12 |
| fileops-11 | UAC move permanently deletes the source (§3) | fileops | DEFERRED (G-12) | static + device | none | not checked | G-12 |
| fileops-12 | sudo move: skipped items' local sources trashed too | fileops | DEFERRED (G-12) | static | none | not checked | G-12 |
| fileops-13 | sudo KeepBoth renames non-conflicting items | fileops | DEFERRED (G-12) | cargo | ign | not checked | G-12 |
| fileops-14 | Same-host folder KeepBoth nests as `dir (1)/dir/…` | fileops+remote | OPEN | static + device | none | not checked | — |
| fileops-15 | Same-host Replace failure: no rollback, undo stops | fileops+remote | DEFERRED (G-08) | cargo | ign (`undo.rs`) | marker | G-08 |
| fileops-16 | Cancel shows "cancelled" but the task keeps running and then shows "done" | fileops | DEFERRED (G-09) | FE-mock | fails | marker | G-09 = archive-14 |
| fileops-17 | Cross-drive move: trash fails → both copies left, no record | fileops | DEFERRED (G-08) | cargo + FE-mock | ign + fails | marker | G-08 |
| fileops-18 | `.duet-part` left after cancel or disk-full | fileops | DEFERRED (G-19) | cargo | ign | marker | G-19 |
| fileops-19 | Rename/batch rename skips name validation (Windows `..\` escapes the folder) | fileops | FIXED `2cd2744` | cargo | — (Windows test compile-only) | not checked | G-24 |
| fileops-20 | History order flips after restart | fileops | FIXED `4b68b9d` | FE-mock | — | not checked | — |
| fileops-21 | Undo of a file-Replace copy reports success but leaves nothing | fileops | DEFERRED (D-6) | cargo | ign | marker | G-01 |
| fileops-22 | Multi-item move undo is partial and reports "skipped" | fileops | FIXED `cd71b86`, `00c074f` | cargo | — | not checked | — |
| fileops-23 | Closing the app kills running tasks silently, no record | fileops | OPEN | static + device | none | not checked | — |
| fileops-24 | Cut→paste clears the clipboard even after cancel or failure | fileops | OPEN (G-26) | FE-mock | fails | marker | G-26 |
| fileops-25 | Undo toast says "되돌림 (ok)" | fileops | FIXED `152cdf9`, `aaf0653`, `7cf20d4`, `1bd1b07` | FE-mock | — | not checked | G-17 |
| fileops-26 | Overwrites a destination `<name>.duet-part` without warning | fileops | DEFERRED (G-19) | cargo | ign | not checked | G-19 |
| fileops-27 | Batch rename rollback failure hidden | fileops | OPEN | cargo | ign | not checked | G-08 |
| fileops-28 | Task panic stalls the host queue (dev) / exits (release) | fileops | OPEN | static | none | not checked | G-09 |
| fileops-29 | No way to empty the remote trash | fileops+remote | OPEN | static | none | not checked | — |
| fileops-30 | Put-back with the original spot occupied → whole batch refused, English error | fileops | OPEN | static | none | not checked | G-17 |
| fileops-31 | Per-file conflict groups: new conflicts between re-plans are not asked | fileops | OPEN | static | none | not checked | 09-05 OP-13 |
| fileops-32 | Multi-item chmod partial failure: no record | fileops | OPEN | static | none | not checked | G-08 |
| fileops-33 | Rule leftovers: trash called from commands, staging `rm -rf`, `\`→`/` quoting | fileops | PARTIAL (quoting `fa69b92`; `rm -rf` allowed by §3 exception) | static | none | not checked | G-05 |
| fileops-34 | Relay resume appends to a stale `.duet-part` | fileops | DEFERRED (G-19) | cargo | ign (`fs/mod.rs`) | not checked | G-19 |
| fileops-35 | Folder relay retry fails at mkdir with a misleading message | fileops | OPEN | cargo | ign | not checked | G-19 |
| fileops-36 | Remote Ctrl+C leaves a stale local file on the OS clipboard | fileops+shell | OPEN | static | none | not checked | G-26 |
| 09-05 OP-13 / 11-04 dialogs | Per-file conflict decisions split into several tasks/journals → several Ctrl+Z presses | fileops | DEFERRED | static | — | not checked | fileops-31 |
| fix-round undo | stale flag not persisted (one wasted Ctrl+Z per stale item after restart); redo doesn't refresh stamps; local "not in trash" error not typed as `NotFound`; no atomic no-replace rename | fileops | OPEN (follow-up) | — | — | not checked | — |
| 10-13 R05–R12 | Create-entry dialog feedback, selecting the new item, menu targets, macOS trash hint | fileops | FIXED per `c8c16e5` doc (`0b42ce9`, `6053fd1`) | live-app (10-13 says macOS app) | — | R10 **verified static** (`menu.newFileInside`); others not checked | — |

### 1.4 browse

| Alias | Symptom | Module | Status | Evid. | Marker | Verify | Dup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| browse-01 (U-15) | Media preview reads the whole file into memory (crash risk) | browse | FIXED `16dd026`, `36d6878`, `68c1adf` | cargo | — | not checked (device: real WebView Range) | — |
| browse-02 | Remote edit (F4) save overwrites a server file that changed meanwhile | remote+browse | OPEN | cargo | ign (`edit_session.rs`) | marker | G-11 |
| browse-03 | Selected items hidden by the quick filter stay copy/delete/drag targets | browse+fileops | OPEN (G-22) | FE-mock | fails | **verified static**: `panes.ts:942-952` `setFilter` doesn't prune `selected`; `resolveActiveTargets` uses raw `tab.selected` | G-22 = SC-07, SC-35 |
| browse-04 | "Open in other pane" opens a remote folder locally | browse | FIXED `4e191fc` | FE-mock | — | not checked | G-06 |
| browse-05 | Back/forward, start path, stale search hits mix remote and local | browse | FIXED `416a13b`, `4e191fc`, `9a0cb2b` | FE-mock | — | not checked | G-06 |
| browse-06 | CP949/UTF-16 text preview shown as binary or truncated | browse | FIXED `743cc7f`, `a0c17a8`, `190e316` (archive team) | cargo | — | not checked | G-13 = SC-21 |
| browse-07 | Large unregistered-extension text preview freezes the UI for seconds | browse | OPEN | FE-mock + device | none (no marker found) | not checked | — |
| browse-08 | Clicking a markdown preview link navigates the app window | browse | OPEN (D-14) | FE-mock + device | fails | marker | — |
| browse-09 | Keyboard "calc size" on the cursor folder computes a different folder | browse | OPEN | FE-mock | fails | marker | — |
| browse-10 | Windows UNC root: Up/breadcrumb breaks | browse | FIXED `1041fe7` (BE move deferred) | FE-mock + device | — | not checked | G-24 |
| browse-11 | Quoted "Copy as path" not accepted in the path bar | browse | FIXED `d16998e`, `f9f3976`, `1870445` | FE-mock | — | not checked | G-24 |
| browse-12 | When two panes share a folder and one leaves, the other's watcher stops | browse | OPEN | cargo | ign | not checked | — |
| browse-13 | Each fs event re-reads the whole list (1000 events → 1000 reads) | browse | OPEN | FE-mock | fails | marker | — |
| browse-14 | FE doesn't block dropping into a grandchild folder | browse+fileops | FIXED `ffdec3f` | FE-mock | — | not checked | G-04 |
| browse-15 | Unreadable tab shows "empty folder" | browse | OPEN (G-21) | FE-mock | fails | marker | G-21, 11-04 #2 |
| browse-16 | Grid thumbnail stale for up to 1 h; failure state sticks | browse | OPEN | FE-mock | fails | marker | — |
| browse-17 | Remote-edit upload failure or watcher end not shown | remote+browse | OPEN | static | none | not checked | with browse-02 |
| browse-18 | Remote folder size shows 0 B if one child is unreadable | browse | OPEN (G-21) | static | none | not checked | G-21 |
| browse-19 | One unreadable subfolder fails the whole local size calc | browse | OPEN (G-21) | cargo | ign | not checked | G-21 |
| browse-20 | Late dir-size result attaches to the same name in the new folder | browse | OPEN | FE-mock | fails | marker | — |
| browse-21 | macOS UF_HIDDEN items shown with hidden files off | browse | OPEN | cargo | ign | not checked | — |
| browse-22 | Remote Enter-open reuses one temp per basename; edits not uploaded | remote+browse | OPEN | static | none | not checked | ss handoff (`download_to_temp`) |
| browse-23 | Failed back/forward moves the history index anyway | browse | FIXED `416a13b`, `9a0cb2b` | FE-mock | — | not checked | G-06 |
| browse-24 | Sync browsing skips silently when the other side lacks the folder; back/forward not synced | browse | DEFERRED (D-14) | static | none | not checked | — |
| browse-25 | Pattern select `[!a]*` inverted; `\d` treated as regex | browse | OPEN | FE-mock | fails | marker | — |
| browse-26 | Session saved on a 500 ms debounce only (lost on fast close) | browse | OPEN | FE-mock | fails | marker | — |
| browse-27 | Non-UTF-8 local names silently dropped (Linux) | browse | OPEN | static + device | none | not checked | G-21 |
| browse-28 | Size sort ignores computed folder sizes | browse | OPEN | FE-mock | fails | marker | — |
| browse-29 | Thumbnail/icon caches unbounded; thumbnails in the config dir (Roaming) | browse | OPEN | static | none | not checked | — |
| browse-30 | Folder-open failure notice has no detail | browse | FIXED `a0af0bf` | FE-mock | — | not checked | G-16 |
| browse-31 | Toast doesn't pause on hover | shell | FIXED `d5e9725` | FE-mock | — | not checked | = ss-23 |
| browse-32 | Back after leaving an archive enters the temp dir; Update button gone | browse+archive | DEFERRED (G-07) | FE-mock | fails | marker | G-07 |
| browse-33 | PDFs over 16 MiB never preview | browse | FIXED `16dd026`, `b82bc06`, `5cf13cb` | FE-mock (real pdf.js) | — | not checked | — |
| browse-34 | Leaving an archive root puts the cursor on `..` instead of `x.zip` | browse+archive | OPEN (G-07) | FE-mock | fails | marker | G-07 |
| fix-round browse R3-S4-1 | NFC+NFD siblings on a normalization-sensitive FS: 3-way/compare apply overwrites the other form (`.bak` + undo work) | sync | OPEN (ignored repro `c9b11fc`) | cargo | ign | not checked | SC-17 |
| fix-round browse | browse-10 root/parent logic still in FE `splitRoot` (§7 move to BE pending) | browse | OPEN | — | — | not checked | — |
| 11-04 #1 | Dev StrictMode bootstrap runs twice → wrong restored active tab | browse | OPEN | static | — | not checked | — |
| 09-05 CF-04 | Search results: no multi-select, copy, or "results to panel" | browse | PARTIAL (filters added) | static | — | not checked | — |

### 1.5 remote

| Alias | Symptom | Module | Status | Evid. | Marker | Verify | Dup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| remote-01 (U-13) | Same-host copy/sync: `\` in a name becomes `/` → wrong file copied, unrelated file overwritten | remote | FIXED `fa69b92` and G-05 set; docker repros kept `6f3cbce` | docker-IT + cargo | ign ("docker 필요", intended) | not checked | G-05 |
| remote-02 (U-14) | ProxyJump: approving the jump host's fingerprint also trusts or replaces the target key (MITM) | remote | DEFERRED (G-11) | cargo | ign | marker | G-11 |
| remote-03 | Remote symlinks all shown as files; can't enter dir links | remote | OPEN | cargo | ign | marker | G-15 |
| remote-04 | After editing a saved host's address, the vault sends the old password to the new address (security) | remote | OPEN (G-11). Note: 11-04 "connection" claimed a fix for this class; the 11-08 repro still fails | FE-mock | fails | marker → **possible incomplete 11-04 fix** | G-11 |
| remote-05/06/07 | Unresponsive server or long remote command freezes the whole connection for 75–330 s+; no connect timeout; cancel doesn't stop the remote command | remote | DEFERRED (G-10) | cargo (+docker) | ign | not checked | G-10 = SC-24 |
| remote-08 | Cross-volume remote trash failure: partial source loss, no record | remote | DEFERRED (G-08) | cargo | ign | not checked | G-08 |
| remote-09 | Same-host, different-user copy fails with "Permission denied", no warning | remote | DEFERRED (D-9) | cargo | ign | not checked | — |
| remote-10 | Banner reconnect gives a new connection ID; clipboard, shelf and undo point at the old ID | remote | DEFERRED (G-11/G-26) | cargo + FE-mock | ign + fails | marker | G-26 |
| remote-11 | Remote search inside a hidden folder always returns 0 | remote+browse | OPEN | cargo | ign | not checked | — |
| remote-12 | sudo upload always fails "not found: ~/.duet-sudo/…" | remote | DEFERRED (G-12) | cargo | ign | not checked | G-12 |
| remote-13 | `~/.ssh/config` Include, `Host a b`, `Host *` ProxyJump, `!`, Match mis-parsed | remote | OPEN | cargo | ign | not checked | — |
| remote-14 | Password-only ProxyJump target drops the jump and connects directly | remote | OPEN | cargo | ign | not checked | — |
| remote-15 | Windows OpenSSH agent / Pageant unsupported | remote | OPEN | static + device | none | not checked | — |
| remote-16 | No passphrase prompt; a passphrase typed into the password field is sent to the server | remote | OPEN | cargo | ign | not checked | G-27 |
| remote-17 | Windows client remote KeepBoth creates `dst\file (1)` in the parent | remote | FIXED `165e800` (G-05) | static + device | none | not checked | G-05 |
| remote-18 | Remote browse temp `~/.duet-tmp/browse-*` never cleaned | remote+archive | DEFERRED (G-20) | cargo | ign | not checked | = archive-25 |
| remote-19 | Truncated saved-hosts file prevents startup | remote+shell | FIXED (U-03) | cargo | — | not checked | G-02 |
| remote-20 | Windows known_hosts at `%USERPROFILE%\ssh\` (not `.ssh`) | remote | OPEN | static + device | none | not checked | — |
| remote-21/22 | Vault concurrent tmp save; failed save reported as saved | remote | FIXED `c0ee585`, `5b9e3c5` | cargo | — | not checked | G-03 |
| remote-23 | Download during a disconnect times out with no retry; `.duet-part` left | remote | OPEN | cargo | ign | not checked | G-19 |
| remote-24 | Remote failures don't name the cause (`sftp: Failure`) | remote | OPEN (errors team: needs BE stat) | static | none | not checked | G-17 |
| remote-25 | Newline in a name splits remote search hits | remote+browse | OPEN | static | none | not checked | = SC-29 (G-23) |
| remote-26 | Connect error box and banner show raw "os error 61" | remote | FIXED `562c2c3`, `c6e9cb2`, `69f82e8`, `9899098` | FE-mock | — | not checked | G-16 |
| remote-27 | Auto-reconnect success doesn't refresh the pane | remote | OPEN | static | none | not checked | — |
| remote-28 | Reconnect cancel/success race can revive a closed connection | remote | OPEN | static | none | not checked | — |
| remote-29 | sudo run not tied to task cancel | remote | OPEN | static | none | not checked | G-09, G-12 |
| remote-30 | `@` in the username breaks ad-hoc alias parsing | remote | OPEN | FE-mock | fails | marker | G-11 |
| remote-31 | `AdhocConnectParams` with a password derives `Debug` (§5) | remote | OPEN | static | none | not checked | G-27 |
| remote-32 | Remote polling opens a new SFTP subsystem every 3 s; content changes missed | remote | OPEN | static | none | not checked | — |
| remote-33 | known_hosts backup name per second → double replace overwrites the backup | remote | OPEN | static | none | not checked | — |
| remote-34 | App temp dirs removed with SSH `rm -rf` | remote | RESOLVED by rule (CLAUDE.md §3 exception, bd194f4) | static | — | — | — |
| remote-35 | `ssh-it.sh` wrote to the user's known_hosts | remote | FIXED `19691d4` | — | — | not checked | — |
| errors G-27 handoff | Remote exec error text included `unzip -P '<pw>'` | remote+archive | FIXED `c45d373`, `7511fb5` | cargo | — | **verified static** (`ssh/remote_exec.rs:185-195` `exec_failed` reports only `program_name(cmd)`) | G-27 |
| fix-round paths | Native (non-POSIX) remote path joins remain in `archive.rs` backup/reap, `undo.rs`, `sudo.rs`, `search.rs`, `fs/ssh.rs` trash, FE `entryDnd`/`pathCrumbs`/`newEntry` (Windows client only) | remote+archive+fileops | OPEN (follow-up) | static | — | not checked | G-05 |
| 11-04 sidebar H-1/H-2, connection H1/H2 | Removing a host or bookmark has no undo; vault password survives host removal; auto-reconnect only for ssh-config + key hosts | remote | DEFERRED | static | — | not checked | — |
| 11-04 dialogs | Remote "move" alias stores a session `connection_id` (dead after restart) | remote | DEFERRED | static | — | not checked | G-26 |

### 1.6 sync (compare / merge / sync / search index)

| Alias | Symptom | Module | Status | Evid. | Marker | Verify | Dup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SC-01 (U-07) | Sync failure or cancel: no undo; originals stuck at `.bak`; Ctrl+Z after cancel undoes the previous operation | sync | DEFERRED (G-08) | cargo | ign | marker | G-08 |
| SC-02 (U-08) | Delete-propagating + overwriting sync: undo "succeeds" but overwritten files are not restored | sync | DEFERRED (D-7) | cargo | ign | marker | — |
| SC-03 | Parent/child sync or merge self-replicates; reverse direction trashes the source | sync | FIXED (U-04) `9081ca3` | cargo | — | not checked | G-04 |
| SC-04 | Undo of apply/merge/3-way/sync permanently deletes later edits | sync | FIXED (U-02) | cargo | — | not checked | G-01 |
| SC-05 | 3-way treats an unreadable subfolder as empty → deletes the other side | sync | OPEN (G-21) | cargo | ign | marker | G-21 |
| SC-06 | Follows a link or junction in the destination → writes or trashes outside scope | sync | OPEN (G-15) | cargo + device | ign | not checked | G-15 |
| SC-07 | Items hidden in the compare view are copied wholesale by merge | sync | OPEN (G-22) | cargo | ign | not checked | G-22 |
| SC-08 | Apply after the source was deleted pushes the destination to `.bak` | sync | OPEN | cargo | ign | not checked | G-08 |
| SC-09 | Merge undo while disconnected reports success | sync | FIXED `2529e5d` | cargo | — | not checked | G-01 |
| SC-10 | Same-host rsync: Korean names escaped (undo misses them); openrsync fails | sync+remote | OPEN | cargo + device | ign | not checked | — |
| SC-11 | Local↔remote compare: identical files show as "newer"; default direction overwrites (tolerance 0) | sync | OPEN | static | none | not checked | — |
| SC-12 | Sync confirm mixes new and overwritten files in one list | sync | OPEN | static | none | not checked | — |
| SC-13 | Preview OK, execute fails on permissions | sync | OPEN (G-21) | FE-mock | none (no marker found) | not checked | G-21 |
| SC-14 | Progress shows file counts as bytes ("12 B / 40 B") | sync | OPEN | FE-mock | fails | marker | — |
| SC-15 | Local↔remote sync: English dev error, no alternative given | sync | PARTIAL: wording `8b18bee`; menu not disabled (D-8) | FE-mock | — | not checked | G-17, gating §0 |
| SC-16 | 3-way base defaults to the left path → everything classified as delete | sync | OPEN | static | none | not checked | — |
| SC-17 | NFC/NFD names: two rows, not searchable; macOS apply overwrites both | sync+browse | FIXED `48517aa`, `fba82fc`, `48b66f7`, `a929661`, `420312e` (residual R3-S4-1) | cargo | — | not checked | G-14 |
| SC-18 | Re-index doesn't pick up files created after app start | browse | OPEN | FE-mock | none (no marker found) | not checked | — |
| SC-19 | Full-drive index at every launch (network/USB) | browse | OPEN (G-28) | FE-mock + device | none (no marker found) | not checked | G-28 |
| SC-20 | Content search ignores size/date/kind filters | browse | OPEN | FE-mock | none (no marker found) | not checked | — |
| SC-21 | CP949 diff preview truncated; UTF-16 shown as binary | sync | FIXED (with browse-06) | cargo | — | not checked | G-13 |
| SC-22 | CRLF↔LF-only diff shows every line changed | sync | FIXED `da467a3`, `c12a362` | FE-mock | — | not checked | — |
| SC-23 | Diffs after line 600 not shown | sync | OPEN | static | none | not checked | — |
| SC-24 | Remote checksum or same-host sync holds the session lock | sync+remote | DEFERRED (G-10) | static + docker | none | not checked | G-10 |
| SC-25 | Index cache filename collision (`a-b`↔`a_b`) | browse | OPEN | static | none | not checked | — |
| SC-26 | Corrupt cache JSON panics search | browse | FIXED `b647df4` | cargo | — | not checked | G-02 |
| SC-27 | Filename search ignores the hidden-files exclusion | browse | OPEN | static | none | not checked | — |
| SC-28 | CSV export: no BOM, formula injection | sync | FIXED `5689c20` | cargo | — | not checked | — |
| SC-29 | Remote search: newline names split | browse+remote | OPEN | static | none | not checked | = remote-25 |
| SC-30 | Remote shell path turns `\` into `/` | sync+remote | FIXED (G-05) | static | none | not checked | G-05 |
| SC-31 | Sync undo leaves empty created dirs | sync | FIXED `4bbbf6f`, `2529e5d`, `584c866` | cargo | — | not checked | G-01 |
| SC-32 | Large single file during sync: no cancel or progress | sync | OPEN | static | none | not checked | G-09 |
| SC-33 | Diff preview: right side over 600 lines truncated with no notice | sync | OPEN | static | none | not checked | — |
| SC-34 | Checksum field rejects pasted `sha256sum`-format text | sync | OPEN | FE-mock | (sync-compare-checksum it.fails exists; ID not on the line) | not checked | — |
| SC-35 | Filter-hidden rows included in "apply" | sync | OPEN (G-22) | static | none | not checked | G-22 |
| SC-36 | Keyboard can't return a row to skip; view switch clears the selection | sync | OPEN | static | none | not checked | — |
| SC-37 | Compare list not virtualized (5000 rows) | sync | OPEN | static + device | none | not checked | — |
| SC-38 | Sync list cut at 200 with no "and N more" | sync | OPEN | static | none | not checked | — |
| SC-39 | English task titles; failures not in History; raw undo errors | sync+fileops | OPEN | static | none | not checked | ss-27 |
| SC-40 | Pre-start-cancelled merge/apply leaves an empty journal entry | sync | FIXED `f4031a0`, `491fecf` | cargo | — | not checked | — |
| SC-41 | Undo messages hard-coded Korean | sync | OPEN | static | none | not checked | — |
| SC-42 | Search status shows "indexing" ahead of the result count; no ↑↓ | browse | OPEN | static | none | not checked | — |
| SC-43 | Compare start race (Esc ignored; old cancel closes the new window) | sync | OPEN | FE-mock | fails | marker | — |
| SC-44 | 3-way has no progress or cancel; re-compares on apply | sync | OPEN | static | none | not checked | G-09 |
| SC-45 | Export format chosen by extension only | sync | OPEN | static | none | not checked | — |
| SC-46 | Preview exposes internal names (`too_large`, `binary`) | sync | OPEN | static | none | not checked | — |
| SC-47 | Remote checksum fails on `\` or newline names | sync+remote | FIXED `b6d0e33` | cargo | ign (`review_sync_compare_r3_sol.rs`: source-parse test; check) | not checked | G-05 |
| SC-48 | Jumper: remote label is the IP after restart, stale folders, no initials search | browse | OPEN | FE-mock | (sync-compare-jumper it.fails exists) | not checked | — |
| SC-49 | Content search silently skips files over 8 MiB; ignore-glob differs FE/BE | browse | OPEN | static | none | not checked | G-21 |
| SC-50 | Hard-coded modal keys; `useEffect` data fetching | shell | DEFERRED (D-12) | static | — | — | 11-04 B-01 |
| SC-51 | `verify_relay` joins local paths POSIX-style | sync | FIXED (G-05) | static | none | not checked | G-05 |
| SC-52 | Local sync `.bak` files pile up in the destination | sync | DEFERRED (D-7) | static | none | not checked | SC-02 |

---

## 2. Duplicates and cross-links (beyond the README's G-groups)

- **Exact duplicates:**
  - archive-25 = remote-18
  - remote-25 = SC-29
  - browse-31 = ss-23
  - browse-06 = SC-21
  - ss-08 ⊂ browse-05
  - fileops-07 ⊂ fileops-06
  - 09-05 CF-11 = 11-04 file-view B-02
  - 11-04 file-view B-05 = fileops-04
  - 11-04 "disconnected pane shows empty folder" = browse-15
- **Same root cause, different symptom:**
  - G-07 archive context: archive-15, browse-32, browse-34, archive-23, and the fixed archive-02
  - G-22 hidden-but-targeted: browse-03, SC-07, SC-35
  - G-26 stale clipboard/shelf: ss-06, ss-31, fileops-24, fileops-36, remote-10
  - G-09 cancel: fileops-16, archive-14, SC-32, SC-44, remote-29, fileops-28
- **Possible regression or incomplete fix to re-check:** remote-04 (saved-host address edit leaks the old vault
  password). 11-04 "connection" listed a fix for this class, but the 11-08 Vitest repros (3 files) are still `it.fails`
  at base. Assign to remote.
- **Old-fix vs new-rule conflicts:** the baseline `mvp2_smoke` Replace test was realigned in `c840b06`.
  fileops-21 still waits on D-6.

## 3. Open-issue hot list for this smoke round (prior + still open at base, user-facing workflows)

| Module | Highest-value open prior items |
| --- | --- |
| archive | §0 multi-extract gap (new). archive-21 (silent `.bak` on extract). archive-03/09/14 (no rollback, cancel ignored). archive-15/browse-32/34 (archive context). archive-11 (encryption dropped on repack). archive-26 |
| shell | §0 multi-item More menu (new). ss-10 (empty-space More = folder's own menu). ss-16. CF-10 Open-with. Command availability gating (none exists). ss-26/28/29 |
| fileops | fileops-08 (case-only rename). fileops-09/15/17 (G-08 rollback). fileops-16 (cancel). fileops-24, ss-06/31 (clipboard/shelf). fileops-23 (close mid-task). fileops-10..13 (elevation) |
| browse | browse-03 (filter-hidden selection). browse-09/20 (dir size). browse-13 (event storm). browse-15. browse-08. browse-25/26/28 |
| remote | remote-04 (security, possible incomplete fix). remote-02 (U-14). G-10 freezes (remote-05/06/07). remote-03 (symlinks). remote-16. remote-10. browse-02/17 (remote edit) |
| sync | SC-01/02 (sync undo). SC-05/06/07 (scope safety). SC-11/16 (dangerous defaults). SC-14. SC-15 menu gating |

## 4. Method notes and limits

- No tests were run (lead instruction: static research default; no full cargo or vitest runs).
  All "verified static" claims come from reading files at 76b9b6e and are cited inline.
- The marker scan can false-positive when an unrelated `#[ignore]`/`it.fails` sits within 4 lines of an ID mention,
  and can false-negative when a repro test doesn't spell the ID (for example `c02_*`, `sc04`).
  Treat it as triage, not proof.
- Windows, real SSH and live-app behaviour are **unverified** for every row above unless the row says otherwise.
  No prior round ran a live app or real Windows, except 10-13 (macOS app) and the remote team's docker sshd.
