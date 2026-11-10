# Priority repro — current code at 76b9b6e

Evidence: **STATIC throughout** (code reading only; no app, Windows, Bandizip or tests run). Paths relative to repository root. No product changes.

| Claim | Exact gate / evidence | Owner |
| --- | --- | --- |
| Entry menu builder | `src/App.tsx:744-759` retains selection when right-clicking a selected row, otherwise selects only that row; passes selectedCount to `buildEntryMenu` (`src/lib/entryMenu.tsx:148`). `src/components/ContextMenu.tsx` renders generic entries. No EntryContextMenu component in this revision. | shared App + entryMenu; coordinate archive/shell |
| Multi archives have no extract item | `src/lib/entryMenu.tsx:164`: multi = selectedCount > 1; line 284 requires `!isDir && !multi && canExtractArchive(entry.name, location.source)`. All multi selections fail regardless of names/extensions. No same-name/same-type comparison. | archive |
| Archive recognition | `src/lib/archive.ts:47-56`: lowercase longest recognized suffix, then local OR remote suffix set. Local supports zip/tar variants/7z/rar/gz/bz2/xz/zst; SSH excludes 7z/rar and standalone compression. Only clicked name examined. | archive |
| Shared action also rejects multi | `src/lib/fileActions.ts:632-638`: `targets.length !== 1` toasts extractSelectOne and returns; else fsExtractPlan(targets[0]). Menu-only fix insufficient. | archive |
| More options absent, not merely disabled | `src/App.tsx:762-766`: `platform() === "windows" && tab.location.source.kind === "local" && selectedCount === 1`. win-more added at 775. SSH/macOS/Linux never get it; no name/type check. | shell |
| Native IPC one path | `src/lib/shellMenu.ts:55-59`: openShellMenu(path: string, scope) calls shellMenuOpen. `src-tauri/src/commands/system.rs:687-705`: shell_menu_open(path: PathBuf, scope: ShellScope), normalizes path then opens worker. warm also one path (724-739). | shell |
| Native platform implementation | `src-tauri/src/platform/shell_menu.rs:454-474`: one absolute PIDL, parent IShellFolder, GetUIObjectOf(hwnd, &[child as *const ITEMIDLIST], None): exactly one child. Windows COM IContextMenu/HMENU, not macOS NSMenu. Non-Windows command returns empty items (`system.rs:708-715`). Execution token/cmd_id (`system.rs:751-762`, FE `shellMenu.ts:43-47`). | shell |
| No exposed batch/extract-each API | `src-tauri/src/commands/fs_ops.rs:1535-1540` takes one archive: EntryRef; execute one ExtractPlan (1545-1549), enqueues one archive task (1556-1574). `core/archive.rs:184-195` has one archive_name/format/dest_dir. Search src-tauri/src for extract_each/extract_batch found none. | archive |
| Existing Extract here targets stem folder | `core/archive.rs:214-216`: destination = archive directory joined with archive_stem. Standalone compression yields a file instead (190-192). Current wording does not mean flat extraction into current directory. | archive |

Minimal fixes (STATIC proposals):

- **ARC-001** archive: derive supported regular archives from full resolved selection; define mixed-selection policy; change both single gates; orchestrate existing single-archive plan/execute per target for extract-each-to-stem-folder, preserving password retry/errors and handling destination collisions. True flat extract-here requires destination/mode support beyond current plan. Test differently named zip/7z/tar.gz; same stem across suffixes; mixed archive/file/folder; SSH unsupported formats; password/error on one item.
- **SHL-001** shell: extend open/warm requests and cache identity from one path to selection; retain all child PIDLs and obtain one selection IContextMenu from common parent; pass all selected local entries from App, then relax count gate. Keep background distinct. Test full-selection IPC/cache isolation and real Windows extension behavior. Bandizip population **unverified** until Windows execution.
- Shared-file coordination: archive owns entryMenu extract section/fileActions; shell owns App win-more section/shellMenu/platform worker. Do not pass only clicked/focused file as a multi-selection fix.

Prior context read: functional-review README/archive; fix-round README. Archive context issues archive-15/G-07 are separate; no claim priority repro was fixed in prior round. No tests executed (lead requested static default).
