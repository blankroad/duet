# 수정 라운드 1 (2026-11-09 ~ 11-10)

2026-11-08 기능 점검(`../2026-11-08-functional-review/README.md`)에서 나온 이슈 중 배치 1·2 와 같은 파일의 배치 3 일부를 고쳤다.
herdr 수정 팀 6개가 병렬로 일했다. 팀마다 서브 오케스트레이터 1명(Opus 5.5)과 워커 2명(Opus 5.5 · Codex GPT-6.1-Sol)이 있었다.

- 워커마다 자기 git worktree 를 썼다.
- 진행: 구현 → 교차 리뷰 → 재수정, 최대 3라운드.
- 각 팀은 끝나면 전체 게이트를 통과시켰다.
- 메인 세션이 팀 브랜치를 차례로 통합했다.

- 팀별 최종 보고서: 이 폴더의 `archive.md` · `undo.md` · `persist.md` · `paths.md` · `errors.md` · `browse.md`.
  각 보고서에 고친 이슈·커밋·테스트·남은 한계·기기 확인 목록이 있다.
- 사용자 결정: **D-1 `encoding_rs` 추가, D-2 zip 압축 방식 확장 승인**.
  zip 2.4 → 9.5 로 올렸다. 새 방식: bzip2·lzma·xz·ppmd·zstd. zstd 만 C 빌드이고, Windows 교차 빌드를 통과했다.
  **D-4 는 팀 권고(휴리스틱 자동 판정)** 를 따랐다.
- 점검 때의 재현 테스트(`review/<영역>` 브랜치)도 함께 main 에 들어왔다.
  고친 항목은 `#[ignore]`·`it.fails` 표시를 떼어 회귀 테스트가 됐다. 아직 남은 항목은 표시가 유지된다.

## 고친 것 (사용자 기준)

