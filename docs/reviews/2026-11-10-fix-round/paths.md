# paths 수정 최종 보고

## 요약

- **P1 3건(U-04/G-04, U-13/G-05, U-12/fileops-05 최소안), P2 1건(fileops-19), test-infra 1건(remote-35)을 고쳤다.** 브랜치 `fix/paths`, `fix/base` 위 선형 31커밋.
- 폴더를 자기 자신·하위로 복사/이동/동기화/압축하는 경로를 백엔드 plan·execute 양쪽에서 막는다. Windows 클라이언트에서 원격 경로에 `\` 가 끼던 결합·인용을 POSIX 규칙으로 바꿨다. 같은 IP 다른 포트·점프 경로의 서버를 "같은 서버"로 보지 않게 했다.
- 못 고친 것은 범위 밖으로 남긴 native 경로 지점(아래 목록)뿐이다.
- 위험:
  - 새 오류 variant `DuetError::IntoItself` 가 생겼다(bindings).
  - `ops.rs`·`archive.rs`·`compare.rs`·`fs/ssh.rs`·`error.ts` 는 다른 팀 파일과 겹친다.
  - Windows 원격 동작은 실기 확인 전이다(교차 컴파일 + macOS 에서 결합 규칙 주입 테스트로만 확인).

## 고친 것

### U-04 / G-04 (P1) — fileops-04, SC-03, browse-14, archive-22

- **사용자에게 달라지는 점:** 폴더를 자기 자신이나 하위 폴더로 복사·이동·sync·merge·apply·3-way 하거나, 압축 결과를 선택한 폴더 안/선택 항목 자리로 만들면 시작 전에 거부되고 토스트가 뜬다.
  - ko: "폴더를 자기 자신이나 그 하위 폴더 안으로 복사·이동·동기화할 수 없습니다."
  - 예전에는 무한 증식하거나 원본이 휴지통으로 가거나 기존 아카이브가 훼손됐다.
  - FE 에서는 붙여넣기·드래그(창 끼리, 사이드바 북마크 포함)도 하위 폴더 전체를 막는다(기존 `toast.pasteIntoSelf`).
- **백엔드:**
  - 새 `core/path_guard.rs`:
    - 로컬은 canonicalize 한다. 아직 없는 경로는 `..` 를 지우지 않고 처음 canonicalize 되는 조상부터 꼬리를 한 칸씩 붙인다(R3). 항목 자체가 링크면 링크로 비교한다.
    - 원격은 같은 서버(endpoint)일 때만 POSIX lexical 로 비교한다.
  - 호출처:
    - `plan_transfer`/`copy_execute`/`move_execute`
    - `sync_plan`/`sync_execute`/`sync_preview`/`merge_bidir`/`apply_compare`/`apply_three_way`
    - `archive::compress_plan`/`compress_execute`
  - 보조 방어: `fs::copy_tree` 가 원본 목록을 mkdir 전에 확정한다.
- **커밋:** ced9917, 3075e70, f6782b9, ef19678, cb1b9b1, 8286c38, a3bde20, 97c4942, 4c192eb, 88b75a4 (BE) / 756b96a, 8a8a799 (FE).
- **테스트:**
  - ignore·it.fails 해제:
    - `c02_*`, `r2_copy_into_child_*`
    - `review_sync_compare_xcheck_opus::merge_parent_and_child_*`, `review_sync_compare_r3_sol::sc03_*`
    - archive_review_opus/sol 기대 반전
    - FE `fileops-sol-descendant`, `browse-dnd-guard`, `browse-sol2-state`(browse-14), `fileops-opus-r2-explain`
  - 새 테스트:
    - `nested_roots_guard::*`(위조 plan 의 execute 거부 포함)
    - `path_guard` 단위 테스트 10개(심볼릭 링크 뒤 `..` 회귀 포함)
    - `nesting.test.ts`
  - 전부 수정 전 빨강을 확인했다.

### U-13 / G-05 (P1) — remote-01, remote-17, archive-05/27, ss-09, SC-30, SC-47, SC-51, fileops-33 일부

- **사용자에게 달라지는 점:** Windows 에서 원격 서버의 파일을 다룰 때 경로에 `\` 가 끼어 엉뚱한 파일을 복사·덮어쓰거나 부모 폴더에 찌꺼기 파일을 만들던 문제가 없어진다. 해당 기능:
  - same-host 복사/이동, KeepBoth 이름
  - relay 경로, 압축 탐색/repack
  - Places/볼륨, 다운로드 이름
  - 체크섬, 업로드 임시 파일 `.duet-part`/`.duet-old`
- 이름에 `\` 가 든 원격 파일은 이름 그대로 다룬다. 예전에는 `shell_escape_path` 가 `\`→`/` 로 바꿔 다른 파일을 지목했다(remote-01).
- **바꾼 것:**
  - 새 `fs/posix_path.rs`(parent·file_name·join_for).
  - `shell_escape_path` 는 인용만 한다.
  - 원격 결합은 각 쪽 `fs.join`, 원격 부모·이름은 POSIX 로 처리한다:
    - ops: dedup_dst_name, relay, rsync/backup/progress, count_files
    - archive.rs ~769·~1044
    - system.rs Places·볼륨·download
    - fs/mod.rs `sibling_with_suffix`
  - SC-47: 체크섬과 same-host verify·이동 감지 해시를 stdin 으로 넘긴다(`sha256sum < 'f'`). 그래서 `\`·개행 이름이 digest 토큰을 바꾸지 않는다.
- **커밋:** 7db24bb, ceb9bc8, d44475b, f100b70, 6578d08, 4373e22, 7203eb3, 8329076, 317cfe3, c159325, 66bccac, 3eefe3c, e8ff6d9.
- **테스트:**
  - copy_strategy 인용 기대 반전, archive_review_lead/sol 반전, system.rs, SC-47·SC-51 통합 테스트.
  - `remote17_*`, 기록형 fs 로 "dst_fs 결합 규칙을 쓰는지" 검사(macOS 에서도 빨강 → 초록).
  - **Docker IT(격리 HOME):** remote-01 재현 4건 + `ssh_it_same_host_copy` 8건 통과(최종 트리에서 재실행).
  - remote-01 ignore 사유는 "docker 필요"로 바꿨다(e8ff6d9).

### U-12 / fileops-05 (P1 최소안)

- **사용자에게 달라지는 점:** IP 가 같아도 포트나 ProxyJump 경로가 다른 두 연결(다른 서버)을 "같은 서버"로 보고 서버 안 `cp` 를 실행하던 문제를 막았다. 이제는 Relay 로 복사한다. 비교 다이얼로그의 전략 배지도 같은 규칙을 따른다.
- **바꾼 것:**
  - 백엔드 전용 `ServerEndpoint{ip,port,via}` 를 `ActiveConnection`·`FileSystem::endpoint()` 에 둔다.
  - `copy_strategy::decide_fs` 는 알려진 endpoint 가 같을 때만 SshSameHost 로 판정한다. user 가 달라도 허용(ARCHITECTURE 유지).
  - ops 의 모든 decide 호출부와 `compare.rs:234`(메인 승인)를 교체했다.
  - execute 에서 다시 검사한다: plan 이 더 이상 endpoint 와 맞지 않으면 거부한다.
- **커밋:** ca50e62, 5ce13eb, 082621b, 204fa05.
- **테스트:**
  - 다른 포트·다른 점프 경로 → Relay.
  - planning/preview/merge/apply/verify/rename-detection, 위조 same-host execute 거부.
  - `compare_uses_endpoint_aware_strategy`.

### fileops-19 (P2)

- **사용자에게 달라지는 점:** 이름 바꾸기·일괄 이름 바꾸기에서 `/`·`\`·`..`·예약 이름 등 그 파일시스템에서 무효한 이름은 거부되고 미리보기에 표시된다. Windows 에서 `..\x` 로 폴더 밖으로 옮겨지던 문제가 없어진다.
- **커밋:** 37577da.
- **테스트:** `c06_*`, `c07_*`, `r2_batch_preview_flags_backslash_names`, `r2_windows_rename_with_backslash_stays_in_folder`(Windows clippy 로 컴파일만), `batch_rename_name_validation::*`.

### remote-35 (test-infra)

- `scripts/ssh-it.sh` 가 `src-tauri/tests/fixtures/ssh/it-home`(gitignore)을 HOME 으로 쓴다.
- known*hosts 는 컨테이너 호스트 키(`docker compose exec ... cat /etc/ssh/ssh_host*\*\_key.pub`)로 시드한다.
- `CARGO_HOME`/`RUSTUP_HOME` 은 고정하고 `SSH_AUTH_SOCK` 은 해제한다. 사용자 `~/.ssh/known_hosts` 를 건드리지 않는다. README 주의 1줄.
- **커밋:** 68525ed.

## 못 고친 것·부분 수정

- **범위 밖으로 남긴 native 원격 경로 지점** — G-05 와 같은 종류이며, Windows 클라이언트 + 원격일 때만 해당한다. 소유 팀이나 후속 작업에서 POSIX helper(`fs::posix_path`)나 `fs.join` 으로 바꾸면 된다.
  - `core/archive.rs:236-246, 946-956`(extract/compress 충돌 백업 parent/file_name), `:846-854`(원격 browse reap 검사) — archive 팀
  - `core/undo.rs`, `core/sudo.rs`, `core/search.rs`, `fs/ssh.rs` 휴지통 parent, file_index, edit_session
  - FE `entryDnd`·`pathCrumbs`·`newEntry`
- **SSH 새 이름에 `\` 금지:** rename/batch 가 mkdir/create 와 같은 validator 를 쓰므로 원격에서도 `\` 든 **새** 이름은 거부한다. FE 도 이미 거부한다. 기존 `\` 이름 파일을 다루는 것은 된다. 의도된 한계다.
- **batch rename:** 무효 이름이 미리보기에서 "충돌"과 같은 모양으로 표시된다. 사유를 구분해 표시하는 것은 후속.
- **copy_tree 보조 방어의 범위:** 같은 SourceId + 같은 경로 문자열만 잡는다(주석에 명시). 같은 서버 다른 연결·링크 alias 는 path_guard 가 주 방어다.
- **원격 심볼릭 링크로 하위를 가리키는 경우:** path_guard 는 원격을 lexical 로만 비교해 네트워크 왕복을 추가하지 않으므로 못 잡는다.
- **SC-47 셸 문법:** 명령이 `if command -v …; then …; else …; fi` POSIX sh 문법이다. 로그인 셸이 fish 인 서버에서는 기존 명령들과 마찬가지로 실패할 수 있다(이번 변경으로 새로 생긴 제약 아님).
- **SC-47 통합 테스트 취약성:** `include_str!` 로 `fs/ssh.rs` 소스 줄을 파싱하므로 포맷 변경에 약하다. lib 단위 테스트로 옮기는 것은 후속.
- **U-12 최소안의 한계:** SourceId(IPC)는 그대로라 FE 가 SourceId 만으로 판단하는 곳은 여전히 IP·user 만 본다. 실행 경로와 비교 다이얼로그 배지는 백엔드 `decide_fs` 를 따른다.

## 다른 팀 파일과 겹칠 수 있는 곳

- `src-tauri/src/core/ops.rs` — undo·browse 팀.
  - 우리 변경: 각 plan/execute **진입부** 가드 줄, `decide`→`decide_fs` 호출부, dedup_dst_name, relay 결합, rsync/backup/progress 의 POSIX parent/basename, verify/sigs same-host 해시 명령(`same_host_hash_command` 신설), rename/batch validator.
  - browse 팀의 `apply_compare`·`merge_bidir` `resolve_side_rel` 줄은 건드리지 않았다(메인 공지).
- `src-tauri/src/core/archive.rs` — archive 팀. 우리 변경은 `compress_plan`/`compress_execute` 진입부, ~769(`join_for`), ~1044(`fs.join`).
- `src-tauri/src/core/compare.rs:234` — browse 팀. `decide_fs` 한 줄과 import(메인 승인, 별도 커밋 204fa05).
- `src-tauri/src/fs/ssh.rs` — browse 팀(범위 읽기 ~508 은 안 건드림). 우리 변경은 체크섬 명령과 `endpoint()` 구현.
- `src-tauri/src/fs/mod.rs`:
  - `copy_tree`(목록 선확정·skip·주석)
  - `sibling_with_suffix` 시그니처 변경. dst_fs 를 받으며 `core/elevate.rs` 두 호출부는 `LocalFs` 로 맞췄다.
  - trait 기본 메서드 `endpoint()`, `pub mod posix_path`.
- `src/lib/error.ts`, `src/i18n/{ko,en}.json` — errors 팀. `Reason` 에 `intoItself`, KIND_REASON 1줄, `errors.reason.intoItself`(메인 승인, 별도 커밋 8a8a799).
- `src/hooks/useEntryDrag.ts`, `src/lib/fileActions.ts`(clipPaste), `src/lib/selfDrag.ts` — browse/fileops 쪽 FE. 우리 변경은 `isSameOrInside` 호출만.
- `services/connection_pool.rs`, `services/connection_supervisor.rs`, `commands/connection.rs` — endpoint 필드 채우기(메인 승인).
- `src-tauri/src/fs/testing.rs` — TestFs 에 `override_join`·`endpoint`·`list_entries` 필드를 추가했다(다른 팀 테스트가 `TestFs::new` 를 쓰면 영향 없음).

## IPC·설정·저장 형식 변경

- **IPC:**
  - `DuetError` 에 새 variant `IntoItself(String)`(kind `"IntoItself"`). `pnpm gen:bindings` 가 필요하다.
  - FE 매핑(`error.ts` KIND_REASON, i18n)은 같은 브랜치에 들어 있다(8a8a799).
  - 그 외 command 시그니처·타입 변경 없음.
  - `ServerEndpoint` 는 백엔드 전용이며 specta 로 내보내지 않는다.
- **설정·journal·저장 형식:** 변경 없음.
- **원격 임시 파일 위치:** `.duet-part`/`.duet-old` 는 이제 Windows 에서도 대상과 같은 원격 폴더에 생긴다. 이전 버전이 부모 폴더에 남긴 `dst\a.txt.duet-part` 같은 찌꺼기는 재개 대상으로 인식되지 않는다(처음부터 다시 전송).

## 기기 확인 필요

- **Windows 실기 + 원격 SSH:**
  - 업로드·재개·기존 파일 교체 시 `.duet-part`/`.duet-old` 가 같은 원격 폴더에 생기는지.
  - KeepBoth 이름 `a (1).txt` 가 같은 폴더에 생기는지.
  - `\` 든 원격 이름의 same-host 복사.
  - 압축 탐색/repack, Places·볼륨 경로.
- **Windows 실기 로컬:**
  - path_guard 의 canonicalize(`\\?\` verbatim) 경로에서 꼬리 `pop`/`push`, 대소문자·`C:/a` vs `C:\a\` 표기에서 하위 복사가 거부되는지.
  - `..\x` 이름 바꾸기 거부.
  - 심볼릭 링크 테스트는 cfg(unix) 라 Windows 에서는 돌지 않는다.
- **실앱:**
  - 하위 폴더로 붙여넣기·드래그·사이드바 북마크 드롭 시 토스트 문구(ko/en).
  - sync/merge/compare 거부 토스트.
  - 같은 IP 다른 포트 두 연결 간 복사가 Relay 로 표시·동작하는지.
- **실서버:**
  - GNU coreutils 없는 서버(BSD/macOS)에서 `shasum -a 256 < f` 분기.
  - 로그인 셸이 fish 인 서버.

## 게이트 결과 (최종 `fix/paths` 88b75a4, heavy.sh 없이 순차 직접 실행 — 메인 공지)

| 명령                                                                    | 결과                                                                                                                                                                                                       | fix/base 대비                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cargo fmt --check`                                                     | 통과                                                                                                                                                                                                       | —                                                                                                                                                                                                                                    |
| `cargo clippy --all-targets -D warnings`                                | 실패(101) — **기준선 실패, 변화 없음**: `review_remote_opus_chaos.rs:54,518,532`, `core/ops.rs:5756`(base 5656 의 같은 review 헬퍼, 줄 이동만), `fs/local.rs:637`(안 건드림)                               | 새 경고 0                                                                                                                                                                                                                            |
| `cargo clippy --target x86_64-pc-windows-gnu --all-targets -D warnings` | 실패(101) — **기준선 실패, 변화 없음**: `review_remote_opus_handle.rs:5`, `ops.rs:5756`, `local.rs:637`, `archive_review_opus.rs:973,992,1001` dead_code(Windows 전용, archive 팀 review 파일·우리 미변경) | 새 경고 0                                                                                                                                                                                                                            |
| `cargo test --lib`                                                      | 통과 — 497 passed, 0 failed, 96 ignored(three_way flake 도 이번엔 통과)                                                                                                                                    | —                                                                                                                                                                                                                                    |
| `cargo test --tests --no-fail-fast`                                     | 실패(101) — `mvp2_smoke::smoke_copy_with_conflict_creates_backup_and_undo_restores` 1건만                                                                                                                  | **기준선 실패**: `git archive fix/base` 사본에서 같은 줄(mvp2_smoke.rs:174 "should have one .bak.\* file")로 실패 확인. CLAUDE.md §4 "Replace 영구 덮어쓰기" 예외 이후의 낡은 기대값, 우리 미변경. 나머지 통합 테스트 타깃 전부 통과 |
| `pnpm gen:bindings`                                                     | 통과                                                                                                                                                                                                       | —                                                                                                                                                                                                                                    |
| `pnpm exec tsc --noEmit`                                                | 통과                                                                                                                                                                                                       | —                                                                                                                                                                                                                                    |
| `pnpm lint`                                                             | 통과                                                                                                                                                                                                       | —                                                                                                                                                                                                                                    |
| `pnpm exec prettier --check .`                                          | 실패 — 57파일, **기준선 실패**. 우리 diff 중 해당은 `src-tauri/tests/fixtures/ssh/README.md` 하나뿐이며, 그 표 서식이 fix/base 에서 이미 prettier 불일치(우리는 "## 주의" 아래 한 줄만 추가)               | 목록 변화 없음                                                                                                                                                                                                                       |
| `pnpm exec vitest run --minWorkers=1 --maxWorkers=2`                    | 통과 — 142 files / 926 tests                                                                                                                                                                               | —                                                                                                                                                                                                                                    |
| Docker IT(`ssh-it.sh` 와 같은 HOME 격리, 2222+2225)                     | 통과 — remote-01 재현 4건 + `ssh_it_same_host_copy` 8건                                                                                                                                                    | fix/base 에선 remote-01 4건 실패(재현)                                                                                                                                                                                               |

