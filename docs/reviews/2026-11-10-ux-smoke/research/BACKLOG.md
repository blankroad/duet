# UX smoke 2026-11-10: cross-module backlog (deduplicated)

Author: ux-research-opus. Written 2026-11-11 after the 02:05 resume.
Sources:
- `research/REGISTRY.md`
- `research/opus-prior-issues.md` §1–§3
- each module's STATUS backlog/parked sections
- `INTEGRATION.json`

**최종 상태:** `INTEGRATION.json`, `../README.md`, 각 모듈 REPORT/READY를 따른다. 아래 표에서는 통합된 이슈를 제거했다. 기존 조사 당시 상태와 근거는 원본 `opus-prior-issues.md` 및 리뷰 보고서에 보존한다.

Evidence classes:
- `CARGO` = an executed Rust repro. `CARGO(11-08)` = executed in the 11-08 review and **not re-run this round**; an `#[ignore]` repro is still in the tree.
- `FE-MOCK` = Vitest with mocked IPC (not a live app).
- `PROBE` = a local executable probe.
- `STATIC` = code reading only.
- `+DEV` = needs a Windows device, real SSH, or a live app; **UNVERIFIED** until then.

Why parked:
- `scope` = outside this round's bounded fix set
- `D-x` = user decision pending
- `device` = needs a real device or server
- `local.rs` = blocked on the user's uncommitted `src-tauri/src/fs/local.rs`
- `contract` = needs an IPC or trait change approved by main

## 0. 최종 미통합 변경 (메인 오케스트레이터 정리)

`INTEGRATION.json`이 최종 통합 상태의 기준이다. 이 문서의 기존 증거는 표의 날짜/분류를 따른다. 오래된 재현은 이번 라운드에서 전부 재실행한 결과가 아니다.

- **fileops B2 (`9489013`)**: 같은 서버의 자기 자신 복사 경로와 빈 undo 기록에 관한 R1 CHANGES가 남았다. 구현 워커의 사용 한도로 R2 구현은 완료되지 않았다. 이 패치는 main에 넣지 않았다. B1(이름 변경)과 B3(취소 이벤트)은 독립 검토와 별도 스냅샷 검증 후 통합했다.
- **remote BE (G-10, remote-03, remote-11/25, remote-12)**: FE 수정과 구분한다. 전체 BE R2 verdict가 CHANGES이고 취소 순서를 증명하는 테스트와 최종 재실행 근거가 미완료라 main에 넣지 않았다. `remote/sol-review-be-r2.md`, `remote/STATUS.md`와 원본 작업 브랜치를 보존했다.
- 원래 목표인 다중 압축 해제와 Windows 다중 선택 More, 승인된 fileops/browse/sync/remote FE 변경은 통합됐다. 작업 브랜치만의 미승인 변경을 main의 해결 항목으로 집계하지 않는다.

## 1. archive

