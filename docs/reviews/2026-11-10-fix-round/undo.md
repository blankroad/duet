# undo 수정 최종 보고

## 요약

- brief 의 P1 3묶음(U-02/G-01, U-10, U-11)과 P2 2건(fileops-25, fileops-20)을 모두 고쳤다. 묶음 안 이슈: fileops-02·03·06·07·20·22·25, SC-04·09·31·40.
- 핵심 변화: Ctrl+Z 는 더 이상 무엇도 영구 삭제하거나 덮어쓰지 않는다. 만든 항목은 **기록 때 지문과 같을 때만 휴지통으로**, 이름 바꾸기·이동 되돌리기는 **자리가 차 있으면 건너뜀**. 되돌릴 수 없게 된 항목은 스택을 막지 않고 건너뛰며, 토스트는 무슨 작업을 왜 어떻게 했는지 말한다.
- 3라운드 교차 리뷰 지적 14건(P1 3): 13건 수정, 1건(redo 후 지문)은 데이터 안전한 한계로 기록. 마지막 R3 수정 2건(lead, 9d823af·5fbf3eb)은 라운드 한도로 교차 리뷰를 다시 받지 못했다 — 둘 다 재현 테스트 빨강→초록 확인.
- 남은 위험: 확인→rename 사이 짧은 경쟁 창(로컬 원자적 no-replace 는 fs/local.rs 소관), stale 은 메모리 전용(재시작 후 한 번 다시 판정), 원격 경로는 실서버 미확인.

## 고친 것

| 이슈                           | 사용자에게 달라지는 점                                                                                                                                                                                                                                                                                      | 커밋                                        | 테스트                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-02 / G-01: fileops-02, SC-04 | 복사·동기화·비교 적용·3-way·병합·압축 해제/압축의 Ctrl+Z 가 만든 것을 휴지통으로 보낸다(원격은 `~/.duet-trash`). 그 뒤 고치거나 파일을 넣은 항목은 남기고 "일부만 되돌림/건너뜀"으로 알린다. 덮어쓴 자리도 적용 직후 그대로일 때만 되돌리고, 아니면 백업 위치를 알려 준다. 구버전 기록은 확인 불가로 건너뜀 | 72ee2d7, c346644, 006cc18, ce0160c, 9d823af | undo.rs `undo_copy_must_not_permanently_delete…`(fileops-02 repro 해제), cleanup_tests 13, stamp 단위 9, review_sync_compare_apply 216·246·334, xcheck_sol sc04×2 |
| SC-09                          | 한쪽 연결이 끊긴 병합 Ctrl+Z 는 아무것도 안 하고 오류(재시도 가능) — "성공"으로 끝나지 않음                                                                                                                                                                                                                 | c346644                                     | apply.rs 365, xcheck_sol sc09                                                                                                                                     |
| SC-31                          | 동기화 되돌리기가 동기화로 생긴 빈 폴더도 치운다(로컬·relay). 못 지우면 재시도 가능한 오류                                                                                                                                                                                                                  | 72ee2d7, c346644, ce0160c                   | review_sync_compare_r3_opus, cleanup_tests                                                                                                                        |
| SC-40                          | 시작 전 취소·첫 복사 전 실패한 병합/적용/3-way 는 기록을 남기지 않아 Ctrl+Z 를 소모하지 않음                                                                                                                                                                                                                | 4683922, 8497bd5                            | ops `sc40_…` 2                                                                                                                                                    |
| U-10 / fileops-03              | 이름 바꾸기·이동·일괄 이름 바꾸기의 되돌리기/다시 실행이 같은 이름의 새 파일을 덮어쓰지 않고 그 항목만 건너뜀. 대소문자·정규화만 바꾼 이름은 정상 되돌림                                                                                                                                                    | 7ee9452, 74e7b68, 5fbf3eb                   | undo.rs fileops-03 repro 2 + journal.rs 2 해제, batch·case-only·NFD/NFC·같은 메타데이터 다른 파일                                                                 |
| fileops-22                     | 여러 항목 이동 되돌리기가 가능한 것은 되돌리고 "일부만"으로 보고(같은 항목에 다시 막히지 않음). 되돌리기 복사가 도중 끊기면 부분 사본을 치워 재시도 가능                                                                                                                                                    | 7ee9452, 74e7b68                            | undo.rs `undo_move_partial_skip…` 해제, `failed_move_back_clears_its_partial_copy`                                                                                |
| U-11 / fileops-06, fileops-07  | 되돌릴 수 없게 된 맨 위 항목(대상 사라짐·바뀜·점유, macOS 휴지통)은 "되돌릴 수 없어 건너뜀" 후 다음 Ctrl+Z 가 이전 작업으로. 일시 오류(연결 등)는 남겨 재시도. History 에 "건너뜀" 배지                                                                                                                     | 5995821, 4b4875f, 99794fa                   | commands/undo.rs 4, journal stale 1, undo.rs macOS fileops-07 repro 해제, FE store·History                                                                        |
| fileops-25                     | 토스트가 "되돌림 (ok)" 대신 "되돌림: 'a.txt' 이름 바꾸기" 처럼 작업·결과·사유를 ko/en 로. 일부·건너뜀의 항목별 사유·백업 위치는 알림 상세에                                                                                                                                                                 | 3b8bdd2, de4bdfe, 6e946a0, a4c314c          | journalLabel.test.ts                                                                                                                                              |
| fileops-20                     | 재시작 후 History 순서·"다음 되돌리기" 배지·다시 실행 버튼이 맞음                                                                                                                                                                                                                                           | 8061c59                                     | `__review__/fileops-opus-history-order`·`fileops-sol-r2-history` 4건 해제                                                                                         |