## 라운드 기록

- **PLANNING (lead):**
  - plan.md 를 작성하고 파일 소유를 나눴다(ops.rs R1 은 opus 단독, sol 의 ops.rs 몫은 R2).
  - to-main 에 Q1(IntoItself 문구)과 고지 2건을 올렸고, 메인이 (b) 직접 추가 + 고지 승인 + compare.rs:234 로 답했다.
- **R1:**
  - opus: U-04 백엔드(path_guard, copy/move/sync/merge/apply/3-way/compress 가드, copy_tree), fileops-19 — 6커밋.
  - sol: posix_path, archive·system 결합, 인용 변경, SC-47, ServerEndpoint, decide_fs — 7커밋. 원격 native 경로 전수 목록도 작성.
  - lead: FE nesting 가드(browse-14/fileops-04), IntoItself 문구, ssh-it.sh(remote-35).
  - lead 가 전부 판정·통합했다.
  - lead 추가 수정: 항목 심볼릭 링크를 링크 자체로 비교(8286c38). 원래는 링크 대상을 따라가 정상 이동까지 막았다.
- **R2:**
  - sol: ops.rs 몫 6커밋(remote-17, SC-51, POSIX parent/basename, decide_fs 호출부 + execute 재검사, path_guard 양쪽 fs, compare.rs:234).
  - opus 의 sol R1 리뷰: 7커밋 승인. 수정 요청 1(dedup_dst_name — sol R2 에서 이미 처리), 제안 3.
  - sol 의 opus R1 리뷰: 승인 4, 수정 요청 1(없는 경로의 symlink/`..` 정규화), 질문 2(copy_tree 범위, SSH 새 이름 `\`).
  - lead: 통합 상태에서 Docker IT(remote-01 4/4, same-host 8/8)를 돌리고 remote-01 ignore 사유를 정리했다(e8ff6d9).
  - lead 가 추가로 발견: `sibling_with_suffix` 의 native `with_file_name` 이 Windows 원격 임시 파일을 부모 폴더에 만든다 → sol R3 에 배정.
- **R3:**
  - opus: symlink 뒤 `..` 정규화(꼬리 재-canonicalize 까지), POSIX join 테스트, copy_tree 주석 — 3커밋.
  - sol: `.duet-part`/`.duet-old` 원격 결합, verify/sigs stdin 해시, 볼륨 행동 테스트, posix file_name 문서 — 4커밋.
  - lead 가 7커밋 모두 읽고 승인했다. 확인한 것:
    - 해시 명령 `&&` 연쇄 시 부분 출력 처리(verify 는 exit 0·2줄, sigs 는 줄 수 불일치면 감지 생략)
    - 후보 수 상한
    - path_guard 꼬리 처리의 `..`·상대경로·없는 이름 pop
- **리뷰 지적 처리:**
  - 수정 요청 2건 모두 처리(dedup_dst_name, symlink/`..`).
  - 질문 2건 판정(copy_tree 는 주석 정정, `\` 새 이름은 한계로 기록).
  - opus 제안 3건 반영(SC-47 stdin 확장, 볼륨 행동 테스트, file_name 문서). SC-47 IT 소스 파싱은 후속.
- **운영:** heavy.sh 구버전 대기열 문제로 opus 작업이 멈췄다 → lead·메인이 끊고 재실행했다. 이후 메인 공지대로 직접 실행했다.

## 커밋 목록 (`git log --oneline fix/base..fix/paths`)

```
88b75a4 be/fs: state the exact scope of copy_tree's self-copy skip
4c192eb test: build SSH paths with POSIX join in path_guard tests
97c4942 be/core: resolve symlinks before dot-dot in nested-path guard
3eefe3c docs: note POSIX file_name returns dot-dot as-is
66bccac test: cover remote volume path joins
c159325 be/core: hash same-host files via stdin in verify and rename detection
317cfe3 be/fs: build remote temp-file siblings with the destination fs
e8ff6d9 test: keep remote-01 docker repros as regression tests
204fa05 be/core: compare dialog uses endpoint-aware strategy
a3bde20 be/core: compare nested paths only on the same server
082621b be/core: decide same-host from server endpoints in ops
8329076 be/core: use POSIX parent and basename for remote paths
7203eb3 be/core: join relay paths with each side's fs
4373e22 be/core: name KeepBoth candidates with the destination fs join
8286c38 be/core: compare a moved symlink as the link itself
5ce13eb be/core: require matching known endpoints for same-host copy
ca50e62 be/svc: record server endpoint per connection
6578d08 be/fs: checksum remote files without name escaping
f100b70 be/core: quote remote paths without rewriting backslashes
d44475b be/cmd: preserve POSIX remote places and file names
ceb9bc8 be/core: build remote archive paths with POSIX join
7db24bb be/fs: add POSIX remote path helpers
37577da be/core: validate names in rename and batch rename
cb1b9b1 be/core: reject compress whose output is in the selection
ef19678 be/fs: copy_tree lists source before creating destination
f6782b9 be/core: reject sync/merge/apply between nested roots
3075e70 be/core: reject copy/move into own subfolder
ced9917 be/core: add nested-path guard and IntoItself error
68525ed test: run ssh-it.sh with an isolated HOME and seeded known_hosts
8a8a799 fe/lib: explain IntoItself errors
756b96a fe/lib: block paste and drops into a folder's own subfolders
```