| ID | Aliases | Symptom | Evidence | Why parked | Next step |
| --- | --- | --- | --- | --- | --- |
| archive-03 | U-06, G-08 | Compress or repack failure/cancel strands the original at `.bak.<ts>` and leaves a broken archive; no undo | CARGO(11-08) + STATIC (verified at base) | scope (G-08 rollback pattern) | One shared "backup → .part → swap / restore + journal" helper with fileops/sync |
| archive-09 | G-08 | Extract rollback failure leaves the old folder in `.bak` with no notice | CARGO(11-08) | scope (G-08) | Same helper |
| archive-11 | — | Repacking an encrypted zip produces an unencrypted zip, no warning | CARGO(11-08) | scope | Warn or refuse; carry the password into repack |
| archive-12/13 | — | duet-made zips: mtime 1980, no exec bit; files >4 GiB fail | CARGO(11-08) | scope | zip writer options (zip64, mtime, unix mode) |
| archive-28/29 | — | `.gz` with trailing zero padding fails; zstd skippable frames fail | CARGO(11-08) | scope | Decoder tolerance + tests |
| archive-19/30 | — | rar empty folders dropped; split archives (`.7z.001`, `.z01`) not recognised | STATIC +DEV (WinRAR fixtures) | device, scope | Build fixtures, then decide support vs a hint |
| archive-20 | — | ZipCrypto wrong password passes the header check 1/256 of the time → "corrupt", no retry | CARGO(11-08) + FE-MOCK | scope | Treat CRC failure on an encrypted entry as "wrong password" |
| archive-24 | — | Compress name: `x.tgz`→`x.tgz.tar.gz`, `photo.jpg.zip`, Windows `con` | STATIC | scope | Name helper in Rust |
| archive-23 | G-07 | Local browse temp dirs accumulate in a session; no warning when leaving an edited browse without Update | STATIC | scope | Leave-guard prompt + reap on close |
| UX-ARC-06 | sol ARC-002, G-07 | Bookmark via menu/palette records the temp archive-browse path (dangling later) | STATIC | scope | Hide or redirect bookmark inside archive browse |
| UX-ARC-07 | sol ARC-003, **= sync FE-03**, fileops inv row 27 | Read-only (non-repack) archive browse still allows edits and compare/3-way mutations on the temp copy; nothing persists | STATIC | scope | Capability guard for mutations in archive browse, or a persistent banner |
| UX-ARC-09 | cross-cutting journal durability | Here-mode now attempts rollback on append failure; process death before durable journal append still has no write-ahead recovery guarantee | STATIC, final R3 scope | architecture follow-up | Write-ahead recovery design and crash/fault tests |
| remote extract-here | SPEC-R1b limit | "Extract here" hidden on SSH (SFTP rename/merge semantics unverified) | STATIC +DEV | device (real SSH) | docker-IT of staging + rename on an SSH target |
| fix-round follow-ups | archive.md 11-10 | Remote `zip -r` follows links (needs `-y`); Windows non-admin browse→repack silently drops skipped links; Shift-JIS names; 7z symlinks extracted as files; archive-33 (link after target, Windows) | STATIC +DEV | device, scope | Per item; the Windows items need a device |
| archive-31, archive-34 | G-27, D-11, D-3 | Remote zip password visible in `ps` (`unzip -P`); Rust password `String` not zeroized | STATIC | D-11, D-3 | Decide on a stdin path / crate |

## 2. shell (OS integration, keymap, settings, toasts)

| ID | Aliases | Symptom | Evidence | Why parked | Next step |
| --- | --- | --- | --- | --- | --- |
| UX-SHL-06 | ss "improve" | Shell-menu worker `rx.await` has no timeout → More spinner can hang | STATIC +DEV | device | Timeout + cancel |
| UX-SHL-01m | — | macOS/Linux have no native "More options" | STATIC | platform limit | Product decision only |
| UX-SHL-05 | 11-04 "명령 가용성" | Palette/keymap has no availability model; inapplicable commands fail at run time | STATIC | scope (design) | One enabled/when + reason contract (shell + browse) |
| UX-SHL-08 | sol SHL-003 | macOS palette "Quit" does nothing (Cmd+Q native works) | FE-MOCK | scope (minor) | Call app exit on macOS |
| UX-SHL-09 | shell-sol "UX-SHL-02"; 09-05 CF-10 | Multi-selection hides Open/reveal/terminal; no per-file "Open with ▸" on macOS/Linux | FE-MOCK | scope (policy: mixed kinds, remote) | Define multi-open policy; "Open with ▸" submenu |
| UX-SHL-10 | shell-sol "UX-SHL-03" | macOS `open -a <missing app>` returns Ok silently | CARGO (real macOS missing-app repro fails as intended) | scope | Check open -a exit status; keep the existing repro as a future regression |
| UX-SHL-13 (new) | fileops inv row 29 | New symlink has no palette command or key | STATIC | scope | Add `file.newSymlink` |
| CF-11 | 11-04 file-view B-02 | Context menu ~20 flat items; no submenus or Properties | STATIC | scope (design) | "Tools ▸" / "Copy ▸" grouping |
| B-01 / SC-50 | D-12 | List navigation keys hard-coded (rule: all keys configurable); `useEffect` data fetching | STATIC | D-12 | Decide rule exception vs `nav.*` commands |
| ss-11 | — | Windows OS clipboard failure leaks HGLOBAL; FE ignores the result | STATIC +DEV | device | Device check, then fix the leak + surface errors |
| ss-17, ss-26, ss-28, ss-29 | — | CLI warm-start cwd; editor-command field saves per keystroke; bad localStorage shapes throw; AltGr+digit fires Ctrl+Alt shortcuts | FE-MOCK (17 STATIC) | scope | Small FE fixes; `it.fails` repros already exist |
| ss-22 | — | Connection error dot has no tooltip; raw status-bar tooltip; a11y | FE-MOCK | scope | shell + remote |
| ss-24 | D-14 | 4 error toasts drop a new success toast | FE-MOCK | D-14 | Product choice |
| ss-27 rest | — | Non-error English text (dynamic commands, shelf "Main", BE task titles) | STATIC | scope | i18n pass (with SC-39/41) |

