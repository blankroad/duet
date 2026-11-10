# Fileops independent baseline — sol

Static + FE baseline complete; **Rust execution pending cargo slot**. Base `76b9b6e8b61608168b42a135a7a888422a3b1c60`, branch `ux-smoke/fileops-sol`. No product code changes. Report stays uncommitted in this worktree, per lead correction. fileops-36 excluded: shell ownership.

## cargo needed

**Request to lead: one build slot, jobs=2, own target directory. Do not infer permission to run from this list. No more Cargo commands will run before the lead grants the slot.** Earlier compilation ended with exit **130**, before any test executed, when interrupted for the machine-wide resource queue. This is an infrastructure stop, not a product failure.

Priority 1: covers 17 ignored repro tests for **08,09,10,13,15,17,18,26,27,34,35**, using only temporary files (21 excluded because it calls native OS trash):

```sh
CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/duet-fileops-sol-target cargo test --offline --manifest-path src-tauri/Cargo.toml --lib review_fileops -- --ignored --nocapture --skip undo_copy_after_file_replace_reports_ok_but_leaves_nothing > review-notes/rust-repros.log 2>&1
```

Expected diagnostic: existing desired-behavior assertions fail for still-present defects; **15 may pass** because independent backup restoration was repaired indirectly. The 08 tests explicitly self-skip on case-sensitive volumes; treat a skip as unverified. 34's shrink assertion prints a large byte array on failure, hence file redirection.

Priority 2: focused ordinary-assertion controls for **12**'s shell Skip behavior, the no-op healthy backup restore for 15, and repaired **07/22** subcases. Each needs the same granted slot, sequentially:

```sh
CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/duet-fileops-sol-target cargo test --offline --manifest-path src-tauri/Cargo.toml --lib core::sudo::review_fileops_sol_r2 -- --nocapture
CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/duet-fileops-sol-target cargo test --offline --manifest-path src-tauri/Cargo.toml --lib both_backups_restore_when_original_locations_are_free -- --nocapture
CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/duet-fileops-sol-target cargo test --offline --manifest-path src-tauri/Cargo.toml --lib macos_trash_undo_is_error_and_would_block_the_undo_stack -- --nocapture
CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/duet-fileops-sol-target cargo test --offline --manifest-path src-tauri/Cargo.toml --lib undo_move_partial_skip_must_not_half_apply_and_report_skipped -- --nocapture
```

07 is a synthetic unsupported-trash record and does not touch real trash; 22 performs tempdir renames only. Test names retain old symptoms but current assertions require repaired behavior. No new Rust tests needed for this baseline: existing focused repros cover the execution-sensitive subcases.

Fix-round reconciliation: persist fixed **01**; undo fixed **02,03,06,07,20,22,25**; paths fixed **04,05,19** and part of **33**; errors fixed the backup-location toast portion of **09**. Therefore review **08–18,21,23,24,26–35** (24 IDs), retaining partially fixed 09/33. 07/22 have pending focused regression commands because deletion/multi-move are common workflows. Fixed does not mean all policy limitations disappeared: 07 still cannot restore macOS trash, but is consumed as stale with Finder guidance rather than blocking undo.

Evidence in progress:

