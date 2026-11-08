# sync-compare 점검 최종 보고

## 요약

- **비교 화면·검색은 대체로 동작하지만, 동기화와 "되돌리기"의 데이터 안전에 구멍이 있다.** 이슈 52건: **P1 4 · P2 21 · P3 27**. 3라운드 교차 검토에서 P1·P2 판정은 모두 두 워커가 독립 재현으로 동의했다(이견 1건은 lead 판정으로 정리).
- 가장 중요한 것: **동기화(Sync)** 의 세 가지 경로가 "Ctrl+Z 로 되돌릴 수 있다"는 약속(CLAUDE.md §4)을 깬다 —
  ① 도중에 실패·취소하면 되돌리기 기록이 아예 없음(SC-01), ② 삭제 전파를 켜면 자기 덮어쓰기 백업을 휴지통으로 보내 Ctrl+Z 가 "성공"이라면서 복원 못 함(SC-02),
  ③ 부모/자식 폴더끼리 동기화·병합·적용하면 자기 안으로 무한 복사하거나 원본 폴더를 휴지통으로(SC-03).
  그리고 ④ 비교 적용·병합·동기화·복사의 Ctrl+Z 가 그 뒤 사용자가 고친 내용·추가한 파일까지 휴지통 없이 영구 삭제(SC-04, §3).
- 사용자(Windows 주 사용, 한글 파일명) 관련: 로컬↔원격은 동기화가 아예 안 되고 영문 개발자 문장만 보임(SC-15), 로컬↔원격 비교는 허용오차 기본 0 이라 같은 파일이 "덮어쓰기"로 미리 잡힘(SC-11),
  CRLF/LF 만 다른 파일이 전부 다르게 보임(SC-22), CP949 파일 미리보기가 조용히 잘림(SC-21), 한글 NFC/NFD 이름 불일치(SC-17).

## 점검 범위

`coverage.md` 의 C-01~C-27 전체를 점검했다(빈 칸 없음). 확인 방법은 Rust tempdir 재현 테스트 · Vitest/RTL · 코드 추적이다.