## 못 고친 것·부분 수정

- **stale 영속화** (메인 결정 (a)): 메모리 전용. 재시작 후 stale 항목마다 Ctrl+Z 한 번이 "건너뜀" 토스트로 소모된다(macOS 로컬 휴지통 삭제가 대표). 후속 (b): persist 의 로더가 모르는 레코드를 보존·건너뛰게 됐으므로(9b15d12) `MarkStale` jsonl 레코드 추가.
- **redo 후 지문 미갱신** (R2-sol-05): 복사 계열을 redo 한 뒤 원본이 그사이 바뀌었으면 다음 undo 는 "바뀜, 건너뜀"(데이터 안전). redo 결과 지문을 journal 에 다시 쓰려면 새 레코드가 필요 — 후속.
- **로컬 OS 휴지통(Windows/Linux)을 비운 뒤의 prune/3-way 복원**: `fs/local.rs` 가 "휴지통에 없음"을 `Io` 문자열로 줘서 Gone 으로 못 가르고 Error(맨 위가 막힘). local.rs 가 `NotFound` 를 주면 cleanup.rs 가 그대로 Gone 처리한다(후속, local.rs 소관). 단일 `RestoreFromTrash`(휴지통 삭제 undo)도 같은 이유로 비운 휴지통은 Error.
- **경쟁 창**: no-replace rename 은 확인 후 rename(짧은 TOCTOU). 원자적 no-replace(renameat2/renamex_np/MoveFileEx 무 REPLACE)는 fs/local.rs 소관 — 후속.
- **rsync 동기화(같은 호스트)**: 만든 폴더(created_dirs)를 모으지 못해 되돌리기 후 빈 폴더가 남을 수 있다.
- 지문 비용: 큰 폴더는 기록·undo 때 트리를 한 번씩 훑는다(원격은 항목마다 SFTP lstat). 정확성 문제 아님 — 후속으로 lstat 속성 포함 목록 API.
- 제외(brief): fileops-21(D-6), U-08/SC-02(D-7), SC-01, G-08, fileops-15 — 손대지 않음. fileops-15 repro 는 이번 변경으로 통과할 가능성 있음(확인 안 함, ignore 유지).

## 다른 팀 파일과 겹칠 수 있는 곳

