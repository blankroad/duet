# errors 수정 최종 보고

## 요약

- 브리프 4개 묶음을 모두 고쳤다: **원격 명령 오류의 암호 노출(P2, §5)**, **G-16 오류 토스트가 파일 이름·원문을 잃는 회귀(P2)**, **G-17 단기 문구(P2/P3)**, **G-18 토스트 hover 정지·알림 배지(P3)**.
  P2 고침: G-27 넘김 1 · ss-04 · archive-16 · SC-15(문구) · remote-26(+G-16) · fileops-09 FE 문구. P3: browse-30·31, ss-14·15·23·25·27(일부), archive-32, Windows errno 4종.
- 못 고친 것: ss-27 의 미배정 나머지(동적 명령·선반 이름·아이콘 이름·BE 작업 제목 등), SC-39·41(undo/BE), remote-24(BE), SC-46. 제외 항목(ss-24, archive-31, G-27 나머지, fileops-25)은 손대지 않음.
- 위험: 오류 토스트 호출부를 App.tsx·fileActions.ts·stores/\* 등 넓게 바꿔(호출 줄만) **main 통합 시 다른 팀과 줄 충돌**이 날 수 있다(아래 "겹칠 수 있는 곳"). 문구 판정(error.ts)이 커져 실서버·Windows 실기 원문 모양 확인이 남아 있다.

## 고친 것