| ID   | 기능                                     | 결과                                                    | 확인 방법                                                   | 확인한 사람                |
| ---- | ---------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- | -------------------------- |
| C-01 | 파일 판정(크기+시각, 허용오차)           | 이슈 SC-11                                              | Rust 재현 + 자연 mtime 60개 표본                            | sol, opus(화면), sol R2    |
| C-02 | 이름 매칭(대소문자·NFC/NFD·원격 경로)    | 이슈 SC-17·30 / 대소문자 쌍은 merge 가 skip → 손실 없음 | Rust 재현, APFS 실측                                        | sol, opus R2, sol R3       |
| C-03 | 무시 glob                                | 개선 SC-49                                              | Rust+Vitest 대조표                                          | sol                        |
| C-04 | 5000 상한·Unreadable·링크                | OK(상한·Unreadable 보호) / SC-06                        | Rust 재현                                                   | sol, opus R2, sol R3       |
| C-05 | 비교 취소·진행                           | OK(백엔드) / SC-43                                      | 코드 + Vitest                                               | sol, sol R3                |
| C-06 | 내용 검증·이름변경 감지                  | OK                                                      | Rust                                                        | sol                        |
| C-07 | 내보내기 CSV/JSON                        | SC-28·45 / 덮어쓰기 확인은 기기                         | Rust + 코드                                                 | sol, opus                  |
| C-08 | 비교 화면 흐름                           | SC-11·35·36·37                                          | Vitest/RTL                                                  | opus                       |
| C-09 | 차이 미리보기                            | SC-21·22·23·33·46                                       | Vitest + Rust                                               | opus, sol R2               |
| C-10 | 비교 결과 적용 + undo                    | SC-04·08 / 부분 실패 journal OK                         | Rust 재현                                                   | opus, sol R2               |
| C-11 | 양방향 병합                              | SC-03·04·07·09·40                                       | Rust 재현                                                   | opus, sol R2, sol R3       |
| C-12 | 스캔 창·시작 경로                        | OK / SC-15·43                                           | Vitest + 코드                                               | opus, sol R3               |
| C-13 | 3-way                                    | SC-05·16·44                                             | Rust 재현                                                   | opus, sol R2               |
| C-14 | 동기화 허용 조합·중첩 경로               | SC-03·15                                                | Rust 재현                                                   | sol, opus R2               |
| C-15 | 동기화 미리보기 ↔ 실행                   | SC-06·12·13                                             | Rust 재현 + RTL                                             | sol, opus R2               |
| C-16 | 동기화 정상 undo·prune                   | OK(prune 끔) / SC-02·52                                 | Rust 재현                                                   | sol, opus R2               |
| C-17 | 동기화 중간 실패·취소                    | SC-01·31·32                                             | Rust 재현                                                   | lead, opus·sol R2, opus R3 |
| C-18 | same-host rsync                          | SC-10·24 / 실서버 기기확인                              | 파서 테스트·rsync 소스·로컬 openrsync 실행                  | sol, sol R2·R3             |
| C-19 | 동기화 확인창                            | OK(실행 차단) / SC-12·15·38                             | Vitest                                                      | opus                       |
| C-20 | 체크섬                                   | OK(로컬 해시 정확) / SC-24·34·47                        | Rust + Vitest + 명령 probe                                  | sol, opus, sol R3          |
| C-21 | 로컬 검색                                | SC-17·20·49 / 링크 순환 OK                              | Rust 재현                                                   | sol, opus R2               |
| C-22 | 원격 검색 명령·파서                      | OK(셸 인용) / SC-29·30                                  | Rust(로컬 sh 실행)                                          | sol                        |
| C-23 | 파일 인덱스                              | SC-18·19·25·26·27                                       | Rust 재현                                                   | sol, lead, opus R2         |
| C-24 | 검색 패널                                | OK(응답 경합 가드) / SC-42                              | Vitest                                                      | opus, opus R2              |
| C-25 | 빠른 이동·최근 위치                      | OK(점수·손상·상한) / SC-17·48                           | Rust + Vitest                                               | sol, opus                  |
| C-26 | 오류 표시(explainError·토스트·알림 배지) | OK(알림 기록 유지) / SC-15·39·41                        | Vitest + 코드                                               | opus                       |
| C-27 | Windows 분기                             | OK(크로스 clippy 통과) / SC-51 / 드라이브 색인은 기기   | `cargo clippy --target x86_64-pc-windows-gnu --all-targets` | lead                       |

## 이슈 대장 (심각도순)

전체 근거·재현 테스트 이름·교차검토 상세는 `issues.md`. 여기서는 사용자 관점 요약 + 수정안.

### P1 — 데이터 손실·되돌리기 불가 (4)