## 3. fileops (copy/move/delete/rename, undo, tasks, clipboard/shelf)

| ID | Aliases | Symptom | Evidence | Why parked | Next step |
| --- | --- | --- | --- | --- | --- |
| fileops-09 | G-08 (wording fixed in 11-10) | Failed folder Replace hides the original at `.bak.<ts>`; partial copy left; no record | CARGO(11-08) + FE-MOCK | scope (G-08) | Shared rollback helper |
| fileops-15 | G-08 | Same-host Replace failure: no immediate rollback (undo now skips occupied spots) | CARGO(11-08) (may now pass) | scope | Run the ignored repro; then decide |
| fileops-17 | G-08 | Cross-drive move: trash fails → both copies remain, no record, raw text | FE-MOCK + CARGO(11-08) | scope | Same helper |
| fileops-10/11/12/13 | G-12, remote-12 family | UAC/sudo paths: folder Replace permanently deletes the old folder; UAC move deletes the source; sudo Skip trashes skipped sources; sudo KeepBoth renames everything | CARGO(11-08) (10, 13) + STATIC (11, 12) +DEV (UAC) | device, scope | Route elevated paths through the normal safety helpers |
| fileops-14 | — | Same-host folder KeepBoth nests as `dir (1)/dir/…` | PROBE (local rsync) +DEV (GNU rsync/SSH) | device | Trailing-slash source; docker-IT |
| fileops-18/26/34/35 | G-19, remote-23 | `.duet-part` left behind, silently overwritten, resumed against a changed source; folder relay retry fails at mkdir | CARGO(11-08) | scope | Unique temp name + cleanup + source identity check |
| fileops-21 | D-6 | Undo of a file-Replace copy reports success but leaves nothing | CARGO(11-08) | D-6 | User decision (hint vs exclude from undo) |
| fileops-23 | — | Closing the app mid-task kills it silently, no record | STATIC +DEV | device (live app) | Close-request guard + partial journal |
| fileops-27/32 | G-08 | Batch-rename rollback failure hidden; multi chmod partial failure not journaled | CARGO(11-08) (27) / STATIC (32) | scope | Partial journaling helper |
| fileops-28/29/30 | — | Task panic stalls the queue; no remote trash empty/list; put-back rejects the whole batch if one spot is occupied (raw text) | STATIC | scope | — |
| fileops-31 | 09-05 OP-13 | Per-file conflict groups → several tasks/journals; replans don't re-ask about new conflicts | STATIC | scope | Decision map passed to one BE execute (IPC) |
| fileops-33 rest | — | Trash called directly from commands; staging safe-root check | STATIC | scope | Rule cleanup |
| UX-FOP-inv26 (new) | fileops inventory row 26 | Ctrl+Z during a running copy/move undoes the **previous** op | STATIC +DEV | device (live app) | Block or queue undo while a task is running |
| UX-FOP-inv28 (new) | inventory row 28 | OS-file drop ignores the `confirm_transfer` setting | STATIC | scope | Honour the setting |
| ss-06 | G-26 | Mixed-source shelf re-applies only the first group (ss-31 virtual-trash destination guard is now fixed) | FE-MOCK | scope | Resume/consume groups after accepted operations |
| undo follow-ups | fix-round undo.md | stale flag not persisted (one wasted Ctrl+Z after restart); redo doesn't refresh stamps; "not in trash" not typed as `NotFound`; no atomic no-replace rename | STATIC | **local.rs** (last two), scope | After the user's local.rs work lands |