- Original dedicated Rust build: `CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/duet-fileops-sol-target cargo test --offline --manifest-path src-tauri/Cargo.toml --lib review_fileops_sol -- --ignored --nocapture`. Ended **130**, compilation interrupted for resource queue; **zero test results**. No shared target directory.
- Own frontend dependencies: `pnpm install --offline --frozen-lockfile` could not find cached `@crabnebula/tauri-plugin-drag-2.1.0.tgz`. No network request/escalation. `cp -cR /Users/ctmctm/Desktop/01_PROJECT/duet/node_modules/. node_modules/` successfully copied existing dependencies into this worktree; tests use this copy.
- Completed focused 6-file Vitest baseline: **6 files / 22 passed**, including five `it.fails` expected defects. Ordinary-assertion probe copies then yielded **5 failed / 6 passed**, confirming the precise behavior of 24 (2),16 (2),17 (1), not harness errors. These are **mocked FE tests**, not live app tests.
- 14 independently reproduced using local `/usr/bin/rsync -a -- <temp>/src/dir '<temp>/dst/dir (1)'`: exit 0; `dir (1)/a` absent, `dir (1)/dir/a` present even when final target did not exist. Generated command still passes source without a trailing slash. This is a local executable probe + static SSH command trace, not a real SSH test.
- Static confirmations so far: 11 elevated move calls `remove_path(src)`; 12 sudo local-to-remote success trashes every selected local source irrespective of skipped items; 16 cancel emits immediately and finalize emits again; 24 cut clipboard clears after planning returns; 28 worker JoinHandle unobserved and closed sender cached; 29 trash view commands are local-only; 30 put-back validates whole batch before restore; 31 replanned conflicts execute without another confirmation; 32 chmod journal push follows the whole loop.

## Current per-ID matrix (Rust results pending cargo slot)

Impact rank: **H** = common workflow blocked/confusing or recovery missing; **M** = conditional workflow/data-loss risk; **L** = uncommon/latent/policy cleanup. These are triage ranks, not replacements for the prior P1/P2/P3 labels.

| ID | Current status / evidence class | Current evidence / user impact | Rank |
| --- | --- | --- | --- |
| 08 | Still present (**static**; pending cargo slot) | Single rename rejects any successful destination metadata, including the same case-insensitive file; batch preview marks case-only result a collision. macOS temp-volume repro pending, NTFS not run. | H |
| 09 | **Changed, partly fixed** (**mocked FE test** + **static**; Rust pending cargo slot) | Backup path now appears in primary toast (2 ordinary assertions pass); failed directory copy/move rollback remains. UAC path still ignores rollback error. | H |
| 10 | Still present (**static**; pending cargo slot) | Elevated and sudo Replace permanently remove folder backup after success. | M |
| 11 | Still reproduces (**static**) | `move_one` calls `remove_path(src)` after copying; `remove_path` uses direct permanent deletion. No UAC/native Windows run. | M |
| 12 | Still reproduces (**static**; shell control pending cargo slot) | sudo script Skip returns success without copying; success count is all selected items; command then trashes all local sources, including skipped items. | M |
| 13 | Still present (**static**; pending cargo slot) | sudo KeepBoth always chooses suffixed target even when original target is free. | M |
| 14 | Still reproduces (**static**, local rsync probe) | rsync directory source with no trailing slash into new final KeepBoth name creates `dir (1)/dir/a`, not `dir (1)/a`; exit 0. Local macOS openrsync only; real SSH/GNU rsync unverified. | M |
| 15 | **Changed, partly fixed** (**static**; pending cargo slot) | No immediate same-host rollback remains; undo now iterates independent backups and safely skips occupied partial destinations instead of stopping at first folder. Existing repro will distinguish the repaired subcase. | H |
| 16 | Still reproduces (**mocked FE test** + static) | Ordinary-assertion probe fails: two cancellation toasts; cancellation followed by completion toast. Backend emits early Cancelled, exec_streaming has no token and holds session lock. | H |
| 17 | Still reproduces (**mocked FE test** + **static**; Rust pending cargo slot) | Copy-remaining warning still absent; unwrapped error test fails with raw trash-delete text. Cross-device failure data/journal repro pending. | H |
| 18 | Still present (**static**; pending cargo slot) | `?` on cancellation/write failure leaves deterministic `.duet-part`; no cleanup guard. | M |
| 21 | **Changed, unresolved D-6** (**static**) | New copy is now trashed rather than permanently removed on undo if unchanged. Old overwritten file still has no backup and destination becomes empty while result is Ok. Native OS trash repro deliberately not run (would write outside worktree); no changed policy inferred. | M |
| 23 | Still present (**static**, native behavior unverified) | Normal Tauri builder uses `.run(context)` without close-request task guard; queue is memory-only. Prior blanket claim that normal shutdown uses process::exit is inaccurate: current direct exit sites are elevated-child/startup-fatal branches. | H |
| 24 | Still reproduces (**mocked FE test**) | Both unwrapped assertions fail: expected clipboard mode `move`, received `undefined`; controls confirm no move was executed when confirmation merely opened. Cut clipboard clears after both dialog-only planning and plan error. | H |
| 26 | Still present (**static**; pending cargo slot) | Deterministic `<name>.duet-part` is not in plan conflicts and is opened/truncated by a fresh copy. | L |
| 27 | Still present (**static**; pending cargo slot) | Batch rollback ignores secondary rename failure and returns original error before journal push. | M |
| 28 | Still present (**static**, panic behavior not run) | Worker task JoinHandle discarded; sender remains cached, send error ignored. Release profile panic=abort. | L |
| 29 | Still present (**static**) | Trash commands/virtual view accept only local OS trash, no remote empty/list API. | L |
| 30 | Still present (**static**, native Windows/Linux not run) | `trash_view_put_back` rejects entire selected batch if any original path exists before restore_all; error remains raw `restore target exists`. | M |
| 31 | Still present (**static**) | `onTransferPerFile` replans policy groups, then executes without checking returned conflicts again. | M |
| 32 | Still present (**static**) | `set_permissions` applies in loop with `?`; journal pushed only after loop, so failure after first success loses partial undo record. | M |
| 33 | **Changed, partly fixed** (**static**) | shell_escape_path now preserves literal backslashes (paths fix); direct trash call remains. Staging cleanup is now explicitly authorized by CLAUDE.md §3, so blanket rule-violation claim no longer applies; missing safe-root check still needs follow-up. | L |
| 34 | Still present (**static**; pending cargo slot) | Resume trusts only old part length without source identity/mtime/hash validation. Current end-to-end retry reachability remains limited. | L |
| 35 | Still present (**static**; pending cargo slot) | Directory relay always mkdirs destination, so retry of partially created directory fails. | L |