| ID    | 종류     | 제목 / 사용자 증상                                                                                                                                                                                                                                                                                        | 원인                                                                                                                                                                                        | 수정안·비용                                                                                                                                                     | 상태·교차검토                                                        |
| ----- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| SC-01 | bug      | **동기화가 도중에 실패·취소되면 Ctrl+Z 불가.** 이미 복사·덮어쓴 것은 되돌릴 수 없고, 덮어쓰려던 원본은 `이름.bak.<시각>` 으로만 남아 원래 이름에서 사라짐. 취소 후 Ctrl+Z 는 *직전의 다른 작업*을 되돌릴 위험. 같은 서버(rsync) 동기화는 exit≠0(부분 전송)이면 백업만 남고 기록 없음, 실행 중 [취소] 무시 | `core/ops.rs:1188-1225` `?` 조기 반환, `:1253-1262` rename 후 copy 실패 시 원위치 안 함, `:1506`, TaskQueue 는 취소 표시 후에도 실행 계속(`task_queue.rs:160,263`)                          | 부분 진행분을 journal 에 남기고 에러 전파(적용·병합이 이미 쓰는 패턴), copy 실패 시 백업 원위치, rsync 실패도 백업 수집 후 기록, 실행 중 취소 시 채널 close (M) | 확인됨 · opus/sol 동의(취소·stat 실패 경계 추가 재현)                |
| SC-02 | bug      | **삭제 전파 + 덮어쓰기 동기화 후 Ctrl+Z 가 "성공"이라면서 덮어쓴 파일을 복원 못 함.** 확인창은 "되돌리기 가능"이라 안내                                                                                                                                                                                   | prune 이 같은 실행이 받는 폴더에 만든 `.bak` 을 "원본에 없는 파일"로 보고 휴지통으로 (`ops.rs:1280,1204,1324,1344`, `undo.rs:395,412`)                                                      | 이번 실행의 백업을 prune 에서 제외하거나 받는 폴더 밖에 백업(SC-52 와 함께) (M)                                                                                 | 확인됨 · opus 동의(undo `kind=Ok` 인데 내용 그대로)                  |
| SC-03 | bug      | **부모/자식 폴더끼리 동기화·병합·적용하면** 자식 폴더를 자기 안으로 경로 한도·디스크가 찰 때까지 복사(`/p/backup/backup/…`), 반대 방향 + 삭제 전파면 원본 폴더 자체를 휴지통으로. 한 프로젝트를 양쪽에 열고 한쪽만 하위로 들어간 흔한 배치                                                                | `sync_plan` 은 완전 일치만 거부(`ops.rs:1108`), 비교·병합·적용은 검사 없음, `copy_tree` 가 만든 dst 를 다시 읽음(`fs/mod.rs:351-363`), FE 도 검사 없음                                      | 같은 실제 FS 의 조상 관계를 plan·비교·실행에서 거부 + `copy_tree` 방어 (S~M)                                                                                    | 확인됨 · opus·sol 동의(병합·적용 경로 추가 재현)                     |
| SC-04 | bug/rule | **비교 적용·병합·3-way·동기화·복사를 Ctrl+Z 하면 그 뒤 사용자가 고친 내용·추가한 파일까지 휴지통 없이 영구 삭제**, 결과는 "되돌림 성공" (외부 편집기 저장은 기록이 없어 Ctrl+Z 가 바로 이 작업을 되돌림)                                                                                                  | 생성분·복원 전 현재 내용을 `fs.remove`(=`remove_dir_all`) (`undo.rs:196,354-357,385,466-488,524-545`). §3 위반. 새 파일·새 폴더 undo 는 이미 "바뀌었으면 건너뜀" 가드 보유(`undo.rs:31-75`) | 기록 시점 크기·mtime 과 다르거나 폴더가 비어 있지 않으면 건너뛰고 알림, 지우는 경우도 휴지통으로 — 공통 헬퍼 (M)                                                | 확인됨 · sol 동의(sync·copy 에서도 재현). **fileops 팀과 공통 원인** |

### P2 (21)

