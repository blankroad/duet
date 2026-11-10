# archive R1b — TRUE "Extract here" (primary) + Extract each to folder (supersedes SPEC-R1 §1, §2, §4, §5)

Main correction (2026-11-10): the user asked to extract multiple archives **into this folder**. True extract-here is
required. "Extract to folder" stays as a second item. KeepBoth must never replace anything, even on a race.
SPEC-R1 §3 (non-archive skip), §6 (password FIFO), §7 (partial failure), §8 (ownership), Addendum A (palette) still apply.

## Menu (archive section of `entryMenu.tsx`)

| Selection | Items |
| --- | --- |
| 1 archive | **여기에 압축 풀기 / Extract here** · **"<stem>" 폴더에 압축 풀기 / Extract to "<stem>/"** (stem shown only if BE gives it; else "폴더로 압축 풀기 / Extract to folder") |
| k≥2 archives (+ others) | **여기에 압축 풀기 (k개) / Extract k archives here** · **각각 폴더로 압축 풀기 (k개) / Extract each to its own folder (k)** |
| remote (ssh) | Extract-to-folder items only in R1. Extract here hidden on ssh (limit, see below). |

Source archives are never moved, renamed or deleted.

## A. Extract here — semantics

For each archive, in selection order, as **its own task** (own journal entry → own Ctrl+Z step, §4):

1. **Staging.** `fs.mkdir(<archive_dir>/.duet-extract-<uuid>)` (same volume → renames are cheap). Extract the archive into
   staging with the existing engines (`extract_local` — single-file `.gz` etc. land as `<stem>` inside staging).
   NeedPassword / damaged / cancelled during this phase → nothing has been placed; go to step 4 (cleanup) and return the error.
2. **Placement** of each top-level staged item into `<archive_dir>` via `place(staged, parent, name)`:
   - staged **dir**:
     - `fs.mkdir(target)` succeeds → we created it (record as *created*), move each child in with `fs.rename` (target is
       brand new, so no collision), then `fs.remove_empty_dir(staged)`.
     - `AlreadyExists` and existing is a **real dir** (`symlink_metadata`, never follow links) → **merge**: recurse into children.
     - existing is a file / symlink (incl. symlink to dir) → **conflict** → policy.
   - staged **file or symlink**:
     - reserve with `fs.create_new_file(target)` (atomic, never replaces) → `fs.rename(staged, target)` over our own
       empty placeholder → record as *created*.
     - `AlreadyExists` → **conflict** → policy.
   - **Policy** (one choice per batch, from the FE dialog):
     - `KeepBoth` (default): next free `name (2).ext`, `(3)`… — each candidate **reserved atomically** (mkdir / create_new_file);
       on `AlreadyExists` try the next number. Never backs up, never replaces. Reuse the existing KeepBoth name helper if it is
       callable from core without editing `core/ops.rs`; otherwise write a small one in `core/archive_here.rs`.
     - `Replace`: move existing aside with `ops::pick_backup_path` + `fs.rename` (record in `backups_to_restore`, Ctrl+Z restores),
       then reserve+place. If the reservation still fails (race) → fall back to KeepBoth naming. Never `fs.remove` a user item.
       Folder-vs-folder is always merge, never Replace (no whole-folder swap in extract-here).
     - `Skip`: leave the staged item; count it.
   - Check `cancel_token` between items.
3. **Journal.** `UndoAction::UndoCopy { copied: <top-most created paths>, backups_to_restore, copied_stamps, … }`,
   `OpKind::Extract { archive, dest: <archive_dir> }` (or a new `OpKind::ExtractHere` if journalLabel needs it — FE label too).
   Push the journal entry **even if placement stopped part-way** (cancel / error) for what was already placed, then return the error.
4. **Cleanup of staging.** Whatever remains in staging (skipped items, unplaced items after error) → `fs.trash` the staging dir
   (CLAUDE.md §3: delete = trash). If empty → `fs.remove_empty_dir`. If trash fails → leave it and put its path in the error /
   summary. Never `fs.remove` / `remove_dir_all` on staging.
