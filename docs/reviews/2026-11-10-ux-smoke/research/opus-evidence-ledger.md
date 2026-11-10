# Evidence ledger (research-opus, TASK C)

Purpose: for every finding or fix a team claims this round, record:
- the canonical ID (from `research/REGISTRY.md`, or a proposed new `UX-<MOD>-NN`)
- what evidence backs the claim, and whether it cites an exact command and result
- the commit, if any
- the independent reviewer verdict, if any
- the gaps

Read-only survey of the module report folders and the team worktrees under `/tmp/duet-ux-smoke-worktrees/*`
(`git log 76b9b6e..HEAD`, `git status`, `git diff 76b9b6e`). **I ran no cargo, no vitest, no builds.**

Evidence vocabulary (same as the registry):
- `TESTED-FE-MOCK`: Vitest with mocked IPC; the claim cites the exact command and its result.
- `TESTED-CARGO`: Rust test run; the claim cites the exact command and its result.
- `TESTED-PROBE`: a local executable probe, e.g. a real rsync run on temp dirs.
- `FE-MOCK (uncited)`: a test exists, but no command/result is recorded for it.
- `STATIC`: code reading only.
- `PENDING-CARGO`: a Rust test was written but not run, because of the freeze.
- **No LIVE-app, Windows-device or real-SSH evidence exists anywhere yet.**

---

## Pass 1 — 2026-11-10 21:50–22:05 KST

### P1.0 Cross-team file overlap check (FLAG candidates)

**No same-hunk conflict. No edit to `src-tauri/src/fs/local.rs` on any branch (committed or WIP).**
Hunk ranges below are base line numbers from `git diff -U0 76b9b6e`.

| File | Branches touching it | Hunks (base lines) | Verdict |
| --- | --- | --- | --- |
| `src/App.tsx` | archive (lead, WIP) | 313, 332, 482 (`navigateTo` `focusName`, archive exit) | separate hunks. **WATCH**: shell will edit 758-830 and archive Addendum A wires builtin deps |
| | remote (lead, WIP) | 899 (`useConnectionEvents(onRefresh)`) | |
| `src/stores/panes.ts` | archive (lead, WIP) | 3, 32, 56, 548, 602, 967 (`setArchiveContext`) | **WATCH — close**: browse-opus `setFilter` ends at 950 and archive's `setArchiveContext` hunk starts at 964. About 13 unchanged lines between them, so git should merge cleanly, but integrate in sequence and re-run `panes*.test.ts` |
| | browse-opus (commit `6bf87a3`) | 943-955 (`setFilter`) | |
| `src-tauri/src/core/search.rs` | browse (lead, WIP) | 283, 304 (`LocalContentSearch`, SC-20) | separate (agreed split: browse = local content body, remote = remote find) |
| | remote (lead, WIP) | 431, 453-483, 510, 522, 933-950 (remote find) | |
| `src/lib/commands.ts` | shell (lead, WIP) | 708 (`file.edit` F4, UX-SHL-07) | **WATCH — upcoming**: archive Addendum A will insert `file.extract`/`file.compress` after `file.calcSize` (base ~676) and edit `commands.*.test.ts`. Shell also edits `commands.win.test.ts` → likely conflict in that test file and in `src/i18n/{ko,en}.json` (shell edits ko.json ~1266; archive adds `cmd.file.extract`/`compress`). Agree insertion points before archive starts |
| `src-tauri/src/commands/system.rs` | shell lead (871-877, OS clipboard) + shell-opus (684-743, shell_menu IPC) | | same team, separate hunks |
| `src-tauri/src/platform/mod.rs` | shell lead (30) + shell-opus (20) | | same team, adjacent; lead cherry-picks |
| `src-tauri/src/lib.rs` | archive-opus (146, new `fs_extract_plan_batch`) | | only branch so far. Shell's `shell_menu_open` signature change does not touch `lib.rs`. **Both change IPC → bindings regen by main after integration** |
| browse-owned review tests `browse-opus2-app.test.tsx`, `browse-sol3-app.test.tsx` | archive (lead, WIP) | marker flips for browse-32/34 | OK: browse routed 32/34 to archive. **Tell browse-opus not to touch these** |
| `src/stores/session.ts` | archive (lead, WIP) | 37 | browse owns session. Archive lead is persisting archive context; notify browse |

