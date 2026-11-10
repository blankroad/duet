> **최종 상태 정리:** README.md / INTEGRATION.json / VALIDATION.json을 따른다. 아래 과거 시점의 조사·교차표는 근거 기록이며, 최종 미해결 목록은 BACKLOG.md다. 원격 BE와 fileops B2는 미통합이다.

# UX smoke registry (research-owned)

## FINAL STATUS (concise; source of truth for integration = ../INTEGRATION.json)

**Primary user repro** (several archives selected → no extract; no More/Bandizip):
- UX-SHL-01 multi-select More: **INTEGRATED** shell L2 → main de032ee 0d97e51 8ccf975 c438b45 6f657e4 2d84c7e (from 8aff4f1..d32af3b; r1 CHANGES → r2 APPROVE). Main regenerated bindings at 197bf87 (shellMenuOpen(paths: string[], scope)); main tsc next. Committed ux-smoke/shell-opus 8aff4f1 + 87dd723, then R2 d6b4191 + d32af3b (shell_menu_core 21 passed, ux_shell_l2 1 passed, windows-gnu clippy clean). Cargo shell_menu_core passes 13 tests (macOS); Windows cross-compile clippy is clean; tsc is clean against regenerated bindings. Research FE-MOCK acceptance Part B PASSES on shell-opus 8aff4f1+87dd723 with regenerated bindings: 3 archives → native-menu IPC gets exactly 3 paths, and the mixed case gets all 4 (research/sol-acceptance.md 'R3b shell'). Shell-sol L2 review is pending. Windows runtime and Bandizip are UNVERIFIED.
- UX-ARC-01 multi-archive extract + true extract-here: backend d5c8309 is committed. cargo core::archive: 118 pass / 0 fail / 22 ignored. gen:bindings is OK. One new clippy issue is being fixed. Frontend cd072c2 was WIP, then d37f5be (FE type-clean, tsc 0), then 905bc2f (test compile fix): core::archive 121 passed / 0 failed / 22 ignored, clippy clean except the baseline. Awaiting archive Sol approval + READY. Acceptance Part A runs only on the final type-clean frontend after R2 rollback commits; it is an expected fail until then.
- Gate note for main: `clippy -D warnings` has a baseline hit at fs/local.rs:637 at base. It is pre-existing and not from this round.

**Independent acceptance (research-sol, FE-MOCK, research/sol-acceptance.md):**
- Base 76b9b6e: FAIL. No extract item and no More with 3 archives.
- Archive 905bc2f (FE identical to d37f5be): Part A PASS. Both 'extract-here' (through the real ExtractHereDialog confirm) and 'extract' send exactly a.zip, b.7z and c.tar.gz; the plain file is never sent.
- Shell d32af3b: Part B PASS. The native-menu IPC gets all 3 paths; the mixed case gets all 4.
- COMBINED archive 905bc2f + shell d32af3b: 4/4 PASS.
- Limits: INCONCLUSIVE for real transport, because the archive-tree bindings still had `shellMenuOpen(path)`. Final run on integrated main after both regens. Windows/Bandizip UNVERIFIED.

**Integrated by main** (main hashes):
- shell L1: UX-SHL-07, UX-SHL-11, UX-SHL-12 (88f7d99 e94719d c6aaa3d).
- archive G07: UX-ARC-08 (8fa018a cc0bd8f).
- remote FE1: UX-REM-06, UX-REM-07 (513f16d 6cd9f11 670bf88 62a9702).
- remote FE2: UX-REM-03, UX-REM-04, UX-REM-05 (59418e7 f631500 1e47531 2cc4f01 96a0742 8173e0a 62c6c37).
- fileops A: fileops-24, UX-FOP-01, UX-FOP-02, same-folder transfer (main 03a19a9..374474e, 8 commits; main 11 files / 123 tests).
- browse FE1: 12 commits (main b89f5c8..569e67f; main 15 files / 184 tests + tsc 0). This includes UX-BRW-02 = browse-03 and browse's round-1 set; per-ID mapping is in ../INTEGRATION.json and browse/READY.json.

