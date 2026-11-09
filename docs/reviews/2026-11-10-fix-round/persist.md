# persist 수정 최종 보고

## 요약

- **P1 1건(U-03/G-02) + P2 3건(G-03 묶음·ss-03·ss-12) + P3 4건(SC-26·ss-18·remote-21·remote-22) 모두 고침.** 저장 파일 하나가 깨져도 앱이 켜진다: 깨진 파일은 `<이름>.corrupt-<시각>` 으로 보존하고 기본값으로 시작, 창이 뜬 뒤 경고 토스트로 알린다. 읽을 수조차 없으면 패닉 대신 오류 창(ko/en) 후 종료.
- 모든 store 저장이 원자적 쓰기(같은 폴더 tmp → fsync → rename)로 바뀌고, 저장이 실패하면 메모리도 그대로다(영구 삭제 허용이 몰래 켜지던 경로 차단). journal 은 잠금 안에서 한 번에 쓰고, 로드 때 깨진 줄만 버린다.
- 못 고친 것 없음. 위험: 시작 오류 창·keymap 감시·Windows rename 은 실앱/실기 확인 전(아래 "기기 확인 필요").
- 라운드 3회(R1 구현 → R2 교차 리뷰 지적 3건 → R3 수정). 게이트 실패는 모두 fix/base 기준선과 같다.

## 고친 것

| 이슈                                                       | 사용자에게 달라지는 점                                                                                                                                                                                                                                                                                                                | 커밋 (fix/persist)                                                                                                                                                         | 테스트                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-03 / G-02: fileops-01, shell-settings-01, remote-19 (P1) | journal·설정·키맵·북마크·호스트 등 13개 저장 파일 중 하나가 깨져도 앱이 켜진다. 깨진 원본은 `.corrupt-<시각>` 으로 남고 "기본값으로 시작했습니다 — 원본은 … 으로 보관" 경고 토스트(자세히에 경로·파싱 오류). 읽기 권한 없음 등 복구 불가면 오류 창(어느 저장소인지 + 설정 폴더 경로) 후 종료 — 예전엔 패닉, Windows 는 아무 창도 없음 | f5f69bc, a2a2f53 (헬퍼) · 859e5b8 (JSON 9종) · 49d93a2 (settings) · cd55b61 (keymap) · 9b15d12, 3398b9c (journal) · 639f5da (lib.rs/boot) · 8bbca42, 0277eb3 (알림 IPC·FE) | `review_shell_settings_boot.rs` 10건 ignore 제거 · `review_shell_settings_r2.rs` · `journal.rs::review_fileops_opus` 4건 · `saved_hosts.rs` · `review_remote_sol_r2.rs::corrupt_host_stores…` · 새 `fs::persist` 11, `services::boot` 3, `journal::load_recovery` 7, store별 손상 보존 8, `useStartupNotices.test.ts` 4 |
| fileops-01 (journal 동시 기록)                             | 작업 두 개가 동시에 끝나거나 기록 중 강제 종료돼도 journal 이 깨지지 않는다. 한 줄에 붙은 기록은 나눠 살리고, 새 버전이 쓴 모르는 기록은 파일에 보존                                                                                                                                                                                  | 9b15d12, 3398b9c                                                                                                                                                           | `concurrent_pushes_keep_every_line_parseable` 등 — 옛 append 로 되돌리면 385줄 손상으로 빨강(sol-2 실험)                                                                                                                                                                                                                |
| G-03: shell-settings-02 (P2), remote-22·remote-21 (P3)     | 저장이 실패하면 "실패" 토스트와 함께 메모리도 이전 값 — 다음 다른 설정 저장에 실패한 변경(영구 삭제 허용 등)이 섞이지 않는다. vault 동시 저장이 서로 덮지 않는다                                                                                                                                                                      | 49d93a2, cd55b61, 907f34a, e082248                                                                                                                                         | settings.rs 2건·`review_shell_settings_keymap.rs`·`bookmarks.rs` repro ignore 제거, `review_remote_sol_vault.rs` 2건, store별 `failed_saves_keep_memory_unchanged` 8건 — 되돌림 실험으로 빨강 확인(opus-2 3건, sol-2 2건)                                                                                               |
| (G-03 확장, R2 opus 지적)                                  | tags·host_nicknames 를 시작 때 읽지 못했으면(권한·잠금) 변경을 거부해 원본을 빈 맵으로 덮어쓰지 않는다                                                                                                                                                                                                                                | b6fc99b                                                                                                                                                                    | unix 0o000 재현 2건(수정 전 빨강)                                                                                                                                                                                                                                                                                       |
| shell-settings-03 (P2)                                     | 옛 SSH 북마크 이전에서 즐겨찾기 저장이 실패하면 북마크를 지우지 않고 경고(다음 실행에 재시도)                                                                                                                                                                                                                                         | 587b815                                                                                                                                                                    | `__review__/shell-settings-sidebar.test.tsx` ss-03 it.fails→it                                                                                                                                                                                                                                                          |
| shell-settings-12 (P2→P3)                                  | 실행 중 keymap.toml 을 잘못 저장하면 "이전 단축키를 계속 씁니다" 경고(같은 오류는 한 번)                                                                                                                                                                                                                                              | cd55b61, 0277eb3                                                                                                                                                           | `keymap_watcher::tests::same_error_is_reported_once…`                                                                                                                                                                                                                                                                   |
| shell-settings-18 (P3)                                     | 시작 직후 첫 외부 편집이 "전부 비우기"여도 반영. 앱 저장 도중 감시가 빈 파일을 읽는 틈 제거(원자적 쓰기). 감시의 늦은 옛 읽기가 최신 키를 되돌리지 않음(R2 sol 지적)                                                                                                                                                                  | cd55b61, 1a8e433                                                                                                                                                           | `reload_applies_external_clear_from_start`, `reload_interleaved_with_set_never_applies_a_stale_read`(수정 전 빨강)                                                                                                                                                                                                      |
| SC-26 (P3)                                                 | 구조가 깨진 검색 인덱스 캐시는 무시하고 다시 만든다(검색 panic 없음)                                                                                                                                                                                                                                                                  | f3c7fbc                                                                                                                                                                    | `review_sync_compare_sol.rs::index_structurally_corrupt_json_does_not_panic` ignore 제거, `file_index` 단위 1건                                                                                                                                                                                                         |