The static baseline finds **20 still-present issues and 4 changed/partly fixed issues (09,15,21,33)** in the 24-ID scope. No scoped issue is claimed fully fixed. A static finding is not an executed reproduction. In particular, 15's independent-second-backup subcase looks repaired in source but is awaiting its focused Rust assertion.

## Exact commands and results

All commands ran from `/private/tmp/duet-ux-smoke-worktrees/fileops-sol`. The following static command covers **every row**, with an explicit `fileops-NN` section, source line numbers, and the source statements supporting its result:

```sh
python3 review-notes/static-evidence.py > review-notes/static-evidence.txt
```

**Result: exit 0**, 24 per-ID source excerpts; see `static-evidence.txt`. This is labeled **static** throughout: it reads code and performs no product operations.

For **09,16,17,24** and already-fixed **04/20/stale History UI**, the executed focused **mocked FE test** command was:

```sh
node node_modules/vitest/vitest.mjs run --minWorkers=1 --maxWorkers=2 src/lib/__review__/fileops-opus-clippaste.test.ts src/hooks/__review__/fileops-opus-taskcancel.test.ts src/lib/__review__/fileops-opus-r2-explain.test.ts src/components/__review__/fileops-opus-history-order.test.tsx src/components/__review__/fileops-sol-r2-history.test.tsx src/lib/__review__/fileops-sol-descendant.test.ts
```

**Result: exit 0, 6 files / 22 passed**, 33.24s. Breakdown: clippaste 3, taskcancel 2, explain 6, history-order 2, sol-r2-history 6, descendant 3. Five are `it.fails` expected-defect assertions (24×2,16×2,17×1); these passes do **not** mean those bugs are fixed. 09's two backup-path assertions are ordinary passing tests, confirming the fix. The two history files and descendant file pass ordinary assertions.

To establish why the expected-failure tests fail, copied the existing three relevant files into `review-notes/probes/`, changing only `it.fails(` → `it(` and making the task hook's relative import `@/hooks/useTaskEvents`, then ran:

```sh
node node_modules/vitest/vitest.mjs run --minWorkers=1 --maxWorkers=2 review-notes/probes
```