| ID                                            | 사용자에게 달라지는 점                                                                                                                                                            | 커밋                                                                                                                | 테스트                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-27 넘김 "원격 명령 오류에 암호" (P2, §5)    | 원격 exec 가 실패해도 오류·토스트·알림 "자세히"에 명령 본문(`unzip -P '<암호>'`)이 나오지 않음 — 프로그램 이름만(`exec unzip: …`)                                                 | bb59b11, f20a886                                                                                                    | `ssh::remote_exec::tests` 3건(암호 문자열 부재, program_name, 호출부 소스 가드 — 옛 포맷으로 되돌리면 실패 확인)                                               |
| G-16 / ss-04 (P2)                             | 오류 토스트가 원인 문장 + **실패한 파일 이름**(“분기보고서 2026.xlsx” — …)을 보이고, 원문은 알림 "자세히"에 남음. 공통 헬퍼 `showError`/`errorToastText`(`src/lib/errorToast.ts`) | 7270125, c960296, be89e27, fedb58f, 975a0af, 9fc51f3, c92b795, 3a1283d, 7d18b3f, 78dda17, 2145820, 28b5b5e, f6fec97 | ss-04 2건 it.fails 해제, `errorToast.test.ts`, `fileActions.errors.test.ts`, `savedHosts/tags/dirSize.errors.test.ts`, InlineRenameInput·useCreateEntry 테스트 |
| browse-30 (P3)                                | 폴더 열기 실패 알림에 원문 detail                                                                                                                                                 | c960296                                                                                                             | `browse-sol2-app-cross` browse-30 it.fails 해제                                                                                                                |
| remote-26 (P3)                                | 연결 오류 상자·재연결 배너가 "os error 61" 대신 "서버가 연결을 거부했습니다…" 등 문장, 원문은 툴팁                                                                                | 6f8e624, afdda48, 7309017, cf123d4                                                                                  | `remote-opus-reconnect` remote-26, `ConnectErrorBox.test`, `ConnectionBanner.test`                                                                             |
| ss-14 (P3)                                    | macOS/Linux errno 를 따로 해석(mac 36·Linux 69 오해석 제거), ENOTEMPTY·ENOTSUP·ELOOP 문구. 원격(Ssh) 오류의 번호는 이 PC 표로 읽지 않음                                           | 4954b1c                                                                                                             | `shell-settings-error` ss-14 2건 + improve 1건 해제                                                                                                            |
| ss-15 (P3)                                    | 파일 이름 속 단어("bad header", "already exists", "timed out")가 원인을 바꾸지 않음 — 경로·항목 이름을 가리고, PermissionDenied/NotFound 는 kind 를 신뢰                          | 1602779, 69c20df, d909e1f                                                                                           | ss-15 2건 해제 + R3-02·R3-04 회귀                                                                                                                              |
| Windows errno 21·1326·225·362 (+145, Winsock) | 장치 준비 안 됨·네트워크 로그온 실패·바이러스·클라우드 파일 문구                                                                                                                  | 85d04ef                                                                                                             | `error.test.ts`                                                                                                                                                |
| archive-16 (P2) / archive-32 (P3)             | 원격 AES zip → "서버에서 못 풉니다, 내 PC 로 복사해 푸세요", 4GB·ELOOP·빈 repack·rar 경로 탈출·이름 `/`, 원격 unzip exit 1/50·코덱 프로그램 없음·옛 tar 의 `--zstd` 미지원 구분   | b51c20c, 01a264d                                                                                                    | `archive-error` raw 5건 + AES 1건 해제, 새 케이스                                                                                                              |
| SC-15 (P2, 문구만)                            | 로컬↔원격 동기화 거부가 "지원하지 않습니다 — 비교 → 적용/병합을 쓰세요"                                                                                                           | 04dd25a                                                                                                             | `sync-compare-errors` relay 1건 해제                                                                                                                           |
| fileops-09 (FE 문구)                          | 폴더 교체 롤백 실패 시 주 문구에 **백업 위치 전체 경로**(괄호·작은따옴표 이름 포함)                                                                                               | 914a27f, e8324f9                                                                                                    | `fileops-opus-r2-explain` fileops-09 2건 해제 + R3-01 3건                                                                                                      |
| browse-31 / ss-23 (P3)                        | 토스트에 마우스를 올리거나 포커스하면 자동 소멸이 멈추고, 둘 다 떠나면 남은 시간(최소 1.5초)으로 재개                                                                             | c6d61a0                                                                                                             | ss-23 2건·browse-31 1건 해제 + `Toast.pause.test`                                                                                                              |
| ss-25 (P3)                                    | 알림 배지: 50개 상한 뒤에도 열린 채 읽음 처리, 모두 지우기 뒤 포커스 복귀(Windows 클릭 포커스 포함), 패널 Tab 순환·패널 밖 Esc, **다른 모달의 Esc/Tab 은 가로채지 않음**          | 5b5ceb5, 423951f, 236285c                                                                                           | ss-25 3건 해제 + `NoticeBadge.navigation/modal/pointer` 테스트                                                                                                 |
| ss-27 (P3, 일부)                              | 스토어·드래그·드롭 트레이·폴더 크기 오류 토스트의 영어 접두 14곳 → ko·en i18n, 폴더 크기 실패가 기록에 남는 error 로                                                              | 7d18b3f, 78dda17                                                                                                    | `tags.errors.test`, `dirSize.errors.test`                                                                                                                      |
| R3-05 (리뷰 발견)                             | 파일 읽기 timeout 을 "서버가 응답하지 않음·방화벽" 으로 단정하지 않음                                                                                                             | bea65d0                                                                                                             | `error.test.ts` R3-05                                                                                                                                          |

## 못 고친 것·부분 수정

- **ss-27 나머지**: 동적 명령 `Connect:`/`Bookmark:`, 선반 기본 섹션 `Main`, 알림 시각 로캘, 저장 호스트 툴팁, 아이콘 이름 30개, `dirSize` 의 "Calculate size: select a folder" 등 **오류 토스트가 아닌 문구**와 BE 영어 작업 제목(`fs_ops.rs:128-129`). 브리프 범위(오류 토스트)를 넘어 배정하지 않음.
- **SC-39·SC-41**: undo/작업 제목(BE·undo 팀 영역). **remote-24**: BE 에서 대상 stat 이 필요(remote 팀). **SC-46**: 오류 문구 아님.
- **SC-15 의 메뉴 비활성**(relay 조합을 미리 막기)은 하지 않음 — 문구만.
- 남은 `it.fails`(우리 범위 밖): `archive-20`(ZipCrypto), `fileops-04`·`fileops-17`(fileops), `shell-settings-24`(D-14 결정 대기), `shell-settings-improve` 중복 알림 합치기. Rust `fileops-09 repro`(ops.rs·elevate.rs `#[ignore]`)는 G-08 롤백 작업 소관.
- error.ts 의 BE 구조화 오류(`RollbackFailed{backup}` 등)는 범위 밖 — 지금은 원문 패턴 판정이라 BE 문구가 바뀌면 같이 고쳐야 한다(테스트가 원문 모양을 고정해 둠).