## 못 고친 것·부분 수정

- 없음.
- 정책 메모(의도된 한계):
  - journal 의 깨진 줄이 `MarkUndone` 이었다면 그 항목은 "안 되돌림"으로 보인다(앞의 정상 기록 전부를 잃는 것보다 낫다고 판단, 코드 주석).
  - settings.toml 은 필드 단위로 살리지 않는다 — 값 하나 타입이 틀려도 파일 전체를 보존하고 기본값(영구 삭제 꺼짐 = 안전 쪽).
  - 깨진 keymap.toml 은 **시작 시에만** 옮긴다. 실행 중 감시 재읽기는 파일을 건드리지 않는다(편집 중일 수 있음).
  - vault 는 시작 때 해독하지 않아 깨진 파일과 틀린 마스터 비번을 구분 못 한다 → 옮기지 않고 잠금 해제 실패로 닫힘(기존 동작).
  - frecency(캐시)는 깨지면 조용히 비우고 다음 기록 때 덮어쓴다(기존 동작, 쓰기만 원자적).
  - `.corrupt-*` 사본과 실패 시 남는 `.<이름>.tmp` 는 지우지 않는다(§3 — 삭제 금지, tmp 는 이름 고정이라 쌓이지 않음).

## 다른 팀 파일과 겹칠 수 있는 곳

- `src-tauri/src/services/journal.rs` — **undo 팀**. 우리는 `Journal` 구조체 필드(`writer`, `load_notice`), `load_from`, `append`, 새 `load_file/scan_lines/replay`, 테스트 모듈만 바꿨다. `peek_undoable/commit_undone/peek_redoable/commit_redone/history` 본문은 그대로(sol-2 가 문자열 비교로 확인). undo 팀이 `JsonlRecord` 에 새 variant 를 추가해도 로드는 문제없다(모르는 기록은 보존). `read_tail` 은 삭제됨 — undo 팀이 그것을 고쳤다면 충돌.
- `src-tauri/src/lib.rs` — 시작 로드 블록(13개 `.expect`)을 `services::boot::BootStores` 로 교체, `generate_context!()` 를 위로 옮김, `run_fatal`/`fatal_message` 추가, `collect_commands![... startup_notices_take]`, `collect_events![... KeymapLoadFailedEvent]`, `.manage(startup_notices)`. 다른 팀이 command/event 를 추가했으면 목록 끝에서 겹침(단순 병합).
- `src-tauri/src/services/bookmarks.rs` — shell-settings-20(`reorder` 중복 id)은 다른 팀 몫이라 로직 그대로, 사본 패턴만 적용. 같은 함수를 고친 팀이 있으면 충돌(`let mut v = current.clone()` 구조).
- `src-tauri/src/services/file_index.rs` — `CompactIndex` impl 과 `load_from_disk` 만. SC-25(캐시 파일명)를 고치는 팀과 같은 파일.
- `src-tauri/tests/review_sync_compare_sol.rs`, `review_remote_sol_r2.rs` — `#[ignore]` 한 줄씩만 제거.
- `src/components/__review__/shell-settings-sidebar.test.tsx` — ss-03 의 `it.fails` → `it` 한 단어. 이 파일은 fix/base 부터 prettier 미적용 상태라 일부러 재포맷하지 않았다.
- `src/i18n/{ko,en}.json` — `toast.*` 4키(`startupFileReset`, `startupLinesSkipped`, `keymapLoadFailed`, `bookmarksMigrateFailed`), `notices.*` 2키(`file`, `backup`). 같은 위치 주변을 고친 팀과 인접 줄 충돌 가능.
- `src/App.tsx` — import 1줄 + `useStartupNotices();` 1줄(`useKeymapEvents();` 다음).
- `src-tauri/src/fs/mod.rs`, `services/mod.rs`, `commands/mod.rs` — `pub mod` 한 줄씩.