### P1.1 Claims by team

Abbreviations: Rev = independent sol reviewer verdict on the fix. "none yet" = review phase not started.

#### archive

| Claim | Canonical ID | Evidence claimed | Cmd + result cited? | Commit | Rev | Gaps |
| --- | --- | --- | --- | --- | --- | --- |
| Multi-select: menu hides extract; `triggerExtract` toasts `extractSelectOne`, no IPC (archive-sol) | UX-ARC-01 | FE-MOCK | **yes**: `pnpm exec vitest run src/lib/__review__/ux-smoke-archive-sol.test.ts` → exit 0, 2 passed (locks current behaviour) | none (untracked) | n/a (baseline) | test is uncommitted; asserts current behaviour, so it must be **inverted** with the R1 fix |
| Label "Extract here" vs output `<stem>/` (archive-sol) | UX-ARC-02 | FE-MOCK (label) + Rust (behaviour) | FE yes; **Rust PENDING-CARGO** (`CARGO_BUILD_JOBS=2 cargo test --test ux_smoke_archive_sol`, interrupted 130) | none | n/a | behaviour half is unexecuted |
| Existing `<stem>/` silently moved to `.bak`; undo restores (archive-sol) | UX-ARC-03 = archive-21 | Rust | PENDING-CARGO | none | n/a | UI "no dialog" part is STATIC |
| `a.zip` + `a.tar.gz` both plan `a/` → second replaces first (first survives only in `.bak`) (archive-sol) | UX-ARC-01 (spec §4b) | Rust (core-driven; UI blocks this today) | PENDING-CARGO | none | n/a | new sub-case; **must be a regression test for the batch plan** |
| SSH 7z/rar/gz rejected `NotSupported` before network (archive-sol) | UX-ARC-01 (spec §3) | Rust, synthetic remote | PENDING-CARGO | none | n/a | no live SSH |
| **WIP fix**: batch extract planner `core/archive_batch.rs` + tests, `fs_extract_plan_batch` IPC (archive-opus) | UX-ARC-01 | — | no | none (uncommitted) | none | IPC change → bindings; `archive_batch_tests.rs` not yet run (freeze) |
| **WIP fix**: archive context stack/trail, exit cursor on the archive file (archive lead) | G-07: archive-15, browse-32, browse-34 (+ UX-ARC-06/07 related) | FE-MOCK repro flips in 3 review tests | no | none (uncommitted) | none | edits browse-owned `session.ts` and review tests (coordinated per browse STATUS). No run recorded yet |

#### shell