| ID    | 종류 | 제목 / 사용자 증상                                                                                                                                                                                                              | 원인                                                                         | 수정안·비용                                                            | 상태·교차검토                                                                              |
| ----- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| SC-05 | bug  | 3-way: 읽지 못한(권한·연결 끊김) 하위 폴더를 빈 폴더로 보고 반대쪽 파일들을 "삭제 →"로 분류, 적용하면 멀쩡한 쪽에서 휴지통                                                                                                      | `three_way.rs:183-185` `unwrap_or_default` (2-way 는 Unreadable 로 보호)     | 읽기 불가 서브트리를 충돌 취급·적용 제외 (S~M)                         | 확인됨 · opus P1 → lead P2(휴지통 경유·화면 표시) → sol 동의                               |
| SC-06 | bug  | 받는 폴더 안의 폴더 링크(symlink/junction)를 따라가 **선택 범위 밖 파일을 덮어쓰고, 삭제 전파 시 범위 밖 폴더 전체를 휴지통으로**                                                                                               | `fs/local.rs:387` 링크를 대상 종류로 보고, `ops.rs:1265-1269,1324-1346` 재귀 | lstat 로 링크 판별, 따라가지 않기 (M)                                  | 확인됨 · opus·sol 동의                                                                     |
| SC-07 | bug  | 비교창에서 숨긴 `node_modules`·`.git`·`*.log` 가 **병합 때 그대로 통째 복사**(또는 상한 초과로 병합 거부)                                                                                                                       | 병합이 규칙 없이 다시 비교(`ops.rs:1789`, IPC 에 rules 없음)                 | `fs_merge_bidir` 에 rules 전달 (S)                                     | 확인됨 · sol 동의                                                                          |
| SC-08 | bug  | 비교 후 원본이 지워졌는데 적용하면 받는 쪽 파일만 `.bak` 으로 밀려나고 실패 토스트(Ctrl+Z 로는 복원됨)                                                                                                                          | 백업 rename 후 copy, 원본 확인 없음(`ops.rs:2394-2420,2569-2587`)            | 행마다 원본 존재 확인 후 건너뛰고 보고 (S)                             | 확인됨 · sol 동의                                                                          |
| SC-09 | bug  | 원격과 병합 후 연결 끊김 상태에서 Ctrl+Z → 아무것도(또는 한쪽만) 안 지우고 "성공" 확정, 재시도 불가                                                                                                                             | `undo.rs:354-356` 연결·삭제 오류 무시 후 Ok                                  | 적용 undo 처럼 오류 반환 (S)                                           | 확인됨 · sol 동의(부분 undo 도 재현)                                                       |
| SC-10 | bug  | 같은 서버 rsync 동기화: **한글 이름이 rsync 출력에서 `\#355…` 로 escape 되어 undo 가 새 파일을 못 지울 가능성**(`LC_ALL=C`), 앞 공백·개행 이름 오파싱, `--info=progress2` 는 rsync 3.1+ 전용이라 macOS 원격(openrsync)에서 실패 | `copy_progress.rs:111-132`, `ops.rs:1433,1462`, 버전 검사 없음               | escape 디코드 + 버전/기능 검사 (M)                                     | 파서·버전 확인됨, 실서버 기기확인 · sol 동의(rsync 3.2.7 소스 근거, 로컬 openrsync exit 1) |
| SC-11 | ux   | 로컬↔원격 비교에서 같은 파일이 "← 더 최신"으로 잡히고 **기본 방향이 덮어쓰기** (SFTP 초 vs 로컬 ms, 허용오차 기본 0)                                                                                                            | `compare.rs:267-280`, `compareView.tsx:129-141`, `fileActions.ts:285`        | 원격 포함 비교는 기본 ±2s, 근소 차이 행은 기본 skip + 안내 (S)         | 확인됨 · sol 동의("항상"은 아님 — 새 파일 60/60 이 ms 소수부)                              |
| SC-12 | ux   | 동기화 확인창이 새 파일과 **덮어쓸 파일을 한 목록으로** — 무엇이 교체되는지·`.bak` 보존 여부 불명. 대상이 더 최신이어도 크기만 다르면 덮어씀                                                                                    | `SyncPreview` 에 구분 없음(`ops.rs:1578-1661`), `entry_differs` `:1203`      | `overwrite` 목록 분리 + "덮어쓰기 N(백업 후)" (S~M)                    | 확인됨                                                                                     |
| SC-13 | bug  | 동기화 미리보기는 "복사 0"·[동기화] 활성인데 실행하면 권한 오류로 실패(→ SC-01)                                                                                                                                                 | 미리보기만 읽기 오류 무시(`ops.rs:1642,1657`)                                | 오류 전파 또는 "읽지 못한 폴더" 경고 (S)                               | 확인됨 · opus 동의                                                                         |
| SC-14 | ux   | 동기화·병합·적용·3-way 진행이 **파일 개수를 바이트로 표시 "12 B / 40 B"**                                                                                                                                                       | `ops.rs:1296,1936`, FE 는 delete 만 개수 표시                                | files 필드 사용 또는 FE countOnly (S)                                  | 확인됨 · opus RTL 실측 / sol: same-host 동기화는 예외                                      |
| SC-15 | ux   | 이 영역 오류가 "종류 라벨 + 영문 개발자 문장". **로컬↔원격 동기화**: `지원하지 않음 — sync supports local↔local and same-host SSH only…` (대안 없음). 병합·적용 실패도 "동기화 실패"                                            | `error.ts` 패턴 없음, `TaskKind::Sync` 공용                                  | 쉬운 문장 + "비교 → 적용/병합" 안내, relay 조합은 메뉴 미리 비활성 (S) | 확인됨                                                                                     |
| SC-16 | ux   | 3-way base 입력 기본값이 왼쪽 경로 — 그대로 확인하면 왼쪽 전용 파일이 전부 "삭제" 분류, 적용은 확인 없이 즉시                                                                                                                   | `fileActions.ts:316-321`                                                     | 기본값 비우기 + base==left/right 거부 + 삭제 N개 확인 (S)              | 확인됨                                                                                     |
| SC-17 | bug  | 한글 NFC/NFD(macOS 산 이름) 불일치: 비교에서 같은 이름이 양쪽 전용 2행, 검색·인덱스·점퍼에서 안 찾아짐. macOS 에선 "생성 2"라던 적용이 **양쪽 덮어쓰기**(`.bak`+Ctrl+Z 로는 복원)                                               | `compare.rs:327`, `search.rs:198`, `file_index.rs:85,390`, `fuzzy.ts:13`     | 비교·검색용 정규화 키 (M; `unicode-normalization` 이미 의존성에 있음)  | 확인됨 · opus·sol 동의                                                                     |
| SC-18 | bug  | [재색인]을 눌러도 앱 시작 이후 생긴 로컬 파일이 검색 안 됨(전역 인덱스는 재시작으로만 갱신)                                                                                                                                     | `commands/search.rs:166,226,243`                                             | 재색인 시 전역 인덱스 갱신 (M)                                         | 확인됨 · opus 동의                                                                         |
| SC-19 | bug  | 앱을 켤 때마다 전체 드라이브를 처음부터 색인 — Windows 는 네트워크·USB 드라이브 포함(끊긴 드라이브에서 지연 가능), macOS 는 `/Volumes` 포함·폴더 접근 권한 질문 가능, 중복 빌드 가드 없음(개발 빌드 2회)                        | `useIndexProgressEvents.ts:16`, `file_index.rs:163-176,445`                  | 진행 중 가드(S), 고정 디스크만·볼륨 경계(S~M), 영속화·증분(L)          | 확인됨(코드·호출 횟수) / 체감은 기기                                                       |
| SC-20 | bug  | 내용 검색에서 크기·날짜·종류 필터가 화면엔 켜져 있는데 무시됨                                                                                                                                                                   | `search.rs:229,310`                                                          | 읽기 전 필터 적용 (S/M)                                                | 확인됨 · opus 동의                                                                         |
| SC-21 | bug  | 차이 미리보기·일반 미리보기에서 **CP949(옛 Windows 한글) 파일이 첫 한글에서 조용히 잘림**(같은 파일로 오판), UTF-16 은 binary                                                                                                   | `fs_ops.rs:1892-1913 decode_text`                                            | 잘림 표시 또는 lossy 전체 표시 (S)                                     | 확인됨 · sol 동의. browse 와 공통                                                          |
| SC-22 | ux   | CRLF↔LF 만 다른 파일이 전 줄 -/+ 로 보이고 줄끝 안내 없음                                                                                                                                                                       | `CompareDiffPreview.tsx:89-90`                                               | 줄끝 배지 + `\r` 무시 비교 (S)                                         | 확인됨                                                                                     |
| SC-23 | ux   | 차이가 600줄 이후에만 있으면 "다름" 행인데 바뀐 줄이 안 보임                                                                                                                                                                    | `CompareDiffPreview.tsx:89-91`                                               | 공통 앞뒤 제거 후 diff (M)                                             | 확인됨                                                                                     |
| SC-24 | bug  | 원격 체크섬·같은 서버 동기화가 끝날 때까지 그 연결의 세션 잠금을 쥐어 **같은 서버의 새 목록·미리보기가 멈추고**, 닫기·취소가 원격 명령을 멈추지 않음                                                                            | `fs/ssh.rs:283-286`, `ops.rs:1470`, `connection_pool.rs:28`                  | 채널 열기만 잠금 안에서, 대기는 밖 + 취소 시 close (M)                 | 확인됨(코드) · sol 범위 한정 동의. remote 팀 공통                                          |
| SC-27 | bug  | 파일명 검색이 숨김 제외를 무시 — 모든 기본 검색에 `.git`·`~/.cache` 등이 섞이고 순위 없는 500개 상한이라 실제 결과를 밀어낼 수 있음(Windows 숨김 속성은 저장도 안 함)                                                           | `file_index.rs:381,453`                                                      | 인덱스에 숨김 여부 저장·적용 (M)                                       | 확인됨 · lead P3 → opus 반박 → **P2 채택**                                                 |