## IPC·설정·저장 형식 변경

- 새 command `startup_notices_take() -> Result<Vec<StartupNotice>, DuetError>` (한 번 꺼내면 비움). 새 타입 `StartupNotice { file, action: {kind:"reset", backup} | {kind:"skipped_lines", count, backup?}, detail }`.
- 새 event `KeymapLoadFailedEvent { message }` (`keymap-load-failed-event`).
- `pnpm gen:bindings` 필요(bindings.ts 는 gitignore).
- 저장 형식(JSON/TOML/jsonl/age) 변경 없음. 디스크에 새로 생길 수 있는 파일: `<이름>.corrupt-<YYYYMMDD-HHMMSS>[-n]`(보존 사본), `.<이름>.tmp`(쓰기 실패 시 잔여). vault 임시 파일 이름이 `secrets.age.tmp` → `.secrets.age.tmp` 로 바뀜(옛 이름 잔여물이 있어도 무해).

## 기기 확인 필요

- **실앱**: 시작 오류 창 — 설정 폴더의 파일 하나를 읽기 불가(권한 0)로 만들고 실행 → 오류 창(ko/en, 저장소 이름·폴더)이 뜨고 앱 UI 창은 없으며, 확인을 누르면 종료되는지. 코드는 Tauri 2.11.1 소스로 확인(설정 창은 setup 전에 생성 → setup 에서 destroy, `RunEvent::ExitRequested{code: None}` 만 prevent_exit).
- **실앱**: 깨진 settings.toml/keymap.toml/journal.jsonl 로 시작 → 경고 토스트와 `.corrupt-*` 사본, 알림 "자세히"의 경로·오류.
- **실앱**: keymap.toml 을 외부 편집기로 연속 저장 → 단축키가 마지막 저장본과 일치, 잘못 저장 시 경고 한 번(notify 백엔드별 rename 이벤트 — macOS FSEvents / Windows ReadDirectoryChangesW / Linux inotify).
- **Windows 실기**: `write_atomic` rename 이 대상 파일을 다른 프로그램(편집기·백신·동기화)이 열고 있을 때 실패할 수 있다 — 실패해도 이제 메모리 불변 + 저장 실패 토스트(안전 쪽). Windows 크로스 clippy 는 통과(우리 파일 경고 없음).
- **Windows 실기**: 콘솔 없는 릴리스 빌드에서 깨진 파일로 시작 시 창이 뜨는지(U-03 의 원래 증상).

## 게이트 결과 (fix/persist `b6fc99b`)