| 팀      | 고친 것                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| archive | **U-01** tar 해제·내부 보기가 해제 폴더 밖을 쓰고 읽던 보안 결함 (2026-11-08 세션 결함)<br>**U-05** 한국어 Windows zip 의 한글 이름 깨짐<br>**U-09** 하위 폴더에서 Update archive 를 하면 나머지가 사라짐<br>7-Zip·반디집 방식(BZip2·LZMA·XZ·PPMd·Zstd) zip<br>zip·7z 의 Windows 금지 이름·링크<br>읽기 전용 폴더가 든 tar<br>압축이 링크를 따라감<br>CP949·UTF-16 텍스트 미리보기 |
| undo    | **U-02** Ctrl+Z 가 생성분을 영구 삭제하던 것: 이제 기록 때 지문과 같을 때만 휴지통으로<br>**U-10** 되돌리기가 새 파일을 옛 내용으로 덮던 것: 자리가 차 있으면 건너뜀<br>**U-11** 되돌릴 수 없는 항목이 Ctrl+Z 를 영원히 막던 것<br>되돌리기 토스트 문구<br>재시작 후 History 순서                                                                                                  |
| persist | **U-03** 저장 파일 하나가 깨지면 앱이 안 켜지던 것: `.corrupt-<시각>` 으로 보존하고 기본값으로 시작하며 알림, 읽을 수 없으면 오류 창<br>모든 저장을 원자적 쓰기로<br>저장 실패 시 메모리 불변<br>journal 동시 기록 안전<br>옛 북마크 이전 실패 시 원본 보존                                                                                                                        |
| paths   | **U-04** 폴더를 자기 하위로 복사·이동·동기화·병합·압축하면 무한 자기 복제하던 것: 백엔드 plan·execute 양쪽 가드<br>**U-13** 원격 경로에 `\` 가 섞이던 것: POSIX 결합·인용<br>**U-12** 같은 IP·다른 포트 서버를 같은 서버로 보던 것<br>일괄 이름 바꾸기의 `..\` 우회<br>`ssh-it.sh` HOME 격리                                                                                       |
| errors  | 원격 명령 오류에 zip 암호가 실리던 것(§5)<br>오류 토스트가 파일 이름·원문을 잃던 회귀(`showError`)<br>연결 오류를 문장으로<br>영어 원문·엉뚱한 안내 문구<br>Windows errno 설명<br>토스트 hover·포커스 중 정지<br>알림 배지 키보드·읽음 처리                                                                                                                                        |
| browse  | **U-15** 큰 동영상·음성·PDF 미리보기가 파일 전체를 메모리로 읽던 것: Range 읽기와 상한<br>원격/로컬 소스가 섞이던 내비게이션<br>Windows 경로 입력(따옴표·`C:\` 인자·UNC)<br>한글 NFC/NFD 비교·검색·필터<br>IME 조합 중 Enter/Esc<br>CRLF↔LF 차이 표시                                                                                                                              |

## main 통합 때 메인이 한 일

- 충돌 해결:
  - import 줄
  - 같은 파일 끝에 각자 덧붙인 테스트 모듈
  - `core/ops.rs` 7곳: browse 의 `resolve_side_rel`(NFC 실제 이름)과 paths 의 `fs.join`(POSIX 결합)을 둘 다 적용
- `fileActions.ts`: 두 팀 변경이 겹쳐 쓰이지 않게 된 `formatErr` import 를 제거했다.
- 기준선 정리:
  - `mvp2_smoke` 의 Replace 테스트를 CLAUDE.md §4(2026-06, 백업 없는 덮어쓰기)에 맞췄다. undo 부분은 D-6 대기다.
  - 재현 테스트의 clippy 경고와 prettier 포맷을 정리했다.
- 남은 기준선: `cargo clippy --all-targets` 의 `fs/local.rs:637` items_after_test_module 1건.
  사용자의 미커밋 작업이 이 부분을 다루므로 손대지 않았다.

## 남은 것·후속

- **결정 대기:** D-3 (vault `unsafe`), D-5 (드래그 수정 키), **D-6** (Replace 복사 undo), **D-7** (동기화 백업 위치 → U-08/SC-02), D-8~D-14.
- **이번 라운드 범위 밖(다음 배치):**
  - G-08 실패 시 롤백(U-06 archive-03, U-07 SC-01)
  - G-09 취소
  - G-10 세션 잠금
  - G-11 정체성 타입 전체(U-14 remote-02 포함)
  - G-12 권한 상승
  - G-07 압축 문맥
  - G-19 `.duet-part`
  - G-20 원격 임시 폴더
  - G-21 읽기 실패 구분
  - G-22·G-26
  - G-28
  - 나머지 P2/P3
- **이번 라운드에서 새로 나온 후속:**
  - undo: stale 표시를 journal 에 영속화(`MarkStale` 레코드). 지금은 재시작 후 Ctrl+Z 한 번씩 "건너뜀"으로 소모된다.
  - undo: redo 후 지문 갱신.
  - undo: `fs/local.rs` 의 원자적 no-replace rename, 휴지통에 없을 때 `NotFound`.
  - browse R3-S4-1 (P2, 드묾): 정규화 구분 FS 의 한 폴더에 NFC·NFD 두 이름이 같이 있으면 3-way/비교 적용이 다른 형태 파일을 덮는다. `.bak` 과 Ctrl+Z 는 가능. 재현 테스트는 ignore.
  - paths: 남은 native 원격 경로 지점(`archive.rs` 백업·reap, `undo.rs`, `sudo.rs`, `search.rs`, `fs/ssh.rs` 휴지통, FE `entryDnd`·`pathCrumbs`·`newEntry`). Windows 클라이언트 + 원격에서만 해당한다.
  - archive: 원격 zip 압축(`zip -r`)이 링크를 따라감(`-y` 필요). Windows 비관리자 browse 에서 건너뛴 링크가 Update archive 때 조용히 사라짐(repack 경고 필요).
  - archive: Shift-JIS zip 이름, 7z 안 심볼릭 링크, `tar_unpack.rs`·`zip_unpack.rs` 500줄 초과(분리 후보).
  - errors: 오류가 아닌 영어 문구(동적 명령·선반 이름·BE 작업 제목), BE 구조화 오류.
- **기기 확인:** 각 팀 보고서의 "기기 확인 필요" 절. 특히 다음 세 가지.
  - Windows 실기의 zip/7z/tar 해제(이름 치환·링크·CP949 실제 산출물)
  - 깨진 설정 파일로 시작
  - 큰 미디어 Range 재생