### P3 (27)

| ID    | 제목                                                                                 | 수정 비용 | 상태                                    |
| ----- | ------------------------------------------------------------------------------------ | --------- | --------------------------------------- |
| SC-25 | 인덱스 캐시 파일명 충돌(`a-b`↔`a_b`)                                                 | S         | 확인됨                                  |
| SC-26 | 구조가 깨진 캐시 JSON 으로 검색 panic                                                | S         | 확인됨                                  |
| SC-28 | CSV 내보내기 수식 시작 이름 중화 없음, BOM 없음(Excel 한글)                          | S         | 확인됨                                  |
| SC-29 | 원격 검색: 개행 든 이름이 가짜 결과 여러 개로                                        | M         | 확인됨                                  |
| SC-30 | 원격 셸 경로가 이름 속 `\` 를 `/` 로 바꿈                                            | S/M       | 확인됨                                  |
| SC-31 | 동기화 되돌리기가 새로 만든 빈 폴더 트리를 남김                                      | S         | 확인됨                                  |
| SC-32 | 동기화 중 큰 파일 하나는 취소·진행 갱신 안 됨                                        | S         | 확인됨(코드)                            |
| SC-33 | 차이 미리보기: 오른쪽만 600줄 초과면 잘림 안내 없음                                  | S         | 확인됨                                  |
| SC-34 | 체크섬 검증칸에 `sha256sum` 형식을 붙이면 맞아도 불일치                              | S         | 확인됨                                  |
| SC-35 | 필터로 가린 행도 "적용"에 포함                                                       | S         | 확인됨                                  |
| SC-36 | 키보드로 skip 복귀 불가, 보기 전환 시 선택 초기화                                    | S         | 확인됨                                  |
| SC-37 | 비교 목록 가상화 없음(5000행)                                                        | S~M       | 기기확인                                |
| SC-38 | 동기화 목록 200개에서 "외 N개" 없이 끊김                                             | S         | 확인됨                                  |
| SC-39 | 작업 제목 영문, 실패 시 히스토리에 바로 안 보임, undo 실패 원문 노출                 | S         | 확인됨(코드)                            |
| SC-40 | 시작 전 취소된 병합·적용도 빈 기록을 남겨 Ctrl+Z 한 번 소모                          | S         | 확인됨                                  |
| SC-41 | undo 메시지 한국어 하드코딩(영어 UI 에서도)                                          | S         | 확인됨                                  |
| SC-42 | 검색 상태칸이 결과 수보다 "드라이브 인덱싱 중" 우선, 재색인 표시·↑↓ 없음             | S         | 확인됨                                  |
| SC-43 | 비교 시작 경합: 설정 읽는 중 Esc 무시, 연속 비교 시 이전 취소 응답이 새 창을 닫음    | S         | 확인됨                                  |
| SC-44 | 3-way 진행·취소 없음, 적용 시 다시 비교                                              | S~M       | 확인됨(코드)                            |
| SC-45 | 내보내기 형식이 확장자로만 결정, 결과 한 줄 메모                                     | S         | 확인됨(코드)                            |
| SC-46 | 미리보기에 내부 이름(`too_large`, `binary`) 노출                                     | S         | 확인됨                                  |
| SC-47 | 원격 체크섬: GNU/shasum 에서 `\`·개행 이름 실패, 폴백이 진짜 오류를 가림             | S         | 조건부 확인됨                           |
| SC-48 | 빠른 이동: 재시작 후 원격 라벨 IP, key 충돌, 없어진 폴더 남음, 초성·여러 단어 미지원 | S         | 확인됨                                  |
| SC-49 | 내용 검색 8MiB 초과 조용히 제외, 무시 glob 의미 FE/BE 차이                           | S         | 확인됨                                  |
| SC-50 | 모달 탐색 키 하드코딩·useEffect 데이터 페칭 — 앱 전반 패턴                           | —         | **미결(사용자 결정: 규칙 예외로 둘지)** |
| SC-51 | `verify_relay` 가 로컬 경로도 POSIX 결합(`C:\a/sub/x`) — §7                          | S         | 확인됨(문자열), Windows I/O 는 기기     |
| SC-52 | 로컬 동기화 `.bak` 이 받는 폴더에 쌓이고 이후 삭제 전파로 일괄 휴지통                | M         | 확인됨                                  |

## 개선 제안 (버그는 아니지만 나아질 것)

- "같음"은 크기+시각 기준 — 내용 검증 버튼은 있으나 원격 비교에선 허용오차 안내를 먼저 보여 주기(SC-11 과 함께).
- 5000 상한에서 "같음" 행이 자리를 먹는다 — 차이 행 우선 보관(sol, M).
- 로컬↔원격 동기화 자체가 없다(설계상 relay 미지원) — 사용자 주 조합이므로 최소한 메뉴 단계에서 "비교 → 적용/병합" 으로 안내(SC-15).
- 동기화 백업 위치를 받는 폴더 밖으로(SC-02·52 근본 해결).

## 기기 확인 필요

| 항목                                                            | 확인 방법                                                                                                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC-10 rsync 한글 escape·`--info=progress2`                      | remote 팀 Docker sshd(`scripts/ssh-it.sh`)에서 rsync 3.x 로 한글 이름 동기화 → Ctrl+Z 후 새 파일이 남는지; macOS 원격(openrsync)에서 같은 서버 동기화 실행 |
| SC-19 시작 시 전체 드라이브 색인                                | Windows 실기: 끊긴 네트워크 드라이브 연결 상태로 앱 시작(지연·CPU), macOS 실앱 첫 실행 시 폴더 접근 권한 질문 여부                                         |
| SC-24 세션 잠금                                                 | Docker sshd 에서 큰 파일 체크섬/큰 트리 같은 서버 동기화 중 같은 서버 패널 탐색                                                                            |
| SC-06 Windows junction                                          | Windows 에서 받는 폴더 안 junction 으로 동기화(삭제 전파 포함)                                                                                             |
| SC-51 `\\?\` 경로                                               | Windows 에서 긴 경로 폴더 비교 → 내용 검증                                                                                                                 |
| SC-37 비교 목록 성능                                            | 실앱에서 5000행 근처 결과의 키 이동 체감                                                                                                                   |
| C-07 내보내기 덮어쓰기 확인, CSV 한글(BOM 없음)을 Excel 로 열기 | Windows Excel                                                                                                                                              |
| macOS 로컬 휴지통 복원                                          | 동기화 prune·3-way 삭제 후 Ctrl+Z → Finder 수동 복원 안내가 보이는지                                                                                       |

## 다른 영역으로 넘긴 것

- **fileops**: SC-04 와 같은 "되돌리기 = 영구 삭제"가 `UndoCopy`(`undo.rs:196`)에도 — 공통 헬퍼로 같이 고칠 것. 복사 Replace 의 폴더 교체 경로는 이 팀에서 보지 않음.
- **browse/preview**: SC-21 CP949 조용한 절단은 일반 미리보기 `fs_read_preview` 공통.
- **remote**: SC-24 의 "잠금 쥔 채 exec 대기"가 `run_ok`·`exec_cp`(`fs/ssh.rs:51,128`)에도. SC-10 실서버 검증.
- **공통 UX/i18n**: 작업 제목이 백엔드 영문(`Merging …`, `Applying …`, `Syncing …`).

## 라운드 기록

| 라운드   | 누가 무엇을                                                                                                             | 결과                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| PLANNING | lead: coverage C-01~27 작성, 분배(sol=백엔드 판정·경계·플랫폼, opus=화면·적용·undo·오류, lead=동기화 실패 안전·Windows) | opus 워커 시작 지시 누락 → 재전송                                                                                                  |
| R1       | sol 14건(재현 21), opus 36건(보조 에이전트 포함), lead 5건(재현 2)                                                      | lead 가 합쳐 SC-01~51, 심각도 재판정(P1→P2 1, P2→P3 9)                                                                             |
| R2       | opus: sol·lead 11개 재검증 / sol: opus·lead 12개 재검증                                                                 | 동의 23, 심각도 조정 동의 4, 반박 1(SC-27 P3→P2, 채택), 범위 한정 2(SC-14·24), 새 발견 5(F-opus-37 P1 등 → 기존 이슈 병합 + SC-52) |
| R3       | sol: 새 발견 4 + SC-43·47 / opus: SC-31·32·27                                                                           | 전부 동의, "검증 필요" 0, 미결 1(SC-50 사용자 결정)                                                                                |

## 재현 테스트

- 커밋: `0beac71` (브랜치 `review/sync-compare`, 테스트만)
- 결함 재현은 Rust `#[ignore = "sync-compare repro: …"]`, Vitest `it.fails("sync-compare: …")` — 기본 실행은 초록, 표시만 떼면 회귀 테스트.
- 파일:
  - Rust 통합: `src-tauri/tests/review_sync_compare_{sol,apply,xcheck_sol,xcheck_opus,r3_sol,r3_opus}.rs`
  - Rust 모듈 끝 덧붙임(기존 줄 변경 0): `src-tauri/src/core/ops.rs`(`review_sync_compare_lead`, unix 전용), `core/search.rs`, `services/file_index.rs`, `commands/fs_ops.rs`(`review_sync_compare_opus_preview`), `services/frecency.rs`
  - Vitest: `src/lib/__review__/sync-compare-{glob,errors,fuzzy,r3-cancel}.test.ts`, `src/components/__review__/sync-compare-{search,xcheck-search,xcheck-progress}.test.tsx`, `src/components/dialogs/__review__/sync-compare-{compare-flow,diffpreview,checksum,jumper}.test.tsx`