| 명령                                                                    | 결과                                                                                                                          | fix/base 대비                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo fmt --check`                                                     | 통과                                                                                                                          | —                                                                                                                                                                                                                                                                                                                                            |
| `cargo clippy --all-targets -D warnings`                                | 실패 — `core/ops.rs:5656`, `fs/local.rs:637`, `tests/review_remote_opus_chaos.rs:54,518,532` 만                               | 기준선 실패, 변화 없음(메인 공지 목록). 우리 파일 경고 0                                                                                                                                                                                                                                                                                     |
| `cargo clippy --target x86_64-pc-windows-gnu --all-targets -D warnings` | 실패 — 위 목록 + `tests/review_remote_opus_handle.rs:5` + `core/archive_review_opus.rs:993,1012,1021`(Windows 전용 dead_code) | 기준선. `archive_review_opus.rs` 는 우리 브랜치가 건드리지 않은 archive 팀 파일(메인 공지 목록엔 없음 — 참고). 우리 파일 경고 0. `--lib` 한정은 macOS·Windows 모두 통과                                                                                                                                                                      |
| `cargo test --lib`                                                      | 통과 — 502 passed, 101 ignored(다른 팀 repro)                                                                                 | —                                                                                                                                                                                                                                                                                                                                            |
| `cargo test --tests --no-fail-fast`                                     | 594 passed, **1 failed**: `mvp2_smoke::smoke_copy_with_conflict_creates_backup_and_undo_restores`                             | 기준선 실패. 테스트가 Replace 후 `.bak` 을 기대하나 CLAUDE.md §4(2026-06 예외)로 Replace 는 백업을 남기지 않는다 — undo 전 단계에서 실패. 우리 브랜치는 `src-tauri/src/core/`·이 테스트 파일을 바꾸지 않음(`git diff fix/base..HEAD -- src-tauri/src/core` 비어 있음). undo 팀도 `_fix/undo/reports/opus-1.md:21` 에 같은 기준선 실패를 기록 |
| `pnpm gen:bindings && tsc --noEmit`                                     | 통과                                                                                                                          | —                                                                                                                                                                                                                                                                                                                                            |
| `pnpm lint`                                                             | 통과                                                                                                                          | —                                                                                                                                                                                                                                                                                                                                            |
| `prettier --check .`                                                    | 실패 — 60개 파일                                                                                                              | 기준선. 우리가 바꾼 파일 중 목록에 있는 것은 `__review__/shell-settings-sidebar.test.tsx` 하나, fix/base 에서 이미 미포맷(일부러 재포맷 안 함 — 다른 팀 충돌 방지). 새로 만든·고친 FE 파일은 prettier 통과                                                                                                                                   |
| `vitest run`                                                            | 통과 — 142 files, 924 tests                                                                                                   | —                                                                                                                                                                                                                                                                                                                                            |

## 라운드 기록

- **PLANNING/기반 (lead)**: 공통 헬퍼 `fs::persist`(원자적 쓰기·격리 로드·사본), `StartupNotice` + `startup_notices_take` IPC, `KeymapLoadFailedEvent` 를 먼저 커밋해 두 워커가 같은 계약 위에서 작업. sol 이 R1 중 `NotADirectory` 를 기본값으로 처리해 달라고 요청 → 헬퍼 수정(a2a2f53) 후 양쪽에 공지.
- **R1**: opus — journal·settings·keymap(+watcher)·vault 4커밋. sol — JSON store 9종 2커밋(복구·원자적 저장 / 저장 실패 시 메모리 불변). lead — ss-03, SC-26, 알림 FE, lib.rs 시작 경로. 워커 모두 repro 를 수정 전 빨강으로 확인. lead 가 커밋을 직접 읽고 전부 승인 후 cherry-pick.
- **R2 (교차 리뷰)**: sol→opus: 승인 2(settings, vault), 수정 요청 2(journal 줄 안 잘못된 UTF-8 이 U+FFFD 로 재생 / keymap 감시의 늦은 옛 읽기가 최신 값을 되돌림), 되돌림 실험 2개 모두 빨강. opus→sol: 승인 2, 질문 3(Q1 tags/nicknames 읽기 실패 후 덮어쓰기 — 수정 대상으로 채택, Q2·Q3 의도된 동작 확인: frecency 저장 결과는 FE 가 무시해 토스트 폭주 없음), 되돌림 실험 3개 모두 빨강.
- **R3**: opus — 지적 2건 수정(3398b9c, 1a8e433, 새 테스트 수정 전 빨강 확인). sol — Q1 수정(b6fc99b, 수정 전 빨강 확인). lead 리뷰 후 승인·통합. 남은 지적 0.

## 커밋 목록 (`git log --oneline fix/base..fix/persist`)

```
b6fc99b be/svc: refuse to overwrite tags/nicknames files that could not be read
1a8e433 be/svc: re-read keymap.toml under the store lock in the watcher
3398b9c be/svc: drop journal lines with invalid UTF-8 instead of replaying them
639f5da be/cmd: boot without panicking when a saved file is broken or unreadable
e082248 be/svc: keep store memory unchanged when a save fails
907f34a be/svc: vault saves under lock and commits memory after write
cd55b61 be/svc: keymap atomic save, recovery and load-failure event
49d93a2 be/svc: settings atomic save and corrupt-file recovery
9b15d12 be/svc: make journal appends atomic and skip corrupt lines on load
859e5b8 be/svc: recover corrupt JSON stores and save them atomically
0277eb3 fe/hook: show startup file-recovery notices and keymap load failures
8bbca42 be/cmd: return Result from startup_notices_take like other commands
f3c7fbc be/svc: ignore structurally broken search index caches
587b815 fe/store: keep legacy SSH bookmarks when favorite migration fails
a2a2f53 be/fs: treat a path under a regular file as missing on load
f5f69bc be/fs: add atomic write and quarantine-on-corrupt load helpers
```