**In review / pending cargo:**
- fileops batch B (backend): cargo running (slot A).
- browse search/index Rust fixes (SC-18/20/25/27): cargo PASS (lib 38 passed / 0 failed / 1 ignored; review_sync_compare_sol 8 / 0). Awaiting browse READY + Sol approval.
- sync (SC-07 etc., cargo queued).
- remote G-10 BE (cargo queued).
- shell UX-SHL-02 (background menu via CreateViewObject) and UX-SHL-03 (invoke failures surfaced) are INTEGRATED with shell L2 (same main hashes); Sol APPROVE r1; Windows UNVERIFIED. UX-SHL-04 (clipboard): **INTEGRATED** shell L3 → main 89b590c fc7da20 7758a16 (from c27912d b3da76b 6745e38; Sol r3 APPROVE; merge-tree clean vs main; cargo platform:: 47, private-pasteboard test on real macOS, windows-gnu clippy clean). Linux limit is in backlog. Shell follow-up INT-1 c34b1e3 → main 7984ad7; L1-tests → main f90fb82 fa67b2e d2f57fb 8fc67b5. Shell final report: shell/REPORT.md. Shell backlog: UX-SHL-05/06/08/09/10.

**Report rules:** expected-failure tests (it.fails / ignored repros) are backlog, not fixes. Windows runtime, Bandizip and real SSH are UNVERIFIED everywhere unless shown on a device.

**Backlog:** research/BACKLOG.md (deduplicated; being written). Unrelated expected-failure repros (it.fails) remain backlog, not resolved.

---

Base 76b9b6e. Evidence: STATIC = code reading; FE-MOCK = mocked vitest; CARGO = cargo test; LIVE = real app run. Windows/native/real-SSH = UNVERIFIED unless shown on a real machine.