- `src-tauri/src/services/journal.rs`: UndoAction 새 필드(`*_stamps`, `created_dirs`, `BackupRestore.applied`), `ItemStamp`, `JournalEntry.stale`, `peek_undoable`/`peek_redoable`/`mark_stale` + 테스트. **`read_tail`·`append`·`load_from` 은 건드리지 않았다**(persist 가 `read_tail` 삭제 — 충돌 없음 예상, `JournalEntry { … stale: false }` 리터럴 2곳만 확인).
- `src-tauri/src/core/ops.rs`: journal push 직전 지문 기록, `MirrorState.created_dirs`, merge/apply/3-way 의 SC-40 판정(`apply_state_changed`) — paths 팀의 plan/execute 진입부와는 떨어져 있음.
- `src-tauri/src/core/archive.rs`: 기록 줄 4개(`applied: None` ×2, `copied_stamps` ×2). `core/archive_review_opus.rs`: 해제 undo 테스트 2개(fixture 휴지통·"남김+Stale" 기대).
- `src/lib/fileActions.ts`: `triggerUndo`/`triggerRedo` 본문만. `src/i18n/ko.json`·`en.json`: 새 `undo.*`, `history.stale`, `notices.more` 사용, 옛 `toast.undone/redone/redoKind` 삭제.
- `src-tauri/tests/review_sync_compare_*.rs`(sync-compare 재현 테스트) 기대값·fixture, `tests/support/undo_fixture.rs` 새 파일.

## IPC·설정·저장 형식 변경

- IPC: `UndoOutcome` 에 `op`·`reason`·`skipped` 추가, `UndoKind` 에 `partial`·`stale`, 새 `UndoReason`·`UndoSkip`. `JournalEntry.stale`(serde default, 메모리 전용 표시). `JournalChangedEvent.change` 에 `"stale"`. → `pnpm gen:bindings` 필요.
- journal.jsonl: 필드 추가만, 전부 `serde(default)` — 구버전 줄 그대로 읽힘(지문 없음 = 확인 불가로 건너뜀). 새 레코드 종류 없음. 구버전 앱이 새 줄을 읽으면 모르는 필드는 serde 기본 동작상 무시.

## 기기 확인 필요

- Windows: NTFS 대소문자만 다른 이름 되돌리기(self_alias), 휴지통 비운 뒤 동기화 prune 되돌리기(Error 로 남는지), 드라이브 간(C:↔D:) 이동 되돌리기의 복사 폴백·남은 사본 휴지통.
- 실서버(SSH): 원격 복사·동기화·병합 되돌리기의 지문(SFTP 선택 속성, mtime 보존 여부 — 보존 안 하면 redo→undo 가 건너뜀), `~/.duet-trash` 이동, rsync 경로의 `applied` 지문, 연결 끊김 중 되돌리기(Error 후 재시도).
- 실앱: 토스트 문구·알림 상세(백업 위치), History "건너뜀" 배지, 재시작 후 History 순서.

## 게이트 결과

fix/undo `5fbf3eb` 에서 lead 가 실행(메인 지시로 마지막 실행은 heavy.sh 없이 직접, 동시 1개).
| 명령 | 결과 | fix/base 대비 |
| --- | --- | --- |
| `cargo fmt --check` | 통과 | — |
| `cargo clippy --all-targets -D warnings` | 실패 — 기준선 항목만: `tests/review_remote_opus_handle.rs:5`, `tests/review_remote_opus_chaos.rs:54,518,532`, `core/ops.rs:5821`(base 5656 의 review 테스트 `cp` too_many_arguments — 위에 줄이 늘어 이동), `fs/local.rs:637` | 기준선 실패, 변화 없음(메인 공지 제외 목록) |
| `cargo clippy --target x86_64-pc-windows-gnu --all-targets -D warnings` | 실패 — 위 기준선 + `core/archive_review_opus.rs` `opus2_tar`·`opus2_targz`·`opus2_rel` dead_code(Windows 에서 cfg(unix) 테스트만 씀) | dead_code 3건도 fix/base 에서 같은 실패 확인(임시 worktree, 993·1012·1021행) — archive 팀 파일 |
| `cargo test --lib` | 488 통과, 0 실패(102 ignored) | — |
| `cargo test --tests --no-fail-fast` | 39 바이너리 통과, 1 실패: `mvp2_smoke::smoke_copy_with_conflict_creates_backup_and_undo_restores`(undo 전, `.bak` 기대 단정 174행) | fix/base 에서도 같은 실패 확인(파일 Replace 는 §4 예외로 `.bak` 을 지움) |
| `pnpm gen:bindings` → `tsc --noEmit` | 통과 | — |
| `pnpm lint` | 통과 | — |
| `prettier --check .` | 실패 59파일 — 전부 우리가 바꾸지 않은 파일(docs·CLAUDE.md 등) | 기준선, 변경 파일 0 |
| `vitest run` (전체) | 142 파일 954 통과 | — |