## 4. browse (navigation, selection, search/index, preview, bookmarks)

| ID | Aliases | Symptom | Evidence | Why parked | Next step |
| --- | --- | --- | --- | --- | --- |
| browse-19/21/27 | G-21 | Unreadable subfolder fails the local size calc; macOS UF_HIDDEN shown; non-UTF-8 names dropped (Linux) | CARGO(11-08) (19, 21) + STATIC (27) | **local.rs** | After the user's local.rs work |
| browse-07 | — | Large unregistered-extension text preview freezes the UI | FE-MOCK +DEV | scope | Size cap / worker |
| browse-12/13 | — | Shared watcher dropped when one pane leaves; every fs event re-reads the whole list | CARGO(11-08) / FE-MOCK | scope | Ref-counted watch; debounce |
| browse-15 | G-21, 11-04 #2 | Failed listing shown as "empty folder" | FE-MOCK | scope | Distinct error state (with UX-REM-02) |
| browse-24 | D-14 | Sync browsing silently skips a missing counterpart; back/forward not synced | STATIC | D-14 | Product choice |
| browse-29 | — | Thumbnail/icon caches unbounded; thumbnails in the Roaming config dir | STATIC | scope | Cap + cache dir |
| browse-10 rest | §7 | UNC root/parent logic still in FE `splitRoot` | STATIC | scope | Move to BE |
| SC-19 | browse-s05 | Full-drive index at every launch (network/USB); duplicate build in StrictMode | FE-MOCK +DEV | scope (drive scope = product) | In-progress guard; fixed-disk policy |
| SC-42 | browse-s03, s12 | Reindex failure ignored; search results lack ↑↓ traversal | FE-MOCK | scope | — |
| SC-48 | browse-s13 | Jumper: remote label = IP after restart, key collision, no multi-word/initials match | FE-MOCK | scope | — |
| SC-49 | browse-s14/15 | Content search skips files >8 MiB silently; ignore-glob semantics differ FE/BE | FE-MOCK + STATIC | scope | One matcher + visible skip count |
| UX-BRW-01 | sol BRW-002, near ss-13 | Multi-select bookmark/host-favourite records only the clicked item, files included | FE-MOCK + STATIC | policy | Decide "bookmark all dirs" vs hide on multi |
| UX-BRW-04 | sol BRW-003 | Quick Look / open-in-other use the cursor, not the selection | STATIC | likely intended | Document the contract |
| ss-13, ss-19, ss-20 | — | Drag-bookmark toast `{{name}}` + duplicates/files; ghost tag chips; reorder with duplicate IDs | FE-MOCK / CARGO(11-08) | scope | Small fixes |
| 11-04 #1, CF-04 | — | Dev StrictMode restores the wrong active tab; search results have no multi-select/actions | STATIC | scope | — |

## 5. remote (connections, auth, SFTP, remote commands)