- 실행:

```bash
H=/Users/ctmctm/Desktop/01_PROJECT/duet-ux/_review/bin/heavy.sh
# 기본(초록) — bash 에서 실행(zsh 는 $(find) 결과를 한 인자로 넘김)
bash $H cargo test --manifest-path src-tauri/Cargo.toml --test review_sync_compare_sol --test review_sync_compare_apply --test review_sync_compare_xcheck_sol --test review_sync_compare_xcheck_opus --test review_sync_compare_r3_sol --test review_sync_compare_r3_opus
bash $H cargo test --manifest-path src-tauri/Cargo.toml --lib review_sync_compare
bash $H pnpm exec vitest run --minWorkers=1 --maxWorkers=2 $(find src -path '*__review__*' -name 'sync-compare*')
# 결함 재현(의도적으로 실패)
bash $H cargo test --manifest-path src-tauri/Cargo.toml --test review_sync_compare_sol -- --ignored   # 다른 --test 도 동일
bash $H cargo test --manifest-path src-tauri/Cargo.toml --lib review_sync_compare -- --ignored
```

- 주의: `sc47_gnu_and_shasum_*`(ignore)는 `/opt/homebrew/bin/gsha256sum` 이 있어야 하고, `sc47_escaped_checksum_names_*`(ignore)는 macOS `/sbin/sha256sum` 전용 대조군이다. SC-47 테스트는 `fs/ssh.rs` 의 명령 템플릿 줄을 `include_str!` 로 읽으므로 그 줄을 고치면 테스트도 손봐야 한다.
- 검증 결과(커밋 직전, 기본 실행): Vitest 11파일 **59 passed** · Rust 통합 6타깃 **31 passed / 47 ignored / 0 failed** · `--lib review_sync_compare` **6 passed / 8 ignored** ·
  tsc·eslint·prettier 0 · `cargo clippy --all-targets`(macOS)·`--target x86_64-pc-windows-gnu` 통과. 경고 1건 `src/fs/local.rs:637 items after a test module` 은
  **기준 커밋 adce9f4 에 원래 있던 것**(이 라운드 변경 밖, `-D warnings` 로 돌리면 실패하므로 별도 정리 필요).
- 기존 Rust 파일 5개의 diff 는 파일 끝 테스트 모듈 1 hunk, 삭제 줄 0 — 제품 코드 무변경 확인.
- lead 가 테스트에 손댄 것: 자기 모듈 `cfg(unix)` 가드, sol `sc47_escaped_checksum_names_*` 를 환경 의존 대조군으로 ignore(Linux GNU 에서 빨개짐 방지),
  opus 테스트의 타입 오류 2곳(`sync-compare-search.test.tsx`) 과 잘못된 enum 값(`"too_large"`→실제 `"toolarge"`, SC-46 재현이 의미 있게) 수정, Windows 타깃 unused import 제거.
