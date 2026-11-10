# sync module — Phase 1 baseline (ux-sync-opus)

- Worktree / branch: `/tmp/duet-ux-smoke-worktrees/sync-opus`, `ux-smoke/sync-opus` @ `76b9b6e` (clean, no edits)
- Date: 2026-11-10
- **Rust repro results: NOT RUN (cargo frozen).** The main session stopped all worktree cargo processes (lead SIGINT'd PID 66616) during the cold dependency build, before any test binary was built. Per the freeze I did not retry. All Rust classifications below come from **reading the code**, not from running the tests. Each one is labelled `static`.
- FE: focused vitest only, 2 workers. 5 of 6 repro files **could not load** because the gitignored `src/types/bindings.ts` is missing and `pnpm gen:bindings` runs cargo (frozen).

## 1. Commands run and results

| # | Command (cwd) | Result |
|---|---|---|
| 1 | `CARGO_BUILD_JOBS=2 cargo test --no-run --lib --test review_sync_compare_apply --test review_sync_compare_xcheck_opus --test review_sync_compare_xcheck_sol --test review_sync_compare_sol --test review_sync_compare_r3_sol` (src-tauri) | Stopped mid-way by the main session's freeze while still compiling dependencies (`cargo_metadata`, `dom_query`). No test binaries were built. |
| 2 | `cargo test --test review_sync_compare_{apply,xcheck_opus,xcheck_sol,sol,r3_sol} -- --ignored` (src-tauri) | EXIT=130 (SIGINT, freeze). **0 tests run.** |
| 3 | ops.rs `review_sync_failure_keeps_dst_original_in_place`, `review_sync_failure_journals_partial_progress` (`--lib -- --ignored`) | **not run (cargo frozen)** |
| 4 | `pnpm install --frozen-lockfile --offline` | OK (14.5s) |
| 5 | `npx vitest run <6 sync-compare __review__ files>` | Test Files 5 failed / 1 passed. The 5 failures are **import errors** (`Failed to resolve import "@/types/bindings"`), not product results. |
| 6 | `npx vitest run --reporter=verbose --maxWorkers=2 --minWorkers=1 src/lib/__review__/sync-compare-errors.test.ts` | 5/5 pass. Two of those are `it.fails` tests that still fail as expected, so those two bugs **still exist** (see §3). |

Note: in vitest 2.1.9, `--maxWorkers=2` alone errors with "minThreads and maxThreads must not conflict". Add `--minWorkers=1`.

To re-run once a cargo slot is granted:
```
cd src-tauri && export CARGO_BUILD_JOBS=2
cargo test --test review_sync_compare_apply --test review_sync_compare_xcheck_opus \
  --test review_sync_compare_xcheck_sol --test review_sync_compare_sol --test review_sync_compare_r3_sol -- --ignored
cargo test --lib review_sync_failure_ -- --ignored
cd .. && pnpm gen:bindings && npx vitest run --maxWorkers=2 --minWorkers=1 \
  src/components/__review__/sync-compare-xcheck-progress.test.tsx \
  src/components/dialogs/__review__/sync-compare-{compare-flow,checksum,diffpreview}.test.tsx \
  src/lib/__review__/sync-compare-{r3-cancel,errors}.test.ts
```

## 2. Ignored Rust repros, classified from code (static)

Repro inventory: 33 `#[ignore]` tests: 31 in the 5 integration files (apply 3, xcheck_opus 3, xcheck_sol 7, sol 16, r3_sol 2) plus 2 in `core/ops.rs`. `review_sync_compare_r3_opus.rs` has 0 ignored.
Counts: **still failing 20 · fixed (stale ignore) 2 · fixed but repro obsolete 2 · environment-only checks 3 · outside sync scope 6.**

### Still failing (bug still in code) — sync scope

| Issue | Tests | Evidence in current code |
|---|---|---|
| **SC-01** a sync that fails or is cancelled part-way leaves no journal entry and leaves the original renamed to `.bak` | ops.rs `review_sync_failure_keeps_dst_original_in_place`, `review_sync_failure_journals_partial_progress`; xcheck_opus `sync_cancel_midway_journals_what_was_already_applied`; xcheck_sol `sc01_stat_failure_after_backup_keeps_original_in_place`, `sc01_cancel_after_first_completed_file_keeps_journal` (5) | `ops.rs:1271-1280` `mirror_dir(...).await?` and `:1285-1294` `prune_pass(...).await?` return early, so `ctx.journal.push` at `:1312` never runs. `:1366` does `rename(d, backup)?` and then copies, with no move back if the copy fails. Same pattern in `sync_execute_same_host` (`:1456`). |
| **SC-02** with prune on, prune trashes the `.bak` this same run just made | xcheck_opus `sync_prune_overwrite_then_undo_restores_overwritten_file`; sol `sync_prune_preserves_its_own_overwrite_backup` (2) | `prune_pass` (`ops.rs:1401-1448`) never excludes `state.backups`. ⚠ The fix depends on **D-7 (where sync backups live), still waiting on the user.** |
| **SC-05** 3-way treats an unreadable folder as empty, so its files are marked deleted | apply `three_way_unreadable_subfolder_is_not_classified_as_deleted`; xcheck_sol `sc05_connection_failure_is_not_automatic_deletion` (2) | `three_way.rs:183-185` uses `list(..).await.unwrap_or_default()` on all three sides. |
| **SC-06** prune and mirror follow a directory link inside the destination | xcheck_opus `sync_prune_does_not_trash_through_destination_directory_link`; sol `sync_does_not_write_through_destination_directory_symlink`; r3_sol `sc06_prune_nested_directory_link_preserves_external_directory` (3) | `mirror_dir` and `prune_pass` use `metadata` / `list().kind`, which follow links. The review traces the root cause to `fs/local.rs:387`. ⚠ **A clean fix may need `fs/local.rs` (off-limits).** A fix limited to ops.rs could try `symlink_metadata` (already on the trait; `ops.rs:2583` uses it). |
| **SC-07** merge ignores the compare rules (ignore globs) shown in the dialog | apply `merge_respects_ignore_globs_shown_in_compare_dialog`; xcheck_sol `sc07_nested_log_ignore_survives_merge` (2) | `ops.rs:1884` calls `compare_dirs(left, right)` with no rules. IPC `fs_merge_bidir(left, right, detect_renames)` (`commands/fs_ops.rs:1146`) has no `rules` parameter. FE `App.tsx:2352` sends none. → **Binding change needed: add a `rules: CompareRules` argument and regenerate `bindings.ts`.** |
| **SC-08** apply moves the destination to `.bak` before checking that the source still exists | apply `apply_compare_missing_source_must_not_displace_destination`; xcheck_sol `sc08_missing_reverse_nested_source_keeps_destination` (2) | `apply_one_relay` `ops.rs:2640-2653` renames dst to backup, then `copy_relay` at `:2675` fails with NotFound. Same-host has the same order (`ops.rs:~2825-2833`). |
| **SC-13** sync preview hides unreadable folders | sol `sync_preview_propagates_unreadable_source_subtree` (1) | `preview_copy_walk` `ops.rs:1735` and `preview_prune_walk` `:1771` use `list().unwrap_or_default()`. |
| **SC-10 / F-sol-09** rsync output parser (same-host sync) | xcheck_sol `sc10_rsync3_octally_escaped_korean_round_trips`; sol `rsync_leading_space_name_is_preserved`, `rsync_escaped_newline_name_is_decoded` (3) | `copy_progress.rs:111,132` use `line[11..].trim_start()` and `:143` `rest.trim()`: leading spaces are dropped and `\#ooo` escapes are not decoded. The file is unchanged since the original rsync commits. |

### Fixed by the fix round (paths U-04), but the tests are still `#[ignore]`d (static)

- sol `sync_rejects_destination_below_source`, `sync_rejects_source_below_destination` (SC-03 / F-sol-01): `sync_plan` now calls `path_guard::ensure_roots_unrelated` (`ops.rs:1181`). These should now pass, so the ignore can probably come off once a run confirms it.
- sol `sync_prune_never_moves_its_source_subtree`, `sync_nested_destination_does_not_recursively_create_itself`: the guard now works, but these tests call `sync_plan(nested).await.unwrap()`, which will panic in setup. The repros are obsolete: rewrite them to assert `Err`, or delete them, rather than un-ignoring.

### Environment-only checks (not product fixes)

- xcheck_sol `sc10_local_system_rsync_supports_progress2`, sol `rsync_actual_itemize_round_trips_special_names`: depend on the host's system rsync (macOS ships openrsync).
- r3_sol `sc47_escaped_checksum_names_produce_plain_digest`: macOS `/sbin/sha256sum` only.

### Outside sync scope (search / index / jumper / paths)

- sol `content_search_honors_metadata_filters` (SC-20), `filename_search_matches_canonically_equivalent_korean` and `index_matches_canonically_equivalent_korean` (SC-17 search; browse may have fixed these, stale-ignore candidates), `index_respects_hidden_exclusion` (SC-27), `index_cache_names_do_not_alias_different_roots` (SC-25) → **browse**
- sol `remote_shell_path_preserves_literal_posix_backslash` (F-sol-14 / SC-30): `shell_escape_path` (`copy_strategy.rs:70-80`) now keeps backslashes, so this is probably fixed by paths U-13 (stale ignore) → **remote/paths**
- Also outside: `core/search.rs:935` (F-sol-12) and `services/file_index.rs:928` (F-sol-06, browse); `services/frecency.rs:362,375` (jumper, browse)
- Related, owned by browse: `tests/review_browse_sc17_sensitive.rs:499,514` R3-S4-1. 3-way and compare-apply overwrite the other NFC/NFD form of a name. This is sync-adjacent (apply/3-way paths) and needs a coordination note.

## 3. FE repros (vitest)

| File | `it.fails` (expected-fail) tests | State |
|---|---|---|
| `src/lib/__review__/sync-compare-errors.test.ts` | "merge refused (comparison truncated)" should be scope guidance, not an I/O error; same-host sync with rsync missing should get the same plain sentence | **RAN: both still broken.** SC-15 relay sentence is **fixed** (now a plain test that passes, `error.ts:204` `syncCrossHost`) |
| `sync-compare-xcheck-progress.test.tsx` | SC-14: sync/merge progress shows a byte count instead of a file count | blocked (bindings) — static: still present |
| `sync-compare-compare-flow.test.tsx` | SC-11: local↔remote rows that differ by under a second land in overwrite by default; SC-38: lists over 200 have no "and N more" | blocked (bindings) — static: `fileActions.ts:289` tolerance defaults to 0 |
| `sync-compare-checksum.test.tsx` | SC-34: sha256sum-format paste, and a multi-line SHA256SUMS paste | blocked (bindings) |
| `sync-compare-diffpreview.test.tsx` | SC-33 / SC-23 / SC-46 | blocked (bindings) |
| `src/lib/__review__/sync-compare-r3-cancel.test.ts` | SC-43a/b compare start race | blocked (bindings) |

## 4. Sync user actions and entry points

| Action | Context menu | Toolbar | Command palette (`commands.ts`) | Default shortcut | IPC |
|---|---|---|---|---|---|
| Compare folders (active=left, other=right) | Empty-area menu only (`entryMenu.tsx:597`, `buildEmptyMenu`) | TopBar icon (`TopBar.tsx:131`) | `file.compare` | none (bindable) | `fs_compare_dirs` + `fs_compare_cancel` |
| Compare dialog → Re-compare (rules) / Verify (checksum) / Apply / Merge / diff preview | — | dialog footer (`CompareFooter.tsx`) | — | — | `fs_compare_dirs`, `fs_compare_verify`, `fs_apply_compare`, `fs_merge_bidir` (**no rules**), `fs_compare_pair_preview` |
| 3-way compare | **none** | **none** | `file.threeWay` (palette only) | none | `fs_compare_three_way`, `fs_apply_three_way` (Apply has no confirm step, SC-16) |
| Sync to other pane (mirror, optional prune) | Empty-area menu (`entryMenu.tsx:591`) | none (the toolbar `FolderSync` icon toggles synchronized browsing, not sync) | `file.sync` | none | `fs_sync_plan` → `SyncDialog` (`fs_sync_preview`) → `fs_sync_execute` |
| Synchronized browsing (nav mirror, not file sync) | PaneToolbar More menu | PaneToolbar button | `view.syncBrowse` | from keymap | none |
| Checksum (files) | Entry menu `checksum` (`entryMenu.tsx:431`) | — | — | — | `fs_checksum` |

UX gaps in entry points (static):
- Single-item, multi-select and mixed selections are **ignored**. Every action works on the two panes' current folders, never on the selection. Sync/compare do not appear in the entry (item) context menu at all.
- 3-way can only be reached from the palette.
- The sync and compare menu entries have no `commandId`, so the menu shows no shortcut hint even after the user binds one.

### Source combinations accepted (backend `decide_fs`)

| Action | local↔local | same-host SSH | local↔remote / cross-host (relay) | Archive-browse pane |
|---|---|---|---|---|
| Compare / verify | ✓ | ✓ (verify uses host-side sha256) | ✓ (verify uses byte compare, ≤64MB per file) | ✓ works on the extracted temp folder |
| Merge (add-only) | ✓ | ✓ host-side copy | ✓ relay | ✓ writes into the temp folder |
| Apply compare | ✓ | ✓ | ✓ relay | ✓ writes into the temp folder |
| 3-way | ✓ (base uses left's source, path typed into a prompt that defaults to the left path, SC-16) | ✓ same-host apply | ✓ relay | ✓ temp |
| **Sync** | ✓ | ✓ rsync | **✗ refused at `sync_plan`** (`ops.rs:1188-1196`). The menu entry is still enabled, and a toast suggests "compare → apply/merge" instead (SC-15 partly fixed) | ✓ temp |
| Nested roots (parent/child) | refused by `ensure_roots_unrelated` for sync plan/execute/preview, apply, and merge (U-04) | same | same | — |

Archive (static hypothesis, not tested): `buildEmptyMenu` gets no archive context, so sync/merge/apply can target an archive-browse pane. The changes land only in the temp extraction folder and are lost unless the user clicks "Update archive". For read-only formats (no repack: e.g. 7z) they are silently lost. Ownership should be coordinated with the archive module.

## 5. Notes for target selection

- Small, fully in sync scope, no policy questions: **SC-08** (check source before backup, in relay and same-host), **SC-05** (unreadable → Unreadable/conflict, excluded from apply), **SC-13** (pass preview read errors up, or return an "unreadable" list). SC-13 needs a `SyncPreview` field and therefore a binding change.
- **SC-07**: a small fix, but it changes the IPC signature (`fs_merge_bidir` + rules), so `bindings.ts` must be regenerated and that needs a cargo slot.
- **SC-01**: medium (journal partial progress on error/cancel, roll back the rename if the copy fails). Shares undo/journal contracts with fileops, so coordinate.
- **SC-02**: blocked on user decision D-7.
- **SC-06**: may need `fs/local.rs` (off-limits). Try a fix limited to ops.rs first.
- The 2 FE errors strings still in `it.fails` (merge truncated, same-host rsync missing): small `error.ts`/i18n fixes, possibly shared with the errors owner.