| ID | Symptom | Root cause / file | Owner | Prior aliases | Status | Evidence / test |
|---|---|---|---|---|---|---|
| UX-ARC-01 | Multi-select of several archives (a.zip, b.7z, c.tar.gz): context menu has no "Extract here" / extract-each | `src/lib/entryMenu.tsx:284` `!multi` gate; `src/lib/fileActions.ts:632-636` `triggerExtract` refuses `targets.length !== 1` (toast extractSelectOne); BE `fs_extract_plan(archive)` single | archive | 11-08 archive.md follow-up "여러 아카이브 한 번에 풀기"; team AR-01 | INTEGRATED — archive multi-extract R3; INTEGRATION.json is authoritative | FE-MOCK acceptance REPRODUCED on base (research/sol-acceptance.md, part A: 'expected undefined to be defined'); STATIC ×3 (lead, archive lead, research-sol: research/sol-priority-repro.md). Main authorized label fix + multi-extract; overwrite/undo policy still applies. Spec must define dest/collision/password/partial failure (main) |
| UX-SHL-01 | Multi-select: "More options" (Windows shell menu, Bandizip/7-Zip verbs) missing | `src/App.tsx:763-766` `platform()==="windows" && local && selectedCount===1`; `src-tauri/src/platform/shell_menu.rs` `build_menu` single child PIDL `GetUIObjectOf(&[child])`; IPC `shell_menu_open(path, scope)` single; cache key `(PathBuf, ShellScope)` | shell | shell team S-01 | INTEGRATED — shell approved batch; INTEGRATION.json is authoritative | FE-MOCK acceptance REPRODUCED on base (part B, incl. mixed control); STATIC ×3 (lead, shell lead, research-sol). Also IPC system.rs:687-705/724-739 single path; non-Windows returns empty (system.rs:708-715). Windows runtime + Bandizip population UNVERIFIED. Main: PIDL lifetime, BE same-parent validation, cache keyed by full selection, stale-token guard |
| UX-SHL-01m | macOS: no "More options" at all (single or multi) | same gate is Windows-only | shell | — | PLATFORM LIMIT (not a bug unless main decides) | STATIC |
| UX-ARC-02 | Label "Extract here" but backend extracts into `<stem>/` | `src-tauri/src/core/archive.rs:215` (per archive lead) | archive | team AR-02 | INTEGRATED — archive multi-extract R3; INTEGRATION.json is authoritative | STATIC |
| UX-ARC-03 | Extract conflict silently keeps `.bak` | archive backend | archive | 11-08 archive-21; team AR-03 | INTEGRATED — archive multi-extract R3; INTEGRATION.json is authoritative | STATIC |
| UX-ARC-04 | Single extract-password dialog slot (concurrent encrypted extracts clash) | extract password flow | archive | team AR-04 | INTEGRATED — archive multi-extract R3; INTEGRATION.json is authoritative | STATIC |
| UX-ARC-05 | Extract/compress have no commandId → not in command palette/keymap | `entryMenu.tsx` extract/compress items | archive + shell (registry) | team AR-05 | INTEGRATED — archive multi-extract R3; INTEGRATION.json is authoritative | STATIC |
| UX-SHL-02 | Background "More options" binds current folder as item (shows Delete/Rename of folder) | `App.tsx` openEmptyMenuAt + `shell_menu.rs` | shell | 11-08 shell-settings-10 | INTEGRATED — shell approved batch; INTEGRATION.json is authoritative | STATIC, Windows UNVERIFIED |
| UX-SHL-03 | Shell menu invoke failure silent | `shell_menu_invoke` always Ok; FE `void` | shell | 11-08 shell-settings-16 | INTEGRATED — shell approved batch; INTEGRATION.json is authoritative | STATIC |
| UX-SHL-04 | Stale OS clipboard/shelf ownership (clear-if-owned) | `platform/macos.rs` clipboard | shell (agreed w/ fileops) | 11-08 fileops-36; G-26 (ss-06, ss-31, fileops-24, remote-10) | INTEGRATED — shell approved batch; INTEGRATION.json is authoritative (UX-SHL-04 macOS best effort / Linux limit) | STATIC; cargo test queued (CARGO_QUEUE #2) |
| UX-SHL-05 | Command palette/keymap has no availability model (commands not applicable to selection/remote not disabled with reason) | `src/lib/commands.ts` no enabled/when field | shell (+browse) | 11-04 dialogs "명령 가용성" (DEFERRED) | BACKLOG (shell confirmed backlog) | STATIC verified (opus) |
| UX-SHL-06 | Background shell-menu worker `rx.await` no timeout → "More options" spinner may hang on bad extension | `platform/shell_menu.rs` worker | shell | 11-08 ss "improve" | BACKLOG | STATIC, Windows UNVERIFIED |
| UX-BRW-02 | Filter-hidden selected items still targeted by actions | `resolveActiveTargets` raw `tab.selected` | browse (+fileops, sync) | browse-03 = G-22 (SC-07, SC-35) | INTEGRATED — browse approved batch; INTEGRATION.json is authoritative | it.fails marker present |
| UX-REM-01 | Saved-host address edit may leak old vault password (possible incomplete earlier fix) | remote dialogs / vault | remote | 11-08 remote-04; 11-04 connection fix | OPEN — remote NOT taking G-11 this round → BACKLOG, security-flagged for main | FE-MOCK it.fails ×3 still present |
| UX-BRW-03 | Calculate size with no marked selection hits wrong folder (raw entries indexed by displayed cursor) | `src/lib/dirSize.ts:23` vs `fileActions.ts:60` computeDisplayed | browse | 11-08 browse-09 (same root); sol BRW-001 | INTEGRATED — browse approved batch; INTEGRATION.json is authoritative | FE-MOCK it.fails present (prior) + STATIC (sol) |
| UX-SHL-07 | F4 "edit file" unreachable from palette/keymap: `editFile` dep supplied (App:957-977) but never emitted by buildBuiltins | `src/lib/commands.ts:87` | shell (registry) + browse (editor cb) | sol SHL-002; (browse-02 is remote save race, different) | INTEGRATED — shell approved batch; INTEGRATION.json is authoritative | FE-MOCK REPRODUCED ×2 (research `src/__ux_research__/shl07-edit-command.test.ts`; shell regression test 'expected undefined to be F4') |
| UX-SHL-08 | macOS: app.quit registered (Ctrl/Cmd+Q, palette) but handler no-ops on Mac | `App.tsx:1158-1164`, commands.ts:577 | shell | sol SHL-003 | BACKLOG (shell) | FE-MOCK REPRODUCED (isolated production callback; research/repro-tests/shl08-macos-quit.test.ts.txt) |
| UX-BRW-01 | (merged sol BRW-002) multi-select Bookmark/Host-favorite records clicked child only, incl. ordinary files | `entryMenu.tsx:463-476` | browse (+remote host fav) | sol BRW-002; near ss-13 (dup/files on drag) | OPEN-candidate, needs policy (repro assumes 'bookmark every selected dir'; alternative = hide on multi) | STATIC ×2 + FE-MOCK REPRODUCED (`src/__ux_research__/brw01-bookmark.test.ts`: got ['/fixture/alpha'] for 2 selected) |
| UX-ARC-06 | Bookmark of temp archive-browse path via menu/palette (PathBar hides it) → dangling bookmark | `entryMenu.tsx:463/650`, App:1107-1116 vs PathBar:389-390 | archive + browse | sol ARC-002; G-07 family (archive-15, browse-32/34) | BACKLOG (archive parked) | STATIC |
| UX-ARC-07 | Non-repack archive browse (read-only badge) still allows rename/delete/create on temp copy, persistence silently impossible | `Pane.tsx:145-149` vs entryMenu/fileActions no archive guard | archive | sol ARC-003; G-07 | BACKLOG | STATIC |
| UX-SYN-01 | Sync offered for local↔SSH / cross-host though backend supports only LocalToLocal/SshSameHost | `entryMenu.tsx:592-597`, `core/ops.rs:1187-1195` | sync | 11-08 SC-15 (PARTIAL wording 8b18bee; menu gating D-8) | DEFERRED on D-8 unless main decides | STATIC + prior FE-MOCK |
| UX-REM-02 | Restored/disconnected SSH tab: Refresh no-ops but toolbar create/copy/move/delete still submit to dead source | `App.tsx:587-589` vs `PaneToolbar.tsx:66,139-185` | remote (+browse/fileops UI) | sol REM-001; near browse-15 / G-21 | PARKED by remote unless cheap after round 1 | FE-MOCK REPRODUCED (`src/__ux_research__/rem02-restored-toolbar.test.tsx`: copy/move/delete plan IPC called with restored connection, 3/3 fail) |
| UX-FOP-01 | Virtual trash: toolbar Copy/Move enabled but reject with toast | `PaneToolbar.tsx`, `fileActions.ts:607/621` | fileops | sol FOP-001 | INTEGRATED — fileops A2; INTEGRATION.json is authoritative | FE-MOCK REPRODUCED (repro-tests/fop01-trash-toolbar.test.tsx.txt: Copy/Move not disabled) |
| UX-FOP-02 | No-target Delete silently returns (copy/move toast) | `fileActions.ts:695` | fileops | sol FOP-002 | INTEGRATED — fileops A2; INTEGRATION.json is authoritative | FE-MOCK REPRODUCED (repro-tests/fop02-empty-delete.test.ts.txt: no toast) |
| UX-BRW-04 | Quick Look / Open-in-other via keyboard/palette use cursor, not selection; hidden in multi menu | `App.tsx:979-994,1076`; QuickLook:24-29 | browse | sol BRW-003 | BACKLOG (likely intended; document contract) | STATIC |

### fileops prior-issue crosswalk (from fileops/sol-baseline.md; ux-fileops-sol, base 76b9b6e)
Fix-round already fixed: 01, 02, 03, 04, 05, 06, 07, 19, 20, 22, 25 (+ part of 09, 33). Still present / impact rank (H = common workflow):
- **H:** 08 case-only rename (static), 09 partial (FE-MOCK + static), 15 partial, 16 cancel → double/contradictory toast (FE-MOCK: ["Cancelled…","Task completed"]), 17 (FE-MOCK), 23 close mid-task (static, native unverified), 24 cut→paste clears clipboard on cancel/plan error (FE-MOCK; G-26 with UX-SHL-04).
- **M:** 10, 11, 12, 13, 14 (local rsync probe: `dir (1)/dir/a` nesting), 18, 21 (D-6), 27, 30, 31, 32. **L:** 26, 28, 29, 33, 34, 35. 36 → shell (UX-SHL-04).
Canonical IDs: UX-FOP-<prior nn> (e.g. UX-FOP-24 = fileops-24). Rust repros pending cargo slot (queue).

Full prior-issue crosswalk (150 items, statuses mapped to main hashes, dup groups): research/opus-prior-issues.md §1–§3. Ownership routing confirmed: search/index/jumper/frecency → browse; remote find cmd → remote; OS clipboard → shell; extract menu section → archive; App.tsx More blocks → shell.

Crosswalked: research/opus-prior-issues.md, research/sol-action-availability.md (full action×entry-point×selection×context matrix + registered-command appendix). Pending: fileops/sol-baseline.md (fileops-07..36).

### Archive G-07 (taken by archive)
| UX-ARC-08 | Archive-in-archive context lost on exit (G-07) | FE archive browse context | archive | 11-08 archive-15, browse-32, browse-34 | INTEGRATED — archive G07 R2; INTEGRATION.json is authoritative | FE-MOCK: 3 files / 20 tests pass (--testTimeout=30000; one 5s timeout under load earlier = infra) |

Research repro tests (uncommitted artifacts, FE-MOCK, assert desired behavior → fail on base): research/repro-tests/ ; results research/sol-fe-repros.md.

### Added from evidence ledger pass 1 (research/opus-evidence-ledger.md)
| ID | Symptom | Owner | Aliases / dups | Status | Evidence |
|---|---|---|---|---|---|
| UX-SHL-09 | Multi-select hides external Open / reveal / terminal | shell | shell-sol label "UX-SHL-02" | BACKLOG | FE-MOCK (shell-sol, cited) |
| UX-SHL-10 | macOS `open -a <missing app>` returns Ok silently | shell | shell-sol label "UX-SHL-03" | OPEN | STATIC + ignored Rust repro PENDING-CARGO |
| UX-BRW-02 | (update) filter-hidden selection | browse | browse-03 (G-22) | INTEGRATED — browse approved batch; INTEGRATION.json is authoritative | FE-MOCK 8 files/137 passed, tsc/eslint clean |
| UX-BRW-05 | Stale search result clickable while new query pending | browse | browse-sol s01 | INTEGRATED — browse approved batch; INTEGRATION.json is authoritative | FE-MOCK |
| UX-BRW-06 | Closing content search doesn't call search_cancel | browse | browse-sol s02 | INTEGRATED — browse approved batch; INTEGRATION.json is authoritative | FE-MOCK |
| UX-BRW-07 | Jumper Enter opens previous query's hit | browse | browse-sol s04 | INTEGRATED — browse approved batch; INTEGRATION.json is authoritative | FE-MOCK |
| UX-BRW-08 | Swap panes / move tab during pending listing loses destination | browse | browse-sol s06/s07 | INTEGRATED — browse approved batch; INTEGRATION.json is authoritative (UX-BRW-08 enter/up only) | FE-MOCK |
| UX-BRW-09 | Ctrl+D on bookmarked SSH folder adds instead of toggling | browse | browse-sol s11 (near BRW-01) | INTEGRATED — browse approved batch; INTEGRATION.json is authoritative | FE-MOCK |
| UX-REM-03 | Ad-hoc connect silently ignores host/password save failures | remote | remote-sol NEW-1 | INTEGRATED — remote FE approved batch; INTEGRATION.json is authoritative | FE-MOCK |
| UX-REM-04 | No Disconnect for healthy saved/ad-hoc sessions | remote | remote-sol NEW-2; extends 09-05 SS-02 | INTEGRATED — remote FE approved batch; INTEGRATION.json is authoritative | FE-MOCK |
| UX-REM-05 | Prototype-named aliases (`constructor`, `__proto__`) stuck "reconnecting" | remote | remote-sol NEW-3 | INTEGRATED — remote FE approved batch; INTEGRATION.json is authoritative | FE-MOCK |
| UX-REM-06 | remote-30 ad-hoc alias user/host split at last `@` | remote | 11-08 remote-30 | INTEGRATED — remote FE approved batch; INTEGRATION.json is authoritative | FE-MOCK (it.fails→it ×2) |
| UX-SYN-02 | Compare offers actions for nested roots that always fail | sync | sync FE-02 | OPEN/BACKLOG | STATIC |
Dups (no new IDs): sync FE-01 = SC-07; sync FE-03 ≈ UX-ARC-07; browse s03/s12 = SC-42; s05 ⊂ SC-19; s08 = SC-25; s09 = SC-27; s10 = SC-29 = remote-25 (remote owns); s13 ⊂ SC-48; s14/15 ⊂ SC-49.

### Coordination watch
- `src/lib/commands.ts` + `commands.*.test.ts` + i18n: shell (file.edit) vs archive (file.extract/compress) → shell lands first, archive rebases (proposed).
- `src/stores/panes.ts`: archive setArchiveContext (~964) vs browse-opus setFilter (943-955) → sequential integration, re-run panes*.test.ts.
- `src/stores/session.ts` (browse-owned) edited by archive; `review_sync_compare_sol.rs` (sync-owned) edited by browse — owners notified.
- No branch touches `src-tauri/src/fs/local.rs` (pass 1).
- IPC changes needing bindings regen at integration: archive `fs_extract_plan_batch`; shell (UX-SHL-01) keeps command names, changes args: `shell_menu_open(paths: Vec<PathBuf>, scope)`, `shell_menu_warm(paths, scope)` → TS `commands.shellMenuOpen(paths: string[], scope)`; `shell_menu_invoke` unchanged. FE More block → `entryMoreOptions(platform(), tab.location, computeDisplayed(tab), selectedSet)` in `@/lib/shellMenu`.
- Codex/Sol workers cannot `git commit` (worktree git dir under main .git; sandbox) → leads commit from patches.

### ID disambiguation (main, ~22:40)
Historical **11-08 fileops-03 / fileops-04** are different backend defects (fix-round status per research/opus-prior-issues.md) — NEVER mark them fixed by the keyboard changes below.
| ID | Symptom | Owner | Aliases | Status | Evidence |
|---|---|---|---|---|---|
| UX-SHL-11 | DESIGN.md alternate keys missing: F8 / Shift+F8 (delete), Ctrl+Shift+N (new folder), Shift+F6 (rename) | shell (keymap) | fileops-opus smoke label `ux-fileops-03` (NOT 11-08 fileops-03) | INTEGRATED — shell approved batch; INTEGRATION.json is authoritative | FE-MOCK: fileops' smoke it.fails flip; real window keydown tests (review-L1-sol.md) |
| UX-SHL-12 | macOS Cmd+Backspace does not move selection to trash | shell (keymap) | fileops-opus smoke label `ux-fileops-04` (NOT 11-08 fileops-04) | INTEGRATED — shell approved batch; INTEGRATION.json is authoritative | FE-MOCK (commands.mac.test.ts dispatch); native macOS keyboard unverified |
Main-integrated hashes for shell L1: 88f7d99 / e94719d / c6aaa3d — main focused 13 tests + tsc passed. Commit message of e94719d says 'fileops-03/04' (immutable); canonical = UX-SHL-11/12. Source of truth for integration: main's INTEGRATION.json.
| UX-REM-07 | Pane not refreshed after auto-reconnect | remote | 11-08 remote-27 | INTEGRATED — remote FE approved batch; INTEGRATION.json is authoritative | FE-MOCK (remote/sol-review-r1-fe.md) |