## 다른 팀 파일과 겹칠 수 있는 곳 (main 통합 시)

- `src/App.tsx` — 오류 토스트 30여 곳의 호출 줄 + 일부 `useCallback` 의존 배열에서 `showToast` 제거(10곳), `import { showError }`, 연결 목록 실패 detail(`failureDetails`), 재연결 catch(`message: explainError(e).detail || formatErr(e)`). 모든 팀이 App.tsx 를 고치므로 **줄 충돌 가능성 높음** — 해결 규칙: 상대 변경을 살리고 `showError(...)` 호출 형태만 다시 적용.
- `src/lib/fileActions.ts` — 오류 토스트 호출 줄(undo/redo 112·128 는 그대로). undo·paths 팀과 충돌 가능.
- `src/lib/error.ts` — 크게 바뀜(HostOs, 경로 추출·마스킹, 새 Reason 20여 개, ExplainedError.target). **paths 팀의 `IntoItself`/`intoItself` 추가와 충돌 예상**: Reason 유니온 끝과 `KIND_REASON` 표 — 우리는 `KIND_REASON` 을 건드리지 않았고 새 Reason 은 `exists` 와 `network` 사이에 넣었다. 또 `KIND_COMPATIBLE`(PermissionDenied/NotFound 가 원인을 뒤집지 않게) 표가 새로 생겼으니 `IntoItself` kind 는 영향 없음.
- `src/i18n/{ko,en}.json` — `errors.withName`·`errors.backupKept`·`errors.reason.*`(20여 개), `toast.*` 새 키 11쌍. 다른 팀의 키 추가와 인접 줄 충돌 가능(JSON 콤마).
- `src/stores/{appLaunchers,bookmarks,hostFavorites,hostNicknames,keymap,savedHosts,settings,sidebarGroups,tags,userAliases}.ts`, `src/lib/{entryMenu.tsx,dirSize,dragOut,dropTray}.ts`, `src/windows/DropTray.tsx`, `src/hooks/{useCreateEntry,useOsFileDrop,useTaskCancel}.ts`, `src/components/{pane/InlineRenameInput,pane/PreviewView,dialogs/PermissionsDialog}.tsx` — 오류 호출 줄과 import.
- `src/stores/toast.ts`·`src/components/Toast.tsx`·`NoticeBadge.tsx` — 우리 소유. ss-24(D-14) 결정이 나면 같은 파일.
- 테스트: `__review__` 재현 파일 몇 개에서 `it.fails` 해제·기대값 변경(shell-settings-toast-notices, shell-settings-error, archive-error, fileops-opus-r2-explain, sync-compare-errors, sync-compare-glob, browse-sol2-app-cross, remote-opus-reconnect), `OpenWithSection.test`, `ConnectErrorBox.test`, `ConnectionBanner.test`.

## IPC·설정·저장 형식 변경

- 없음. `src-tauri/src/commands`·`types` 미변경 → Tauri command 시그니처·바인딩·설정 파일 불변.
- BE 변경은 `ssh/remote_exec.rs` 오류 **문구**뿐: `ssh: exec '<cmd>': <e>` → `ssh: exec <program>: <e>`. 옛 `exec '` 문구에 의존하는 코드·테스트는 없음(src·src-tauri grep 확인).
- FE 공개 API 추가: `src/lib/errorToast.ts`(`showError`, `errorToastText`), `useToast` 의 `pause`/`resume`, `ExplainedError.target?`, `HostOs` 에 `macos`·`linux`(기존 `unix` 호환).

## 기기 확인 필요