## 라운드 기록

- **R1**: lead = 기반(결과 분류·stale, U-11/fileops-07) + U-10/fileops-22. opus = U-02 지문 기록(Part A) → 생성분 정리(Part B, `core/undo/cleanup.rs`) + SC-09·31·40. sol = fileops-20(Part A) → fileops-25·stale 표시(Part B). lead 판정: 전부 승인, 기대값 1건 갱신(01a4af2).
- **R2**: sol → opus 3커밋: 수정 요청 6(R2-sol-01 P1 하위 메타데이터 없는 폴더 지문, 02 부산물 이름 폴더, 03 빈 폴더 정리 오류 삼킴, 04 P1 휴지통 항목 사라짐이 스택 막음, 05 redo 후 지문, 06 SC-40 예정 경로). opus → sol 4커밋·lead 2커밋: 승인 + 경미 2(혼합 사유, undone+stale 취소선) + lead 수정 요청 2(부분 사본, 휴지통 실패가 Ok) + 질문 1(정규화). lead 리뷰: sol 토스트가 partial/stale 메모를 버림 → sol 수정(warning 으로 상세 보존). 처리: 05 는 한계로 기록, 나머지 전부 수정(opus 006cc18·ce0160c·8497bd5, sol 6e946a0·a4c314c·99794fa, lead 74e7b68).
- **R3**: sol → opus R2 수정: 승인 2, 수정 요청 1(깨진 부모 링크를 "휴지통 비움"으로 오판, P2) → lead 9d823af. opus → lead·sol R2 수정: sol 승인 2, lead 74e7b68 #1·#2 승인, #3 **P1 회귀**(다른 파일을 별칭으로 오판해 덮어쓰기) → lead 5fbf3eb. 라운드 한도로 이 두 수정은 재리뷰 없음.
- 지적 합계 14 (P1 3: R2-sol-01, R2-sol-04, R3 opus-4 #3). 처리 13, 한계로 기록 1(R2-sol-05).
- 인프라: heavy.sh 대기열이 샌드박스의 `kill -0` 실패로 남의 대기 항목을 지워 무한 대기(sol 보고, lead 2회) — to-main.md 로 알림, 메인이 고침.

## 커밋 목록

```
5fbf3eb be/core: only treat case or normalization spellings as the same item
9d823af be/core: treat a broken parent link as retryable in trash restore
8497bd5 be/core: decide SC-40 by what was actually created
ce0160c be/core: keep cleanup undo retryable on transient errors
006cc18 be/core: folder stamps never match on unknown child metadata
99794fa fe/ui: retain undone styling for stale history entries
a4c314c fe/lib: explain mixed undo skip reasons in notification details
74e7b68 be/core: clean up failed move-back copies and surface leftover copies
6e946a0 fe/lib: keep backend notes as detail for partial and stale undo results
01a4af2 test: expect Stale for a filled new-file undo
4b4875f fe/store: hide stale entries from the undo stack
de4bdfe fe/ui: describe undo results by operation and reason
3b8bdd2 fe/lib: extract journal op label
c346644 be/core: undo moves created items to trash only when unchanged
4683922 be/core: don't journal merge/apply/3-way that changed nothing before failing
72ee2d7 be/core: record item stamps in undo journal entries
7ee9452 be/core: undo/redo of rename and move never overwrite a new item
5995821 be/core: classify undo results and skip stale entries
8061c59 fe/hook: restore newest-last order when loading undo history
```