5. **Report** (`ExtractHereSummary`): placed count, renamed (old→new) list, replaced (with backup path) list, skipped list,
   leftover staging path if any. FE shows one notice per batch (renamed/skipped/replaced counts, names in detail).

### IPC (proposed — implementer may refine, report changes)

```rust
pub enum ExtractConflict { KeepBoth, Replace, Skip }
#[tauri::command] fs_extract_here(archives: Vec<EntryRef>, policy: ExtractConflict) -> Vec<ExtractDispatch>
// ExtractDispatch { archive: EntryRef, task_id: Option<TaskId>, error: Option<DuetError> }  — per-archive validation errors
// (unsupported format / remote / not a file) don't stop the others.
#[tauri::command] fs_extract_here_retry(archive: EntryRef, policy: ExtractConflict, password: Option<String>) -> TaskId
```
Core: `core/archive_here.rs` (new file; `archive.rs` is already > 1000 lines) with
`pub async fn extract_here_execute(fs, archive: EntryRef, policy, password, ctx, cancel) -> Result<(JournalEntry, UnpackReport, ExtractHereSummary), DuetError>`.
Bindings: **do not run `pnpm gen:bindings` or cargo until the lead relays a slot** (machine RAM queue). Write the TS-side
types by hand only inside tests if needed and say so; final bindings come from a real `gen:bindings` run.

## B. Extract each to its own folder (existing extract, multi)

- Per archive `<stem>/` next to it, as today.
- Intra-batch duplicate stems (`a.zip` + `a.tar.gz`): later ones get `a (2)` …
- Existing `<stem>` on disk: the batch dialog choice — `Replace` = today's rule (existing folder → `.bak`, journal, Ctrl+Z) /
  `KeepBoth` = **reserve at execute time** with atomic `fs.mkdir` (single-file formats: `create_new_file`) looping
  `stem (2)`, `(3)`…; plan's name is only a hint. **Never back up or replace on KeepBoth**, even if the planned name got
  taken after planning (TOCTOU) / `Skip` / Cancel.

## FE

- `extractActions.ts`: `triggerExtractHere`, `triggerExtractToFolders` (shared filtering/skip toast/summary).
- Extract-here dialog: archive list + "이미 있는 항목: 둘 다 유지(기본) / 덮어쓰기(백업, Ctrl+Z) / 건너뛰기", Enter = confirm.
  Reuse the visual pattern of the existing copy/move conflict dialog where practical.
- Password FIFO queue (SPEC-R1 §6) must work for both actions (retry calls the matching command with the same policy).

## Limits stated up-front (report them, don't hide)

- Remote extract-here: SFTP `rename` semantics (OpenSSH link/unlink → EEXIST on our own placeholder) are unverified on a real
  server → hidden on ssh in R1; remote uses extract-to-folder.
- No pre-flight conflict listing (would need reading every archive's index first) → policy dialog is always shown for
  extract-here.
- Windows: replacing our own placeholder file with a staged **symlink** via `rename` is cross-compile only (no device).

## Tests (core: real tempdirs only, never user paths)

1. two zips both containing `photos/` with different files → one merged `photos/` with all files; undo of the 2nd removes only
   its files.
2. existing `readme.txt` + KeepBoth → `readme (2).txt`, original untouched; with a pre-created `readme (2).txt` → `(3)`.
3. Replace → original in backup, new in place; undo restores original.
4. Skip → original untouched, skipped listed, staging trashed (use a test fs whose trash records calls).
5. existing **symlink** named like a staged dir → conflict (not merged through the link); nothing written outside.
6. single `.gz` here; tar.gz with nested dirs; password zip NeedPassword → nothing placed, staging gone.
7. failure mid-placement (test fs injecting rename error on item 2) → journal records item 1, error returned, staging handled.
8. each-to-folder KeepBoth TOCTOU: plan says `a (2)`, create `a (2)` before execute → result `a (3)`, `a (2)` untouched, no backup.
Vitest: menu items for 1/k/mixed/remote; dialog policy passed to command; skip toast; summary notice; password FIFO.