- **Windows 실기**: errno 21·225·362·1326·145 와 Winsock 100xx 원문 모양, `C:\`·`\\?\` 경로에서 이름 추출, WebView2 의 클릭 포커스 순서(알림 배지 "모두 지우기" 뒤 포커스 복귀), 토스트 hover — 정지한 포인터 아래로 카드가 옮겨질 때 mouseleave 가 오는지.
- **실서버**: archive-32·R3-06 의 원격 tar/unzip stderr 모양(GNU tar "Cannot exec", bsdtar "unable to run program", `unrecognized option '--zstd'`, `invalid option -- 'J'`, unzip exit 1/50/81), 원격 SFTP 경로-only 오류.
- **실앱(macOS WKWebView)**: 토스트 hover/focus 정지·재개, 배지 Esc·Tab, 연결 오류 상자 툴팁.

## 게이트 결과 (fix/errors 최종, lead worktree)

| 명령                                                                    | 결과                                                                                 | fix/base 대비                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo fmt --check`                                                     | 통과                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cargo clippy --all-targets -D warnings`                                | 실패 — `core/ops.rs:5656`, `fs/local.rs:637`, `tests/review_remote_opus_handle.rs:5` | **기준선 실패, 변화 없음**(메인 공지 목록). 우리 Rust 변경은 `ssh/remote_exec.rs` 뿐, 경고 0                                                                                                                                                                                                                                                                                                                                          |
| `cargo clippy --target x86_64-pc-windows-gnu --all-targets -D warnings` | 실패 — 위 + `core/archive_review_opus.rs:993,1012,1021`(Windows 전용 dead_code)      | 기준선(archive 팀 재현 파일, 우리 미변경. browse 팀도 fix/base 에서 같은 결과 기록)                                                                                                                                                                                                                                                                                                                                                   |
| `cargo test --lib`                                                      | 통과 — 443 passed / 109 ignored                                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cargo test --tests --no-fail-fast`                                     | 실패 1 — 39개 테스트 실행 파일, 519 passed / **1 failed** / 241 ignored(lib 포함)    | 기준선: `mvp2_smoke::smoke_copy_with_conflict_creates_backup_and_undo_restores`(Replace 후 `.bak` 기대 — §4 2026-06 예외와 충돌). browse 팀이 fix/base 임시 worktree 에서 같은 실패 확인, undo·persist 팀도 기록. 우리는 `src-tauri/src/core`·이 테스트 미변경                                                                                                                                                                        |
| `pnpm gen:bindings && pnpm exec tsc --noEmit`                           | 통과                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm lint`                                                             | 통과                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm exec prettier --check .`                                          | 실패 — 60개 파일(docs·`eslint.config.js`·`pnpm-lock.yaml`·`__review__` 재현 테스트)  | 기준선. 우리가 바꾼 파일 중 목록에 남은 4개(`shell-settings-toast-notices`, `archive-error`, `fileops-opus-r2-explain`, `remote-opus-reconnect` 테스트)는 **fix/base 에서 이미 미포맷**(stdin 검사로 확인) — 다른 팀 충돌을 피하려 재포맷 안 함. fix/base 에서 깨끗했던 `sync-compare-errors.test.ts` 는 우리 변경이 깨뜨려 다시 맞춤(아래 커밋 목록의 마지막 `test: reformat the SC-15 repro`). 새로 만든·고친 제품 파일은 모두 통과 |
| `pnpm exec vitest run --minWorkers=1 --maxWorkers=2`                    | **통과 — 150 files / 988 tests**                                                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 라운드 기록

- **PLANNING**: lead 가 plan.md 작성. 파일 소유를 나눔 — lead: 헬퍼·remote_exec.rs·연결 UI·App.tsx / opus: error.ts·i18n errors·fileActions·entryMenu·hooks·components / sol: toast·NoticeBadge·stores·lib(drag/drop/dirSize)·windows.
  메인 공지 2건 반영(paths 팀 IntoItself — opus 에게 전달, 기준선 clippy 제외 목록).