| ID | Aliases | Symptom | Evidence | Why parked | Next step |
| --- | --- | --- | --- | --- | --- |
| UX-REM-01 | **remote-04**, G-11, D-10; 11-04 fix incomplete | Editing a saved host's address can send the old vault password to the new server (**security**) | FE-MOCK (3 `it.fails`) | contract (G-11 identity), D-10 | Bind vault entries to host+port+user+key; main priority |
| remote-02 | U-14, G-11 | ProxyJump approval of the jump host also trusts or replaces the target key (MITM) | CARGO(11-08) | contract (G-11) | Per-hop fingerprint prompts |
| remote-10 | G-11, G-26 | Banner reconnect gives a new connection ID; clipboard, shelf and undo point at the old one | CARGO(11-08) + FE-MOCK | contract (G-11) | Rebind by endpoint identity |
| UX-REM-02 | sol REM-001, near browse-15 | Restored/disconnected SSH tab: toolbar create/copy/move/delete still submit to the dead source | FE-MOCK | scope | Disable source-bound actions while disconnected |
| UX-REM-08 (new) | remote STATUS backlog | No palette/keymap Disconnect command | STATIC | scope | Add `connection.disconnect` |
| browse-02/17/22 | remote edit | F4 remote save overwrites a server-side change without asking; upload failure invisible; Enter-open temp clobbers same basename | CARGO(11-08) (02) + STATIC | scope | One remote-edit session redesign |
| browse-18 | G-21 | Remote folder size shows 0 B when one child is unreadable | STATIC | scope | "Partial" result |
| remote-13/14 | — | `~/.ssh/config` Include/`Host a b`/Match mis-parsed; password-only ProxyJump target bypasses the jump | CARGO(11-08) | scope (large) | Parser rewrite; keep the jump on fallback |
| remote-15/20 | — | Windows OpenSSH agent/Pageant unsupported; known_hosts at `%USERPROFILE%\ssh` | STATIC +DEV | device | Windows device |
| remote-16 | G-27 | No passphrase prompt; a passphrase typed as the password is sent to the server | CARGO(11-08) | scope | Separate passphrase prompt |
| remote-18 | **= archive-25**, G-20 | Remote browse temp `~/.duet-tmp/browse-*` never cleaned | CARGO(11-08) | scope | Reap on connect/close (allowed by the §3 exception) |
| remote-08 | G-08 | Cross-volume remote trash failure: partial loss, no record | CARGO(11-08) | scope | Shared rollback helper |
| remote-09 | D-9 | Same-host, different-user copy fails without warning | CARGO(11-08) | D-9 | Pre-check + hint |
| remote-23/24/28/29/31/32/33 | — | Download retry/timeout; vague SFTP errors; reconnect race; sudo not cancellable; `Debug` on a password struct; 3 s polling opens a new SFTP subsystem each time; known_hosts backup name collision | CARGO(11-08) (23) / STATIC | scope | Small items |
| D-3 vault `unsafe` | ss handoff | `secret_vault.rs` uses `unsafe` outside `platform/` (§8) | STATIC | D-3 | Rule exception vs zeroize crate |

## 6. sync (compare, merge, sync, 3-way)

| ID | Aliases | Symptom | Evidence | Why parked | Next step |
| --- | --- | --- | --- | --- | --- |
| SC-02, SC-52 | U-08, D-7 | Delete-propagating + overwriting sync: undo reports success but overwritten files aren't restored; `.bak` files pile up in the destination | CARGO(11-08) | D-7 | Decide the backup location (outside the destination) |
| SC-06 | G-15 | Follows destination links/junctions → writes or trashes outside scope | CARGO(11-08) +DEV (junction) | **local.rs** (or reuse remote-03 `list_for_walk` once landed) | Sync opus SC-06 proposal (`opus-round1.md`) |
| SC-01 rest | — | Same-host rsync partial failure: backup only, no journal | STATIC +DEV | device (real rsync) | Parse rsync exit; journal what was applied |
| SC-10 | — | Same-host rsync: Korean names escaped (undo misses them); openrsync lacks `--info=progress2` | CARGO(11-08) +DEV | device | docker-IT with GNU rsync + openrsync |
| UX-SYN-01 | **SC-15** (wording fixed `8b18bee`), D-8 | Sync offered for local↔SSH / cross-host; it always fails | FE-MOCK + STATIC | D-8 | Gate the menu, or build relay sync |
| UX-SYN-02 | sync FE-02 | Compare offers actions for nested roots that always fail at Apply | STATIC | scope | Validate eligibility before enabling actions |
| SC-35 | G-22 (browse-03 fixed browse side only) | Compare search/status filter hides rows that Apply still includes | STATIC | scope | "Visible only" or an explicit scope label |
| SC-12, SC-13, SC-14 | G-21 (13) | Sync preview mixes new and overwritten files; preview OK but execute fails on permissions; counts shown as bytes | FE-MOCK (14) + STATIC | scope | — |
| SC-23/33/34/46 | — | Diff past 600 lines hidden/truncated silently; checksum paste formats; internal labels shown | FE-MOCK | scope | — |
| SC-36/37/38/43/44/45 | — | Keyboard skip/selection reset; no list virtualisation (5000 rows +DEV); 200-row cut-off; compare start race; 3-way has no progress/cancel; export format by extension only | FE-MOCK (38, 43) / STATIC | scope | — |
| SC-39/41 | ss-27 | English task titles; hard-coded Korean undo messages | STATIC | scope | i18n pass |
| R3-S4-1 | SC-17 residual | NFC+NFD siblings on a normalisation-sensitive FS: apply overwrites the other form (`.bak` + undo OK) | CARGO (ignored repro) | scope (rare) | Carry ambiguity from judging into apply |