| Claim | Canonical ID | Evidence claimed | Cmd + result cited? | Commit | Rev | Gaps |
| --- | --- | --- | --- | --- | --- | --- |
| F4 / `file.edit` unregistered (shell-sol, **labelled "UX-SHL-01" in SHELL-SOL-A.md**) | **UX-SHL-07** (ID clash: sol's local label ≠ registry UX-SHL-01) | FE-MOCK | **yes**: `vitest run ... ux-shell-sol-a.test.ts -t UX-SHL` with it.fails removed → exit 1, 2 intended failures | none (untracked) | n/a | **rename sol labels to registry IDs** |
| **WIP fix**: register `file.edit` F4 (shell lead) | UX-SHL-07 | — | no | none (uncommitted) | none | F4 default key: check the keymap conflict test (`commands.*.test.ts`) |
| Multi-select hides external Open/reveal/terminal (shell-sol "UX-SHL-02") | **propose UX-SHL-09** (multi-file Open). Not registry UX-SHL-02 (= background More) | FE-MOCK | yes (same run) | none | n/a | feature gap, backlog per sol |
| macOS `open -a <missing app>` returns Ok silently (shell-sol "UX-SHL-03") | **propose UX-SHL-10**. Not registry UX-SHL-03 (= invoke silent) | STATIC + ignored Rust repro | **PENDING-CARGO** (`cargo test --test ux_shell_sol_a -- --include-ignored`) | none | n/a | native symptom unverified |
| fileops-36 stale OS clipboard still present (shell-sol) | UX-SHL-04 = fileops-36 | STATIC (FE tests prove the in-app clipboard only) | partial | none | n/a | OS clipboard contents not proven. Fix is shell-lead WIP (`macos.rs`, `file_clipboard.rs`, `system.rs:871`) with an ignored macOS pasteboard test → PENDING-CARGO (queue #2) |
| S-02 / ss-10, S-03 / ss-16 unchanged (shell-sol) | UX-SHL-02, UX-SHL-03 | STATIC | n/a | none | n/a | Windows unverified |
| **WIP fix**: multi-path `shell_menu_open(paths: Vec<PathBuf>)`, `shell_menu_core.rs` (shell-opus) | UX-SHL-01 | — (shell-opus `shell_menu_core` cargo job was main-allowed) | no result recorded yet | none (uncommitted) | none | **Windows runtime cannot be verified here**; mingw cross-clippy = compile only. IPC contract change pending main ack (shell STATUS) |
| Keymap conflict/replace/reset UI, open-with save rollback OK (shell-sol) | — (positive baseline) | FE-MOCK | yes (6 files / 22 passed) | none | n/a | — |

#### fileops

| Claim | Canonical ID | Evidence claimed | Cmd + result cited? | Commit | Rev | Gaps |
| --- | --- | --- | --- | --- | --- | --- |
| 24 prior IDs re-checked: 20 still present, 4 partly fixed (09, 15, 21, 33) (fileops-sol) | fileops-08..35 | STATIC (`static-evidence.py`, exit 0, per-ID excerpts) | yes for the static script | none | n/a | Rust repros for 08, 09, 10, 13, 15, 17, 18, 26, 27, 34, 35 = **PENDING-CARGO** (priority-1 command recorded) |
| fileops-16 (cancel → two toasts / cancel+complete), fileops-24 (cut clipboard cleared), fileops-17 (raw trash error) | fileops-16, -24, -17 | FE-MOCK, with ordinary-assertion probes | **yes**: probes → exit 1, 5 failed / 6 passed at the intended assertions | none | n/a | mocked task events; not a live queue |
| fileops-09 backup path in toast fixed | fileops-09 (PARTIAL) | FE-MOCK ordinary assertions pass | yes | (fix-round `655db94`) | n/a | rollback still missing |
| fileops-14 KeepBoth nests `dir (1)/dir/a` | fileops-14 | TESTED-PROBE (`/usr/bin/rsync` on temp dirs → nested: True) | yes | none | n/a | openrsync only; GNU rsync / real SSH unverified |
| Prior claim "app exit uses process::exit" corrected | fileops-23 | STATIC | n/a | none | n/a | report correction, not a fix |
| fileops-opus inventory + smoke | — | — | **not yet reported** (`ux_smoke_fileops_opus.rs`, `src/lib/__smoke__/` untracked; `fileops/opus-inventory.md` absent) | none | n/a | pending |

#### browse

| Claim | Canonical ID | Evidence claimed | Cmd + result cited? | Commit | Rev | Gaps |
| --- | --- | --- | --- | --- | --- | --- |
| **FIX**: `setFilter` drops filter-hidden names from the selection (browse-opus) | UX-BRW-02 = browse-03 (G-22) | FE-MOCK; it.fails→it in `browse-panes.test.ts:81` and `browse-sol2-state.test.tsx` ×5; new positive test in `panes.test.ts` | **yes**: 8 files / 137 passed; tsc 0, eslint 0, prettier clean (browse-opus-r1.md) | **`6bf87a3`** (browse-opus) | **none yet** | (1) Pruning is permanent: clearing the filter does not restore the selection. This is a documented trade-off; product should ack. (2) SC-07/SC-35 (compare-view hidden rows) are **not** covered by this fix; G-22 is only partly closed. (3) Not live |
| **WIP**: markdown preview link (browse-opus) | browse-08 | — | no | none | none | — |
| **WIP**: SC-20 local content filters, file_index changes, search command (browse lead) | SC-20 (+ likely SC-25/27/19 guard) | — | no | none | none | `review_sync_compare_sol.rs` edited (sync-owned test file); PENDING-CARGO (queue #1) |
| s01 stale search result clickable while a new query is pending | **propose UX-BRW-05** | FE-MOCK it.fails | per-test commands listed; final run "pending" | none | n/a | final verification run not recorded |
| s02 closing a content search doesn't call `search_cancel` | **propose UX-BRW-06** | FE-MOCK | same | none | n/a | remote exec persistence unverified |
| s03 reindex failure ignored; s12 ↓/Enter opens the first result | SC-42 (prior) | FE-MOCK | same | none | n/a | dup of prior SC-42 |
| s04 jumper Enter opens the previous query's hit | **propose UX-BRW-07** | FE-MOCK | same | none | n/a | — |
| s05 StrictMode double global index build | SC-19 (partial) | FE-MOCK | same | none | n/a | dev-only trigger; backend guard STATIC |
| s06/s07 swap panes / move tab during a pending listing loses the destination | **propose UX-BRW-08** | FE-MOCK (held listing) | same | none | n/a | — |
| s08 index cache name collision; s09 hidden exclusion ignored; s13 multiword jumper; s14/s15 glob FE/BE mismatch | SC-25, SC-27, SC-48, SC-49 | "isolated Rust" via Vitest + `rustc --test` on extracted code | same | none | n/a | **not cargo**: extracted declarations with stubs. Treat as STATIC+ (unit-ish) |
| s10 remote newline names split | SC-29 = remote-25 (G-23) | isolated Rust | same | none | n/a | **dup across browse/remote**; remote owns the fix (remote lead WIP in `core/search.rs`) |
| s11 Ctrl+D on a bookmarked SSH folder adds instead of toggling | **propose UX-BRW-09** (near UX-BRW-01, not same) | FE-MOCK App | same | none | n/a | — |

#### remote

| Claim | Canonical ID | Evidence claimed | Cmd + result cited? | Commit | Rev | Gaps |
| --- | --- | --- | --- | --- | --- | --- |
| **FIX**: split ad-hoc alias user/host at the last `@` (remote lead) | remote-30 | FE-MOCK; it.fails→it ×2 in `remote-lead-host-alias.test.ts` | **no run result cited** (STATUS says "Commits: none yet") | **`7ba7bcc`** (remote) | **none yet** | needs a recorded `vitest run` result + sol review |
| **WIP**: refresh pane after auto-reconnect (`useConnectionEvents(onRefresh)` + new test) | remote-27 | — | no | none | none | — |
| **WIP**: `core/search.rs` remote find (hidden root, newline) | remote-11, remote-25 = SC-29 | — | no | none | none | PENDING-CARGO |
| **WIP**: `core/sudo.rs` | remote-12 (sudo staging parent) | — | no | none | none | real sudo server unverified |
| NEW-1: ad-hoc connect silently ignores host/password save failures | **propose UX-REM-03** | FE-MOCK it.fails | **yes**: markers removed → 6/6 intended failures; 13 files / 64 passed with markers | none (**git add blocked by sandbox**: index.lock in main .git) | n/a | tests untracked; lead must copy them in |
| NEW-2: no Disconnect for healthy saved/ad-hoc sessions | **propose UX-REM-04** | FE-MOCK | yes (as above) | none | n/a | 09-05 SS-02 only added config-host disconnect |
| NEW-3: aliases `constructor`/`toString`/`__proto__` stuck "reconnecting" | **propose UX-REM-05** | FE-MOCK | yes | none | n/a | edge case (P2 per sol; consider P3) |
| remote-04 / remote-10 still reproduce | UX-REM-01 = remote-04; remote-10 | FE-MOCK it.fails | yes (in the 64-run) | none | n/a | G-11 out of scope this round |
| remote-opus docker smoke baseline, G-10, remote-03 | remote-05/06/07, remote-03 | — | **nothing reported yet** | none | n/a | Docker started by lead; no IT result recorded |

#### sync

| Claim | Canonical ID | Evidence claimed | Cmd + result cited? | Commit | Rev | Gaps |
| --- | --- | --- | --- | --- | --- | --- |
| FE baseline mostly blocked: 9 suites failed import (`bindings.ts` missing) | — | setup failure | yes (exit 1; 9 failed / 1 passed) | none | n/a | **re-run needed with copied bindings** (other teams copied main's `bindings.ts` read-only). Until then the SC-11/14/23/33/34/38/43/46/48 markers are unverified at base |
| SC-11, SC-12, SC-14, SC-16, SC-35 still present | SC-11/12/14/16/35 | STATIC | n/a | none | n/a | SC-16 nuance: the destructive default is now **blocked** by `path_guard` (Apply always fails). The UX dead-end remains |
| SC-15 wording fixed; Sync still offered for local↔SSH | UX-SYN-01 = SC-15 | FE-MOCK (formatter) + STATIC | partial | none | n/a | D-8 |
| FE-01: Merge discards ignore rules | **= SC-07** (dup; sync lead's own static note ops.rs:1886) | STATIC | n/a | none | n/a | **duplicate of prior SC-07**, do not register new |
| FE-02: Compare offers actions for nested roots that always fail | **propose UX-SYN-02** | STATIC | n/a | none | n/a | — |
| FE-03: read-only archive browse still accepts compare mutations | **= UX-ARC-07 family** (G-07) | STATIC | n/a | none | n/a | **cross-team dup** (research-sol ARC-003 → UX-ARC-07). Route to archive with a sync note |
| sync-opus Rust smoke of the ignored SC repros | SC-01/05/06/07/08/10 | — | job stopped (freeze) | none | n/a | PENDING-CARGO (queue #3) |

### P1.2 Duplicates and ID hygiene found this pass

- **ID label clash:** shell-sol's `UX-SHL-01/02/03` (SHELL-SOL-A.md) are local labels.
  - Registry mapping: sol-01 → UX-SHL-07; sol-02 → new UX-SHL-09; sol-03 → new UX-SHL-10.
  - Ask shell to use the registry IDs in commits and reports.
- sync FE-01 = prior **SC-07**. sync FE-03 ≈ **UX-ARC-07** (archive). browse-s10 = **SC-29 = remote-25**.
  browse-s03/s12 = **SC-42**. browse-s05 ⊂ **SC-19**. browse-s08 = **SC-25**. browse-s09 = **SC-27**.
  browse-s13 ⊂ **SC-48**. browse-s14/15 ⊂ **SC-49**.
- remote-sol NEW-2 (no disconnect for saved/ad-hoc) extends 09-05 SS-02 (that fix covered config hosts only).
- browse-opus `6bf87a3` closes browse-03 only. **G-22 remains open for SC-07 and SC-35** (sync).

### P1.3 Summary (pass 1)

- Commits since base across all 18 team worktrees: **2**. Both are FE-MOCK fixes with test flips:
  - browse-opus `6bf87a3`: browse-03. Run result cited.
  - remote `7ba7bcc`: remote-30. No run result cited.
  - **Neither has an independent sol review verdict yet.**
- Everything Rust-side is **PENDING-CARGO**: archive-sol, shell-sol, fileops-sol, browse lead, sync-opus, remote-sol.
- No LIVE, Windows-device or real-SSH evidence yet.
- Uncommitted WIP fixes in progress:
  - UX-ARC-01 (archive-opus)
  - G-07 (archive lead)
  - UX-SHL-01 (shell-opus)
  - UX-SHL-04 and UX-SHL-07 (shell lead)
  - browse-08 (browse-opus)
  - SC-20 (browse lead)
  - remote-27/11/25/12 (remote lead)
- Setup risk: generated `bindings.ts` is missing in fresh worktrees. Sync's FE baseline is still blocked on it; others
  copied main's read-only.
- Process risk: remote-sol cannot `git add` (sandbox blocks the shared `.git/worktrees/*/index.lock`). Test files must be
  copied by the lead; the same is likely for other Codex workers. fileops-sol and shell-sol also left files untracked.

---

## Pass 2 — 2026-11-10 22:05–22:15 KST (delta)

### P2.0 Main integrations since base (`git log 76b9b6e..main`)

| main | source | IDs | Reviewer verdict | Evidence |
| --- | --- | --- | --- | --- |
| `88f7d99`, `e94719d`, `c6aaa3d` | shell `4f80d38`, `bd92c6b`, `d6dba8b` (L1) | UX-SHL-07 (F4 `file.edit`), UX-SHL-11 (DESIGN alt keys F8/Shift+F8/Ctrl+Shift+N/Shift+F6), UX-SHL-12 (mac Cmd+Backspace → trash) | shell-sol **APPROVE** (R1: `4f80d38` CHANGES for tsc TS2352 → R2 APPROVE with `d6dba8b`) — `shell/review-L1-sol.md` | TESTED-FE-MOCK: sol `vitest ... commands.win/mac, keymap, ux-shell-*` 5 files/27 passed; `tsc --noEmit` exit 0 (R2). Negative control: F4 test fails without the fix. mac F-key hardware unverified |
| `8fa018a`, `cc0bd8f` | archive `ddf352f`, `eb183e0` | G-07: archive-15, browse-32, browse-34, UX-ARC-08 | archive-sol **APPROVE R2** (R1 CHANGES: 2×P2 + 2 robustness) — `archive/sol-review-g07-R{1,2}.md` | TESTED-FE-MOCK: sol `vitest ... archive-context-g07-sol, archive-context` 9/9 exit 0. Lead: App tests 18/18, tsc 0, eslint 0 (**lead-provided only, not re-run by sol in R2**) |
| `513f16d` | remote `7ba7bcc` | remote-30 | remote-sol APPROVE R1 (per remote STATUS) | FE-MOCK. **No sol review file in `remote/` yet**; verdict is from STATUS only |
| `6cd9f11` | remote `bb2fe92` | remote-27 (reload panes after reconnect) | remote-sol APPROVE R1 (STATUS) | FE-MOCK (`useConnectionEvents.test.tsx`); same gap: no review report file |
| `670bf88`, `62a9702` | remote `33b9199`, `1cbebca` | test repros for UX-REM-03/04/05 | APPROVE (STATUS) | test-only |

- **ID hygiene:** main `e94719d` and two test titles say "fileops-03/04". These are fileops-opus smoke labels (`ux-fileops-03/04`), **not** the 11-08 `fileops-03/04`, and the canonical IDs are UX-SHL-11/12. Shell will rename the test titles. History is not rewritten.
- **Integration TODO noted by shell:** flip the 5 `ux-fileops-03/04` `it.fails` in `src/lib/__smoke__/fileops-opus-ux.test.ts` (fileops-opus `6371b88`) to `it` when fileops lands.

### P2.1 FLAG raised this pass, and its resolution

- **FLAG (raised in the terminal): `src-tauri/src/core/three_way.rs` same hunk (base 180-188 `walk()`).**
  - remote-opus WIP swaps `list` for `list_for_walk` (remote-03).
  - sync-opus WIP adds SC-05 NotFound-vs-error handling with `Unreadable` rows.
  - **Already coordinated** (sync STATUS): "keep both: `list_for_walk` + SC-05 error handling". The integrator must hand-merge this; it will not merge automatically.
- remote-opus remote-03 WIP is a **cross-module trait change**: new `FileSystem::list_for_walk` in `fs/mod.rs` and `SshFs`, used in:
  - `core/compare.rs` (sync)
  - `core/three_way.rs` (sync)
  - `core/ops.rs` (fileops/sync; hunks 1476-4201, **no overlap** with sync-opus 2591-2994)
  - `core/archive.rs` (archive, 555-560; no overlap with archive-opus)
  - `core/search.rs`, `commands/search.rs`
  - Sync lead approved it "with conditions" (pure token swap, link-leaf tests, walker audit).
  - **Still needs a main ack as a contract change** and cargo evidence.
- Near-adjacent, low risk: `src/stores/ui-dialogs.ts`. archive-opus adds `extract-conflict` at base ~37; fileops-opus changes `move-confirm` at 34.
- Other cross-team same-file pairs: separate hunks, integrate sequentially.
  - `App.tsx`: browse 126 / browse-opus 131 / remote 136 are import lines 4-5 apart. Watch.
  - `i18n/ko.json`: fileops-opus 828, sync-opus 835, archive-opus 846-847 in the `toast` block.
  - `fileActions.ts`: fileops-opus 24 vs sync-opus 30 (imports); fileops-opus 267-269 vs sync-opus 284.
  - `panes.ts`: archive (now on main) 967-970 vs browse-opus 946-950 and 980.
- `src-tauri/src/fs/local.rs`: **still untouched by every branch.**
- §3 rule check on archive-opus `archive_here.rs` (new staging dir `<archive_dir>/.duet-extract-<uuid>`):
  cleanup uses the existing `FileSystem::remove_empty_dir` (empty dirs only) and falls back to `fs.trash`.
  No recursive delete, so the "app temp dir" exception list is **not** needed. Verified static.

### P2.2 New and updated claims

| Team / commit | IDs | Evidence | Cmd + result cited? | Rev | Gaps |
| --- | --- | --- | --- | --- | --- |
| archive-opus `9b661ac` true extract-here engine (`archive_here.rs` 412 + tests 573, `archive_names.rs`) | UX-ARC-01 (SPEC-R1b: **true "Extract here" is now primary** per main correction; each-to-folder secondary) | Rust unit tests written | **PENDING-CARGO**, not run | none | big BE engine (staging, merge into existing dirs, KeepBoth race safety) with zero executed tests so far. Remote extract-here hidden (limit) |
| archive-opus `eba92c6` batch extract-each plan | UX-ARC-01, UX-ARC-03 | Rust tests (460 lines) | PENDING-CARGO | none | WIP FE (`extractActions.ts`, `ExtractConflictDialog.tsx`, password FIFO) uncommitted. IPC change → bindings |
| shell L1-tests `84a1c41`, `47dd1b9` | UX-SHL-07/09/10 repros | FE 5 files/27 passed (lead); Rust `ux_shell_sol_a` not compiled | partial | — | blocked on cargo `--no-run` |
| shell lead WIP (`macos.rs`, `file_clipboard.rs`, `system.rs:871`) | UX-SHL-04 = fileops-36 | — | no | none | PENDING-CARGO |
| shell-opus WIP multi-path shell menu | UX-SHL-01 | — | no | none | Windows unverifiable here; IPC contract waiting on main ack |
| fileops-opus `86dddea` keep cut clipboard until the move is accepted | fileops-24 (F1) | TESTED-FE-MOCK (sol: 2 files/18 passed) | yes | **CHANGES (A1-R1)**: R1-01 P2 global Skip consumes skipped entries; R1-02 P2 double Ctrl+V submits the same cut twice. Both **static** traces | fix in round 2 |
| fileops-opus `e300302` Recycle Bin guards + empty-Delete toast | UX-FOP-01, UX-FOP-02 (F2) | FE-MOCK (`__smoke__/fileops-fop0{1,2}-*.test.*`) | not cited yet | none | — |
| fileops-opus `756c9fe` same-folder move refused, same-folder copy → Keep both | **propose UX-FOP-03** (inventory F3; no prior ID) | FE-MOCK (`fileops-opus-self-copy.test.tsx`) | not cited | none | the BE "Replace onto itself no-op" part of the F3 plan is not in this commit (FE only) |
| fileops-opus `6371b88` FE smoke tests | inventory (34 checks, 14 confirmed) | FE-MOCK | per opus-inventory | n/a | Rust smoke `ux_smoke_fileops_opus.rs` untracked, PENDING-CARGO |
| browse lead `ccfc5db` SC-20, `0fba4eb` SC-18/27/25 | SC-20, SC-18, SC-27, SC-25 | Rust | **UNTESTED** (lead says so; cargo queue #1). `f66dd0e`: isolated rustc probe s08/s09 pass | partial (probe only) | `0fba4eb` **removes 5 `#[ignore]` in sync-owned `review_sync_compare_sol.rs` without having run them**. Unverified un-ignores; do not integrate before cargo |
| browse lead `524a2b6` Ctrl+D toggles an SSH favourite | UX-BRW-09 | TESTED-FE-MOCK (s11 passes; negative control fails without the fix) | yes (STATUS) | sol R1 in progress | — |
| browse-opus `cf94e9b` browse-08, `86444ef` browse-09 (= UX-BRW-03), `6dece77` browse-20, `6d2b005` browse-25, `7baf001` browse-28, `49f2413` browse-16, `14d173a` browse-26, `6a4780f` tests | as listed | FE-MOCK, `it.fails` flipped | only `6bf87a3` has a cited run (browse-opus-r1.md). Others not cited yet | sol R1 started, no verdict | `14d173a` edits `session.ts` (153) and `App.tsx` (131, 1160). Main now has archive's `session.ts:37`; separate hunks. `7baf001` edits `panes.ts` 980+, which needs a rebase onto main's archive panes.ts |
| remote `445bc89` (+`a40e48d` per STATUS) prototype aliases | UX-REM-05 | FE-MOCK | — | R1 **CHANGES** → fixed, R2 pending | `a40e48d` not visible on the branch at survey time |
| remote `2c09d18` save failures reported | UX-REM-03 | FE-MOCK | — | R1 pending | — |
| remote `c9cf480` Disconnect on saved hosts | UX-REM-04 | FE-MOCK | — | R1 pending | palette/keymap Disconnect still backlog |
| remote-opus `1a08cd1`, `4067083`, `2f1ca61`, `0cc062d` (+3 fixups) | remote-06, remote-05/07, remote-07 (G-10) | commit messages claim chaos/docker bounds as assertions (channel open ≤25 s, connect ≤ CONNECT_TIMEOUT+5 s, list during exec <2 s, cancel <2 s) | **no run result recorded in any report**; STATUS: "Cargo-gated" | none | **claimed measurements need an exact docker-IT command + output** before READY. `ActiveConnection.session` drops the Mutex: cross-cutting, touches connection_pool/supervisor/fs_watcher/fs/ssh.rs |
| sync-opus `863d38d` SC-11 ±2 s tolerance when a side is remote | SC-11 | FE tests (`compareRules.test.ts` 112 lines, compare-flow flip) | not cited | none (sol idle until handoff) | — |
| sync-opus `b3fb471` 3-way base equal/nested rejected | SC-16 | FE `threeWayBase.test.ts` + Rust | Rust PENDING-CARGO | none | — |
| sync-opus `ac5554e` apply checks the source before backing up the destination | SC-08 | Rust (`review_sync_compare_apply.rs`, `ops_paths_tests.rs`) | PENDING-CARGO | none | — |
| sync-sol FE re-run with bindings | SC-11/14/23/33/34/38/43a,b/46/48 still reproduce | TESTED-FE-MOCK: 10 files/51 tests green incl. 14 `it.fails` | yes (sync STATUS ~21:57) | n/a | resolves pass-1 gap "sync baseline blocked on bindings" |

### P2.3 Gaps to watch (pass 2)

1. **Verdicts only in STATUS, no review report file:** remote `7ba7bcc`/`bb2fe92` are integrated on main as `513f16d`/`6cd9f11` with "Sol APPROVE" in remote STATUS, but `remote/` has no sol review report with commands. Archive and shell both have one. Ask remote for `remote/sol-review-*.md`.
2. **Integrated with partial independent re-run:** archive G-07 R2's App tests (18/18), tsc and eslint are lead-only. Sol re-ran only the store tests.
3. **Rust-heavy batches with zero executed tests:** archive-opus (~1.6k lines incl. tests), remote-opus G-10, browse lead SC-18/20/25/27, sync-opus SC-08/16.
   All are queued behind the freeze. None of them should be called fixed until a cargo run is recorded.
4. **Commit claims measurements without a recorded run:** remote-opus `0cc062d` ("turn measurements into regression tests").
5. **Codex workers cannot write the git index** (archive-sol, remote-sol, fileops-sol, sync-sol). Patches go via `_report`; the lead commits. Expected, but every sol-authored test reaches main only through a lead commit, so check the author/attribution trailers.

---

## Stop note — 2026-11-10 22:09 KST

Refreshing stopped after pass 2 on the research lead's instruction (usage limit). Pass 3 was not run. Pass 2 above is the latest state.