- **R1**: lead 4 커밋(헬퍼, 암호 노출, remote-26, App.tsx). sol 5 커밋(G-18 2 + 호출부 3) — lead 승인·cherry-pick. opus 11 커밋(error.ts 7 + 호출부 4) — lead 승인·fast-forward. 통합 후 lead 가 테스트 기대값 2 커밋(연결 원인 문장, OpenWith disk full).
  sol 이 opus 대기 중 lead 커밋 4개를 리뷰(sol-2): **지적 3**(App 압축·repack·해제 토스트 이름 누락 P2, remote_exec 호출부를 잡지 못하는 테스트 P2, ConnectErrorBox 테스트 권고 P3) → lead 가 3 커밋으로 반영.
- **R2 (교차)**: sol → opus 11 커밋(sol-3): **지적 6 + 질문 1 + lead 인계 1** — P2 3(백업 경로 잘림, 파일명 단어가 원인 뒤집음, execute 실패 이름 누락), P3 3(URL·CIDR 오인, 파일 timeout 을 서버 탓, `--zstd` 미지원을 미설치로), Q1(이름 두 번), X1(App 재연결 catch 원문 손실). opus → sol 5 커밋(opus-2): **지적 2**(P3 — 다른 모달 Esc/Tab 가로챔, Windows 클릭 포커스 복귀), 변이 실험 6건으로 sol 테스트 유효성 확인.
- **R3**: opus 가 6 + Q1(lead 결정: 원문에서 찾은 실패 항목 이름이 있으면 그것만) 을 7 커밋으로(중복 테스트 정리 커밋은 lead 가 squash). sol 이 2 커밋. lead 가 X1 1 커밋. 모두 lead 가 읽고 승인·cherry-pick. 남은 지적 없음.

## 커밋 목록 (`git log --oneline fix/base..fix/errors`)

```
04d5d1c test: reformat the SC-15 repro after removing it.fails
236285c fe/ui: remember notice focus before pointer activation
423951f fe/ui: preserve navigation keys for other open dialogs
01a264d fe/lib: tell an old tar apart from a missing compression program
bea65d0 fe/lib: don't blame a server for timeouts outside a connection
d909e1f fe/lib: don't read quoted URLs, addresses or ratios as file names
28b5b5e fe/lib: name only the failed item when the original already has one
2145820 fe/lib: name the single item in copy/move execute failure toasts
69c20df fe/lib: keep file names from overriding the error kind
e8324f9 fe/lib: take the whole backup path between marker and rollback suffix
f6fec97 fe/ui: keep the backend original when quick reconnect throws
31278c6 test: expect the explained disk-full sentence in the Open With save toast
cf123d4 test: expect explained connection causes in the connect box and banner
c92b795 fe/ui: keep item name and raw text in component error toasts
9fc51f3 fe/hook: keep raw error text in hook error toasts
975a0af fe/lib: route entry menu error toasts through showError
fedb58f fe/lib: route fileActions error toasts through showError
914a27f fe/lib: show the backup location when a folder replace rollback fails
04dd25a fe/lib: explain unsupported sync pairs and point to Compare
b51c20c fe/lib: explain archive and remote extract errors in plain words
1602779 fe/lib: keep the failed file name in explained errors
afdda48 fe/lib: explain connection refused, timeout, unreachable, DNS and reset
85d04ef fe/lib: explain Windows device, network logon, virus and cloud file errors
4954b1c fe/lib: read errno with macOS/Linux tables and skip local table for SSH
be89e27 fe/ui: name the archive in compress, repack and extract error toasts
7309017 test: cover the connect error box hiding OS error numbers
f20a886 test: guard remote exec call sites against leaking the command
78dda17 fe/lib: retain drag and directory-size failure details
7d18b3f fe/store: localize store failure toasts and retain error details
3a1283d fe/store: preserve original errors in saved-item and settings notices
5b5ceb5 fe/ui: fix notice read tracking and keyboard focus
c6d61a0 fe/ui: pause toast auto-dismiss while hovered or focused
c960296 fe/ui: route App error toasts through showError
6f8e624 fe/ui: explain connection errors in the connect box and banner
bb59b11 be/ssh: keep remote command text out of exec errors
7270125 fe/lib: add showError helper that keeps target name and original text
```