## 7. Cross-team duplicates (listed once above)

- archive-25 = remote-18 → **remote**
- remote-25 = SC-29 = browse-s10 → **remote** (in flight)
- sync FE-03 ≈ UX-ARC-07 ≈ fileops inv row 27 → **archive**
- sync FE-01 = SC-07 (in flight, sync)
- browse-s03/s12 = SC-42 · s05 ⊂ SC-19 · s08 = SC-25 · s09 = SC-27 · s13 ⊂ SC-48 · s14/15 ⊂ SC-49 → **browse**
- fileops-36 = UX-SHL-04 → **shell** (in flight)
- archive-14 = fileops-16 (G-09) → **fileops** (batch B)
- G-08 rollback (archive-03/09, fileops-09/15/17/27/32, remote-08, SC-01 rest): **one shared helper; fileops leads**
- G-11 identity (remote-02/04/10, fileops-05 remainder, browse-02): **one contract; main**

## 8. ID hygiene

- Prior 11-08 fileops issues keep the `fileops-NN` IDs. The registry convention "UX-FOP-<nn>" collides with the new UX-FOP-01/02 (sol FOP-001/002), so new fileops items use `UX-FOP-inv<row>` here.
- UX-SHL-11/12 are labelled "fileops-03/04" in main `e94719d` (immutable). The canonical IDs stand; 11-08 fileops-03/04 are unrelated backend defects (fixed in the 11-10 round).
- New IDs proposed in this file:
  - UX-ARC-09 (journal-push failure / WAL, cross-cutting)
  - UX-SHL-13 (symlink command)
  - UX-REM-08 (Disconnect command)
  - UX-FOP-inv26 and UX-FOP-inv28
  - Add these to REGISTRY.md.

## 9. Decisions waiting on the user or main

- D-3 vault `unsafe`
- D-6 Replace-copy undo
- D-7 sync backup location
- D-8 local↔remote sync
- D-9 same-host different-user copy
- D-10 vault migration
- D-11 remote zip password
- D-12 hard-coded nav keys
- D-14 product choices
- G-11 identity contract
- remote-03 `list_for_walk` trait contract
- UX-SHL-01 IPC args change
- release of the user's `fs/local.rs` WIP (unblocks browse-19/21/27, SC-06, undo follow-ups)

## 최종 범위 제한

- UX-SHL-04: Linux OS 파일 클립보드 조건부 정리는 플랫폼 제한으로 남아 있다. macOS의 외부 앱 동시 쓰기는 best effort이며 원자적 보장은 없다. Windows는 교차 컴파일만 확인했다.
- UX-BRW-08: 폴더 진입/상위 이동 중 탭 이동은 수정했다. 일반 navigateTo 경로의 북마크·뒤로/앞으로를 같은 범위로 해결했다고 보지 않는다.
- 취소 중 압축 해제의 세밀한 중단, 외부 프로세스와의 경로 경쟁, crash-safe journal은 명시된 후속 범위다.

### 새 흐름의 추가 점검 후보 (정적 분석, 실행 재현 전)

- 빠른 작업의 종결/NeedPassword 이벤트가 enqueue 응답 뒤 FE pending 등록보다 먼저 도착하는 순서. archive R2 리뷰가 기존 공통 타이밍 제한으로 명시했다. 현재 암호 큐·안내 테스트는 등록 이후 상태를 검증하며 실제 이벤트 선행을 증명하지 않는다. 이벤트 버퍼/등록 프로토콜과 live app 재현은 후속이다.