**Result: exit 1, 3 files, 5 failed / 6 passed**, 78.98s. Exact failed assertions:

| IDs | Actual result | Desired assertion |
| --- | --- | --- |
| 24×2 | clipboard `entry?.mode` is `undefined`, no move executed in dialog-only case | clipboard mode remains `move` |
| 16 | `["Cancelled: Moving 40 item(s) to trash", "Task cancelled"]` | one cancellation toast |
| 16 | `["Cancelled: Moving 40 item(s) to trash", "Task completed"]` | not both cancellation and completion |
| 17 | `입출력 오류 — 1 item(s) failed — a: io: trash delete: …` | mention copy remains / source retained |

The probes and controls complete with normal imports/mocks; failures are the target behavioral assertions, not setup failures. Backend IPC/events and OS platform are mocked; no live task, UAC, OS clipboard, trash, or SSH operation occurred.

For **14**, exact local executable probe (evidence class **static + local command probe**, not Rust/SSH):

```sh
python3 -c 'import pathlib,subprocess,tempfile; t=tempfile.TemporaryDirectory(dir="review-notes"); p=pathlib.Path(t.name); s=p/"src"/"dir"; s.mkdir(parents=True); (s/"a").write_text("safe"); d=p/"dst"/"dir (1)"; d.parent.mkdir(); r=subprocess.run(["/usr/bin/rsync","-a","--",str(s),str(d)],capture_output=True,text=True); print("rsync exit:",r.returncode,"direct:",(d/"a").exists(),"nested:",(d/"dir"/"a").exists(),"stderr:",r.stderr); d2=p/"existing"; d2.mkdir(); r2=subprocess.run(["/usr/bin/rsync","-a","--",str(s),str(d2)],capture_output=True,text=True); print("existing-target control exit:",r2.returncode,"nested:",(d2/"dir"/"a").exists())'
```

**Result: exit 0**; `rsync exit: 0 direct: False nested: True stderr:`; `existing-target control exit: 0 nested: True`. Generated same-host command at `ops.rs:4123–4137` still uses the same source/destination argument shape. This machine's openrsync cannot stand in for a live GNU rsync server or verify the progress options; those remain unverified.

## Setup limits and handoff

- All **Rust test** entries remain **not run / pending cargo slot**. Original interrupted compilation produced no test result; exit 130 is not a defect. Exact requested commands are in `cargo needed` above. Existing ignored tests inspected: 18 total, of which 21 intentionally excluded leaves 17 in priority 1.
- FE prerequisites are copied into this worktree, not shared mutable builds. `cp /Users/ctmctm/Desktop/01_PROJECT/duet/src/types/bindings.ts src/types/bindings.ts` supplied the ignored generated import target; tested IPC/events are fully mocked. No bindings regeneration, schema changes, `pnpm build`, or dependency additions. Initial Node-only run lacked that generated file: 5 suites failed import resolution, 1 file/6 tests passed; discarded as setup failures and rerun successfully above.
- `pnpm exec vitest ...` attempted pnpm's dependency-status repair and stopped with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`; using the worktree's existing `node .../vitest.mjs` avoided installation/network. Offline install had earlier failed with `ERR_PNPM_NO_OFFLINE_TARBALL`; no network retry performed.
- Native app close-under-load (23), Windows/UAC, Windows/Linux trash put-back (30), real SSH/sudo, and GNU rsync are **not run**. 21's native-trash test deliberately not run because it writes outside the worktree; static trace records its narrowed failure and existing D-6 decision.
- No product code or tracked test changed, no commits. `git diff --exit-code` passes; `git status --short` shows only `?? review-notes/`. Main checkout's uncommitted `src-tauri/src/fs/local.rs` was not touched. All source excerpts of local.rs are from this isolated base worktree.
- Highest-value implementation candidates from this baseline: **24** cut/paste lifecycle, **16** running cancel/final events, **08** case-only rename, **09/17** failure recovery, **27/32** partial-operation journaling. Scope/policy decisions for 21 remain with the lead/main.
