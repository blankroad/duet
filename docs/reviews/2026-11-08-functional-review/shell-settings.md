# shell-settings 점검 최종 보고

팀: lead(Opus 5.5) · opus 워커(Opus 5.5) · sol 워커(Codex GPT-6.1-Sol). WT `review/shell-settings`(main adce9f4 기준). 2026-11-08. 라운드 2회(R3 불필요).

## 요약

- 사이드바·설정·키맵·알림·Windows 연동은 정상 경로에서 대체로 동작하지만, **설정 파일 하나가 손상되면 앱이 창도 못 띄우는 P1** 이 1건 있다. keymap.toml 오타 한 글자, 또는 파일 작업 중 강제 종료로 journal 줄이 붙는 것만으로 재현된다. Windows 릴리스는 콘솔이 없어 사용자에겐 "아무것도 안 뜸" 으로만 보이고 스스로 복구할 수 없다.
- P1 1 · P2 11 · P3 19 (총 31) + 개선 제안. 31건 모두 두 명 이상이 확인(교차 검토 또는 lead 재실행). Windows 실기로만 확정 가능한 4건(07·09·10·11)은 코드·공식 규칙·라이브러리 소스로 교차 확인 후 `기기확인필요`.
- 다음으로 중요한 것: 저장 실패해도 백엔드가 새 값을 들고 있다가 나중 저장에 섞어 넣음(영구 삭제 허용이 몰래 켜짐, 02), 이번 세션 `explainError` 변경으로 즉시 실패 토스트가 "어느 파일" 을 잃음(04 회귀), 한글 IME 조합 중 Enter/Esc 오동작이 사이드바 필터·런처 이름·공통 대화상자에 남음(05), Windows "duet 에서 열기" 가 드라이브 루트·복원된 SSH 탭에서 실패(07·08).

## 점검 범위

| ID   | 기능                                     | 결과                                                               | 확인 방법                                                   | 확인한 사람            |
| ---- | ---------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------- |
| C-01 | 위치(places)                             | 이슈(09) / 기기확인필요                                            | 코드 추적 + Windows 전용 테스트(크로스 clippy 컴파일)       | sol, opus(R2)          |
| C-02 | 볼륨·꺼내기                              | 이슈(09) + 개선 / 기기확인필요                                     | 코드 추적, platform 테스트 15 통과                          | sol                    |
| C-03 | 북마크                                   | 이슈(03·13·19·20)                                                  | Vitest·Rust 재현                                            | opus, sol(R2)          |
| C-04 | 즐겨찾기 호스트·그룹·별명                | OK + 이슈(30)                                                      | Vitest 6(정상 5 + 재현 1)                                   | opus(R2), lead(재실행) |
| C-05 | 최근                                     | OK (+28 localStorage 모양)                                         | 코드 추적                                                   | opus                   |
| C-06 | 선반                                     | 이슈(06·31)                                                        | Vitest 재현, sol 독립 재현(완료 이벤트까지)                 | opus, sol(R2), lead    |
| C-07 | 태그                                     | 이슈(19)                                                           | Vitest 재현                                                 | opus, sol(R2)          |
| C-08 | 사이드바 필터·상태 점·폭                 | 이슈(05·21·22)                                                     | Vitest 재현                                                 | opus, sol(R2)          |
| C-09 | 설정 대화상자·저장                       | 이슈(02·26). 영구 삭제 흐름 §3 충족                                | Rust·Vitest 재현, 게이트 추적                               | opus, sol(R2)          |
| C-10 | 키맵                                     | 이슈(02·12·18·29) + 개선                                           | Rust·Vitest 재현, 기존 18 테스트 통과                       | sol, opus(R2)          |
| C-11 | 명령 팔레트                              | OK + 이슈(21)                                                      | 기존 smoke, IME 가드 확인                                   | opus                   |
| C-12 | 사용자 별칭                              | OK + 개선                                                          | 코드 추적                                                   | opus                   |
| C-13 | 앱 실행기·연결 프로그램                  | OK + 이슈(05 런처 이름) + 개선                                     | 기존 테스트, Vitest IME 재현                                | opus, sol(R2)          |
| C-14 | 상단 바·상태바                           | OK + 이슈(22)                                                      | 코드 추적                                                   | opus                   |
| C-15 | 토스트·알림 배지                         | 이슈(04·23·24·25)                                                  | Vitest 재현 9 + 호출부 전수 스캔                            | opus, sol(R2), lead    |
| C-16 | 오류 해석표                              | 이슈(14·15) + 개선                                                 | Vitest 재현, macOS SDK errno.h·Linux 헤더 대조              | sol, opus(R2)          |
| C-17 | i18n 키 짝·하드코딩 문구                 | 키 짝 OK, 이슈(27)                                                 | 스크립트 비교 + grep + TS AST                               | lead, opus, sol(R2)    |
| C-18 | 키·색 하드코딩                           | OK(위젯 내부 탐색키는 알려진 B-01 부류) + 개선                     | grep                                                        | lead                   |
| C-19 | Windows 셸 메뉴                          | 이슈(10·16) / 기기확인필요                                         | 코드 추적, COM STA 단일 스레드 확인                         | sol, opus(R2)          |
| C-20 | "duet 에서 열기"·기본 폴더 핸들러        | 이슈(07) + 개선. HKCU 만 수정, 해제 시 이전 값 복원 로직 있음      | 코드 추적                                                   | sol, opus(R2)          |
| C-21 | 단일 인스턴스·경로 열기                  | 이슈(07·08·17)                                                     | Rust resolve 테스트 4, App 수준 cold start 재현             | sol, opus(R2)          |
| C-22 | OS 파일 클립보드                         | 이슈(11, P3) / 기기확인필요                                        | 코드 추적, 기존 순수 테스트                                 | sol, opus(R2)          |
| C-23 | 아이콘·터미널·기본 앱·reveal·휴지통 열기 | OK(인자 argv 전달, 셸 인젝션 없음, 시스템 ssh 없음) / 기기확인필요 | 코드 추적                                                   | sol                    |
| C-24 | 테마                                     | OK + 개선(부팅 깜빡임)                                             | 토큰 비교 스크립트(다크·시스템 다크 30개 동일)              | lead                   |
| C-25 | 설정 파일 손상 시 부팅                   | **이슈(01, P1)**                                                   | Rust 재현 10 + journal 이어붙음 재현                        | lead, opus(R2)         |
| C-26 | 프론트 세션 복원 손상                    | 세션 OK, 이슈(28)                                                  | Vitest 재현                                                 | lead, sol(R2)          |
| X    | Windows 크로스 clippy                    | exit 0, 기존 경고 1(`fs/local.rs:637`, 범위 밖)                    | `cargo clippy --target x86_64-pc-windows-gnu --all-targets` | sol(R1·R2)             |

## 이슈 대장

심각도순. 재현 파일 경로는 WT 기준. "교차" = 다른 사람의 독립 재검증 결과.

### P1

**shell-settings-01 [P1] [bug] 설정 파일 하나가 손상되면 앱이 시작되지 않는다**

- 사용자 증상: 아이콘을 눌러도 아무 창도 안 뜬다(Windows 릴리스는 콘솔 없음 `main.rs:2`). 복구하려면 `%APPDATA%\duet\` 의 파일을 찾아 지워야 한다.
- 현실 경로: ① keymap.toml 손편집 오타(감시 기능이 손편집을 지원하는 파일, 실행 중엔 조용히 무시 → 다음 실행에서 실패, 12) ② **journal 이어붙음**: `journal.rs:425-428` 이 레코드와 `\n` 을 두 번에 나눠 써서, 그 사이 강제 종료되면 다음 파일 작업 기록이 같은 줄에 붙고 그다음 부팅부터 실패(원인 시점과 증상 시점이 어긋남, 모든 복사·이동·삭제가 쓰는 파일) ③ 모든 store 저장이 `tokio::fs::write` 직접(비원자) → 쓰는 중 전원 차단·디스크 가득 시 잘린 파일.
- 근거·재현: `src-tauri/tests/review_shell_settings_boot.rs` 10건(keymap·settings 2·bookmarks·launchers·aliases·favorites·groups·saved-hosts·journal) 표시 없이 FAILED, 대조군(tags·frecency·nicknames 는 이미 관대) 통과. `src-tauri/tests/review_shell_settings_r2.rs` journal 이어붙음 → `journal line 1 parse: trailing characters at line 1 column 246`.
- 원인: `src-tauri/src/lib.rs:263-315` 각 `load_default().expect(...)`, 각 store `load_from` 이 parse Err 를 `?` 로 전파(`settings.rs:182-196`, `keymap.rs:99-115`, `bookmarks.rs:39-55`, `journal.rs:436-450` 등).
- 수정안: (a) 손상 시 원본을 `*.corrupt-<시각>` 으로 보존하고 기본값으로 부팅 + 시작 후 토스트("설정 파일을 읽을 수 없어 기본값으로 시작했습니다 — 원본은 …"), journal 은 깨진 줄만 건너뛰기 (b) 쓰기를 임시 파일 + rename 원자적 쓰기 공통 헬퍼로, journal 은 레코드+`\n` 을 한 번에 write (c) `expect` 대신 오류 창. 비용 M.
- 상태: 확인됨. 교차: opus 동의(P1 유지) + 실제 발생 경로 재현 추가.

### P2

**shell-settings-02 [P2] [bug] 저장이 실패해도 백엔드는 새 값을 들고 있다가 다음 저장에 섞어 넣는다 — 영구 삭제 허용이 몰래 켜질 수 있음**

- 증상: 설정 폴더 쓰기 실패 중 "영구 삭제 사용" 을 켜면 "저장 실패" 토스트가 뜨고 체크도 꺼진 채인데, 나중에 테마 등 아무 설정이 성공하면 그 응답으로 영구 삭제가 켜진다(디스크에도 기록). 키맵·북마크·별칭·즐겨찾기·태그·그룹도 "실패한 추가가 나중에 나타남".
- 범위 정정(교차): 이는 **허용 설정이 사용자 모르게 켜지는 것**이지 삭제가 저절로 영구 삭제되는 것은 아니다 — 영구 삭제 실행 시 단어 확인은 그대로 요구(`core/ops.rs:215-225`, `commands/fs_ops.rs:517-523,689-695`).
- 재현: `services::settings::review_shell_settings::{failed_apply_does_not_leak_into_next_save, failed_permanent_delete_is_persisted_by_next_unrelated_save}`, `review_shell_settings_keymap.rs::failed_save_retains_last_successful_bindings`, `services::bookmarks::review_shell_settings::failed_add_is_not_kept_in_memory` — 모두 `#[ignore]`, 표시 없이 FAILED.
- 원인: write lock 안에서 메모리를 먼저 바꾸고 디스크 실패 시 되돌리지 않음 — `settings.rs:203-279`, `keymap.rs:64-95`, `bookmarks.rs:77-79`, `user_aliases.rs:84`, `host_favorites.rs`, `tags.rs set`, `host_groups.rs set`.
- 수정안: 사본에 변경 → 원자적 쓰기 성공 후 교체(01 의 공통 헬퍼와 같이). 비용 S~M.
- 상태: 확인됨. 교차: sol 동의(P2, 확대 해석만 반박), opus 동의(키맵 부분).

**shell-settings-03 [P2] [bug] 예전 SSH 북마크 이전: 즐겨찾기 저장이 실패해도 원본 북마크를 지운다**

- 증상: 업그레이드 후 부팅 때 원격 북마크가 호스트 즐겨찾기로 옮겨지는데, 즐겨찾기 저장 실패 시 북마크가 어디에도 남지 않음. 토스트는 "N개 이전됨".
- 재현: `src/components/__review__/shell-settings-sidebar.test.tsx` (shell-settings-03). 원인 `src/stores/bookmarks.ts:45-47`(`addHostFavorite` 반환 무시). 매 부팅 검사하나 성공한 항목은 원본이 지워져 사실상 1회(`App.tsx:2083`).
- 수정안: 추가 실패 시 `continue`. 비용 S. 상태: 확인됨(교차 sol 동의).

**shell-settings-04 [P2] [ux] 즉시 실패하는 작업의 오류 토스트가 "어느 파일이" 실패했는지 잃는다 — 이번 세션 `explainError` 변경의 회귀**

- 증상: "권한이 없습니다. 이 위치의 접근 권한을 확인하세요." 처럼 원인만 나오고 대상이 없으며, 알림 목록 "자세히" 에도 원문이 없다. 이전 `formatErr` 는 `라벨 — 원문(경로 포함)` 이었다(`0cf98a9^`).
- 범위 정정(교차): 비동기 작업(복사·이동·삭제 실행) 실패는 `useTaskEvents.ts:147-162` 가 알림 detail 에 원문·파일명을 남긴다. 손실되는 것은 `formatErr` 만 쓰는 **즉시 실패** 경로 — plan/IPC 실패(`fileActions.ts:445-451,527-535`), 인라인 이름 바꾸기(`InlineRenameInput.tsx:94-96,127-138`) 등. `formatErr(` 호출 92곳 중 detail 전달은 4곳.
- 재현: `src/components/__review__/shell-settings-toast-notices.test.tsx` (shell-settings-04 2건).
- 수정안: `showError(prefixKey, e)` 헬퍼가 `explainError` 의 text+detail 을 함께 넘기게 하고 호출부 치환, 경로가 있는 원인은 basename 을 문장에 붙임. 비용 M. 상태: 확인됨.

**shell-settings-05 [P2] [bug] 한글 IME 조합 중 Enter/Esc 오동작 — 사이드바 필터, 런처 폴더 이름, 공통 대화상자 Esc**

- 증상: 사이드바 필터에서 조합 확정 Enter 가 반쯤 쓴 검색어의 첫 결과를 바로 연다(패널 이동·서버 접속), Esc 가 필터 전체를 지움. 런처 폴더 이름 편집에서 조합 Enter 가 미완성 이름으로 저장, Esc 가 편집 취소. 북마크·별명·태그·설정 대화상자에서 조합 취소 Esc 가 대화상자를 닫음.
- 재현: `shell-settings-filter-palette.test.tsx` 2건, `shell-settings-ime.test.tsx` 3건(lead 재실행 확인). 원인: `SidebarFilter.tsx:48-65`, `AppLauncherStrip.tsx:335,359-367` 가드 없음; `dialogs/DialogShell.tsx:105-109` 에 `onEscapeKeyDown` 조합 차단 없음 — Radix 는 document capture 에서 Escape 를 처리하므로 input 의 가드로는 못 막음. 팔레트·PromptDialog Enter 는 가드 있음.
- 수정안: `isImeComposing` 가드 추가 + DialogShell `onEscapeKeyDown` 에서 조합 중이면 `preventDefault`. 비용 S. 상태: 확인됨(opus 발견 → sol 재현·범위 확장 → lead 재실행). 실제 IME 이벤트 순서는 기기확인필요.

**shell-settings-06 [P2] [bug] 선반에 출처가 다른 항목(로컬+서버)이 섞이면 "다시 적용" 이 영원히 첫 그룹만 처리**

- 증상: "다른 소스의 1개 그룹이 선반에 남음 — 다시 적용하세요" 대로 다시 눌러도 같은 첫 그룹(복사면 충돌 대화상자, 이동이면 원본 없음).
- 재현: `shell-settings-sidebar.test.tsx` (06), sol 독립 재현 `src/lib/__review__/shell-settings-cross-shelf.test.ts`(plan→execute→완료 이벤트→재적용까지). 원인 `src/lib/fileActions.ts:578-602` 항상 `groupList[0]`, 성공 항목을 선반에서 빼지 않음.
- 수정안: 그룹 순차 처리 또는 성공 항목 제거. 비용 S~M. 상태: 확인됨.

**shell-settings-07 [P2] [bug] Windows: 드라이브 루트 `C:\` 를 "duet 에서 열기"/기본 핸들러로 열면 아무것도 안 열림**

- 원인: 레지스트리 명령 `"<exe>" "%1"`(`platform/mod.rs:733-743`) → `"C:\"` 의 `\"` 가 따옴표 이스케이프로 해석돼 argv 가 `C:"`. Rust std `parse_lp_cmd_line`·single-instance 2.4.2(`std::env::args()` 전달) 모두 같은 규칙 → `resolve_open_path`(`commands/system.rs:781-789`)가 metadata 실패로 조용히 None.
- 재현: `platform::review_shell_settings::registered_drive_root_and_trailing_separator_roundtrip` (Windows 전용, `#[cfg(all(test, windows))]`, ignored).
- 수정안: 끝 `X:"` 는 `X:\` 로 복원(따옴표만 지우면 `C:` = 드라이브의 현재 폴더라 틀림 — VS Code `preparePath` 선례), platform 모듈에서 처리(§7). 비용 S~M.
- 상태: 기기확인필요(교차 opus 동의).

**shell-settings-08 [P2] [bug] cold start: 마지막 세션의 왼쪽 탭이 SSH 였으면 탐색기에서 연 로컬 폴더가 열리지 않음**

- 증상: 서버 탭을 띄운 채 앱을 닫고 탐색기에서 "duet 에서 열기" → "열 수 없음 — 서버에 연결할 수 없습니다", 고른 폴더는 어디에도 안 열림. warm start(이미 실행 중)는 정상.
- 재현: `src/__review__/shell-settings-coldstart.app.test.tsx` (App 전체 렌더) → `listDirectory` 가 `ssh:/home/b` 로 호출. 원인 `App.tsx:2075-2079` `navigate("left", path)` 가 `{...from.location, path}` 로 활성 탭의 SSH source 를 상속(`App.tsx:240-243`, `stores/panes.ts:655-666`). 비교 `useOpenPathEvents.ts:21-24` 는 로컬 새 탭.
- 수정안: cold start 도 로컬 Location 으로 새 탭 + 활성화(warm 과 공통 경로). 비용 S. 상태: 확인됨(sol 발견, opus 앱 수준 재현).

**shell-settings-09 [P2] [bug] Windows 클라이언트에서 원격 위치·볼륨 경로가 `/home/u\Documents` 로 만들어짐**

- 증상: 원격 Documents/Downloads 등이 사이드바에서 빠지고, 원격 볼륨을 누르면 없는 경로를 연다.
- 원인: `commands/system.rs:560,593,607` native `Path::join`. 나머지 원격 코드는 `fs::posix_join`(`fs/mod.rs:23-31`) 사용, `fs/ssh.rs:652-658` 는 `\` 를 파일명 글자로 그대로 보냄.
- 재현: `commands::system::review_shell_settings::remote_places_and_volumes_keep_posix_separators`(Windows 에서만 의미, ignored). 수정안: `posix_join` 으로 교체. 비용 S. 상태: 기기확인필요(교차 opus 동의).

**shell-settings-10 [P2] [bug] Windows: 폴더 빈 곳 우클릭 "More options" 가 배경 메뉴가 아니라 현재 폴더 자체의 메뉴**

- 증상: 빈 곳 메뉴에 "새로 만들기" 등 배경 항목이 빠지고 **현재 폴더 자체의** 삭제·잘라내기·이름 바꾸기·속성이 나옴 — "선택 항목 삭제" 로 오해해 누르면 보고 있는 폴더가 통째로 Windows 휴지통행(duet journal 밖이라 Ctrl+Z 불가, §4). 휴지통에서 복구는 가능해 P1 은 아님.
- 원인: `platform/shell_menu.rs:441,457,471-474` scope 무시, 항상 `SHBindToParent` → `GetUIObjectOf([child])`. 수정안: Background 는 `IShellFolder::CreateViewObject` 경로로 분기. 비용 M. 상태: 기기확인필요(교차 opus 동의, P2 중 높은 쪽).

**shell-settings-12 [P2] [ux] 앱 실행 중 keymap.toml 을 잘못 저장해도 아무 알림이 없다**

- 증상: 이전 키가 유지되어 문제를 모르다가, 재시작하면 01 로 부팅 실패.
- 원인: `services/keymap_watcher.rs:59-64` `tracing::warn!` 후 return. 수정안: 키맵 오류 이벤트 → 토스트("keymap.toml 을 읽을 수 없어 이전 설정 유지: 줄 N"). 비용 S. 01 이 고쳐지면 P3.
- 상태: 확인됨(sol, 교차 opus 동의).

**shell-settings-13 [P2] [ux] 패널에서 사이드바로 끌어 북마크하면 토스트에 `“{{name}}”` 가 그대로 보이고, 중복·파일도 북마크된다**

- 재현: `shell-settings-sidebar.test.tsx` (13). 원인 `src/hooks/useEntryDrag.ts:166-177`(`{count}` 만 전달, 중복·종류 검사 없음; ★ 버튼 경로 `bookmarkActions.ts:39` 는 중복 검사). 수정안: 개수용 i18n 키 + 중복·파일 건너뛰기. 비용 S. 상태: 확인됨(교차 sol 동의).

### P3

| ID                | 종류 | 제목                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 재현·원인                                                                                                         | 상태                                        |
| ----------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| shell-settings-11 | bug  | Windows OS 파일 클립보드: `OpenClipboard(NULL)` — MS 문서상 실패 조건이나 `clipboard-win`/`arboard` 도 같은 순서로 동작해 "항상 실패" 는 근거 약함. 확실한 것: 실패 시 HGLOBAL 누수, FE 가 결과 무시                                                                                                                                                                                                                                                                                                                                               | `platform/file_clipboard.rs:136-141,159-161`, `fileActions.ts:196-204`                                            | 기기확인필요 (sol P2 → opus 반박 → P3 합의) |
| shell-settings-14 | bug  | errno 표가 macOS/Linux 를 "unix" 하나로 묶음 — mac 36·Linux 63/69 오해석(파일 작업에선 드묾), ENOTEMPTY(39/66)·mac ENOTSUP 45 는 원인 안내 없이 "I/O 오류 — Directory not empty"                                                                                                                                                                                                                                                                                                                                                                   | `src/lib/__review__/shell-settings-error.test.ts`, `error.ts:79-91`                                               | 확인됨                                      |
| shell-settings-15 | bug  | 오류 패턴이 경로 포함 원문 전체에 적용 — 파일명에 "bad header"·"already exists" 가 있으면 엉뚱한 원인                                                                                                                                                                                                                                                                                                                                                                                                                                              | 같은 파일, `error.ts:163-180`                                                                                     | 확인됨                                      |
| shell-settings-16 | ux   | 셸 메뉴 항목 실행 실패(특히 토큰 만료)가 아무 반응 없음                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `shell-settings-shell-menu.test.ts`, `shell_menu.rs:355-363`, `commands/system.rs:743`, `shellMenu.ts:47-48`      | 확인됨 / 기기확인                           |
| shell-settings-17 | bug  | warm start 상대경로를 두 번째 프로세스 cwd 가 아닌 첫 프로세스 기준으로 해석(CLI 한정)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `lib.rs:326` `_cwd`                                                                                               | 확인됨                                      |
| shell-settings-18 | bug  | 시작 후 첫 외부 편집이 keymap.toml "전부 비우기" 면 watcher 가 무시. (낮은 확신) 앱 저장의 truncate→write 사이를 watcher 가 읽으면 잠깐 빈 키맵                                                                                                                                                                                                                                                                                                                                                                                                    | `keymap_watcher.rs:35-36,67-78`, `keymap.rs:131`                                                                  | 확인됨(코드)                                |
| shell-settings-19 | bug  | 북마크·즐겨찾기·호스트를 지워도 태그 칩이 유령으로 남음                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `shell-settings-sidebar.test.tsx`, `bookmarks.ts:76-87`, `tags.ts:39-42`                                          | 확인됨                                      |
| shell-settings-20 | bug  | 재정렬 요청에 중복 id → 북마크/즐겨찾기 소실·런처 복제(UI 로는 거의 불가)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `services::bookmarks::review_shell_settings`, `bookmarks.rs:110-126`                                              | 확인됨                                      |
| shell-settings-21 | bug  | macOS NFD 한글 이름이 사이드바 필터·팔레트에서 검색 안 됨                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `shell-settings-filter-palette.test.tsx`, `sidebarFilter.ts:43-47`, `fuzzy.ts:11-15`                              | 확인됨                                      |
| shell-settings-22 | ux   | 연결 오류 점 툴팁 없음·상태바 툴팁 백엔드 원문·상태 점 스크린리더 무시                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `shell-settings-sidebar.test.tsx`, `Sidebar.tsx:1852-1888`, `StatusBar.tsx:154-159`                               | 확인됨                                      |
| shell-settings-23 | ux   | 토스트가 hover/포커스 중에도 사라짐(설계상 자동 소멸이지만 읽기 편의 개선)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `shell-settings-toast-notices.test.tsx`, `toast.ts:72-74`                                                         | 확인됨                                      |
| shell-settings-24 | ux   | 오류 토스트 4개가 떠 있으면 새 성공 토스트가 즉시 버려져 한 번도 안 보임(희생 우선순위 규칙의 결과 — 제품 선택)                                                                                                                                                                                                                                                                                                                                                                                                                                    | 같은 파일, `toast.ts:66-69`                                                                                       | 확인됨                                      |
| shell-settings-25 | bug  | 알림 배지: 50개 상한 후 열린 채 새 알림 읽음 처리 누락 / 모두 지우기 후 포커스 body / 포커스 트랩 없음 + 열린 동안 전역 키 차단                                                                                                                                                                                                                                                                                                                                                                                                                    | 같은 파일 3건, `NoticeBadge.tsx:27-29,87-100`, `keyIsolation.ts:40-44`                                            | 확인됨                                      |
| shell-settings-26 | bug  | 설정 "편집기 명령" 입력칸이 글자마다 저장 → 빠르게 치면 글자 빠짐                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `shell-settings-general.test.tsx`, `GeneralSection.tsx:89-103,324-329`                                            | 확인됨                                      |
| shell-settings-27 | ux   | 하드코딩 영어 사용자 문구: 오류 토스트 접두 14곳(`Set tags:`, `Launch failed:`, `Reset keymap:`, `Group update failed:` …, stores/{appLaunchers,userAliases,sidebarGroups,hostNicknames,keymap,tags}.ts·lib/{dirSize,dropTray,dragOut}.ts), dirSize 실패가 info 종류(기록 안 남음), 동적 명령 `Connect:`/`Bookmark:`, 선반 기본 섹션 `Main`, 알림 시각이 OS 로캘, 저장 호스트 툴팁 `(key: …)`, 아이콘 선택기 이름 30개(`iconPalette.ts:50-80`), 완료/취소 토스트에 백엔드 영어 작업 제목(`완료: Copying …`, `fs_ops.rs:128-129`). ko/en 키 짝은 OK | grep + AST 스캔                                                                                                   | 확인됨                                      |
| shell-settings-28 | bug  | localStorage 의 모양이 틀린 값(`null`·객체)이면 최근 폴더·팔레트 최근·사이드바 접힘이 throw(세션 복원은 이미 검증, ErrorBoundary "상태 초기화" 로 복구 가능)                                                                                                                                                                                                                                                                                                                                                                                       | `src/stores/__review__/shell-settings-localstorage.test.ts`, `recents.ts:21-26`, `palette.ts:6-11`, `ui.ts:60-67` | 확인됨                                      |
| shell-settings-29 | bug  | AltGr+숫자 입력이 사용자 지정 Ctrl+Alt+숫자 단축키로 인식(기본 키와는 안 겹침)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `src/lib/__review__/shell-settings-keymap.test.ts`, `keyEvent.ts:26-29`                                           | 확인됨                                      |
| shell-settings-30 | bug  | 별명을 붙인 호스트는 행에 함께 보이는 원래 이름(alias)으로 사이드바 필터에 안 걸림(팔레트는 둘 다 검색)                                                                                                                                                                                                                                                                                                                                                                                                                                            | `shell-settings-hosts.test.tsx`, `Sidebar.tsx:1032,1714`                                                          | 확인됨(opus, lead 재실행)                   |
| shell-settings-31 | bug  | 활성 패널이 가상 휴지통이어도 선반 적용이 plan 까지 진행(F5 는 막음)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `shell-settings-sidebar.test.tsx`, `fileActions.ts:578-602` vs `:612`                                             | 확인됨(opus, lead 재실행)                   |

## 개선 제안

- keymap.toml 수동 표기 정규화·검증(`ctrl+t`·`Cmd+T` 가 목록엔 보이나 동작 안 하고 기본 키도 막음) — 재현 `shell-settings-keymap.test.ts` (improve)
- 오류에 출처 OS·errno 를 구조화(원격 stderr 의 `(os error N)` 을 로컬 OS 로 해석할 여지 차단) — 재현 `shell-settings-error.test.ts` (improve)
- 같은 오류 연속은 "×N" 으로 합치기 — 재현 `shell-settings-toast-notices.test.tsx` (improve)
- 런처 스트립 가로 스크롤 힌트(Windows 휠), 앱 추가 기본 경로 `/Applications`·편집기 placeholder 가 Windows 에서 무의미, 연결 프로그램에 `tar.gz` 입력 시 매칭 불가, 별칭 빈 이름·호스트 0개일 때 '추가' 무반응·이름 중복 허용, 선반 섹션 삭제 확인 없음
- 테마: `index.html` 의 `data-theme="light"` 고정 → 다크 모드 사용자 부팅 시 밝은 화면 깜빡임. `<html lang="en">` 고정
- 색 토큰: `text-white`·`bg-black/50` 관례 대신 `--on-accent`·`--scrim` 토큰
- 레지스트리 상태 조회가 Directory 키 존재만 확인(Drive/Background 누락·낡은 exe 경로도 "등록됨"), 부팅 시 자동 갱신 없음, 오류 무시
- Windows 꺼내기 버튼이 SystemDrive 외 모든 드라이브에 표시
- 셸 메뉴 워커 `rx.await` 타임아웃 없음 — 멈춘 셸 확장 시 More options 무한 로딩 가능(기기 확인)
- `ErrorBoundary.tsx:26` 의 `console.error`(규칙: loglevel 사용)
- 기존 테스트 부채: `commands/system.rs:222-225 windows_trash_is_unsupported` 가 현재 Windows 구현과 반대 기대

## 기기 확인 필요

| ID   | 확인할 것                                                          | 방법                                                                                                                   |
| ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 07   | 드라이브 우클릭·더블클릭·`C:\` 빈 곳 "duet 에서 열기" 의 실제 argv | Windows 에서 `cargo test --lib platform::review_shell_settings -- --include-ignored` + 실앱 로그                       |
| 09   | Windows 클라이언트로 리눅스 서버 접속 시 사이드바 원격 위치·볼륨   | `cargo test --lib commands::system::review_shell_settings -- --include-ignored`(Windows), 실서버로 Documents 표시 확인 |
| 10   | 폴더 빈 곳 우클릭 More options 의 항목 구성                        | 실앱에서 항목 우클릭과 빈 곳 우클릭 비교                                                                               |
| 11   | duet Ctrl+C → 탐색기 붙여넣기, `SetClipboardData` 반환값           | 실앱                                                                                                                   |
| 16   | 셸 메뉴 실행 실패·토큰 만료(5분 방치 후 선택) 시 반응              | 실앱                                                                                                                   |
| 05   | Windows WebView2·macOS 의 실제 한글 IME 조합 이벤트 순서           | 실앱에서 필터·런처 이름·대화상자에 한글 입력                                                                           |
| 21   | macOS 에서 생성된 NFD 폴더 이름 빈도                               | 실기                                                                                                                   |
| C-02 | Windows PowerShell InvokeVerb eject 거부 시 종료 코드·FE 표시      | 실기 USB                                                                                                               |
| 08   | Windows 실제 흐름(서버 탭 남기고 종료 → 탐색기에서 열기)           | 실앱 — 앱 수준 재현은 이미 확인                                                                                        |

## 다른 영역으로 넘긴 것

- **remote(vault)**: `services/secret_vault.rs:33` 의 `unsafe` — CLAUDE.md §8(unsafe 는 platform/ 만) 위반. 코드 주석은 "secret_vault 한정 예외" 를 주장하나 CLAUDE.md 에 그런 예외가 없음 → 규칙 문서 동기화 또는 `zeroize` crate 결정. (참고: `clear()` 전 일반 쓰기는 최적화로 제거될 수 있어 volatile 쓰기가 아니면 zeroize 보장도 약함.)
- **browse/remote**: `commands/system.rs:379-403 download_to_temp` 가 모든 원격 파일을 `<temp>/duet-opened/<basename>` 하나에 덮어씀 — 다른 호스트·폴더의 동명 파일을 연이어 열면 앞 사본이 바뀜.
- **fileops**: 선반 "이동" 후 선반 항목이 옛 위치를 가리킴(06 과 같은 원인). 완료/취소 토스트의 영어 작업 제목(27 일부)은 task 제목 i18n 보류 항목과 연결.
- **sync-compare**: `compare_mtime_tolerance_ms` 를 백엔드가 범위 검증 없이 받음(음수 허용, `settings.rs:210`).

## 이미 알려짐 (재보고 안 함)

sidebar H-1(제거 undo 없음 — 별칭·선반 섹션 삭제 포함), H-2(호스트 제거 시 vault 잔존), file-view B-01(목록 키 하드코딩 — 사이드바·필터·팔레트 위젯 내부 ↑↓/Enter/Esc 도 같은 부류), 원격 이동 별칭 connection_id, 기본 키 완전 해제 불가, 설정 검색 없음, useEffect 데이터 페칭(GeneralSection·OpenWithSection 등).

## 라운드 기록

- **운영**: 팀 시작 스크립트가 두 워커 기동에 실패(launch.log) — lead 가 opus 워커를 직접 띄우고 두 워커에 소개 프롬프트를 다시 보냄.
- **R1**: lead C-17·18·24·25·26 (발견: 01 P1, 27, 28, 개선 2). opus C-03~09·11~15 (F-opus-01~16). sol C-01·02·10·16·19~23 (F-sol-01~15). lead 가 31건 대장으로 합치며 심각도 재판정: F-sol-06·07·09·10·03 P2→P3, F-opus-09 P3→P2, F-opus-07 은 02 로 통합.
- **R2 (교차)**: opus 가 sol 발견 13건 + lead 01 검증 — 동의 12, **반박 1**(11: 클립보드 "항상 실패" → P3 합의), 대장 제목 정정 1(14), cold start 앱 수준 재현·journal 이어붙음 재현 추가, C-04 채움(새 30). sol 이 opus 발견 13건 + lead 27·28 검증 — 동의 전부, **범위 조정 2**(02: 자동 영구 삭제 아님, 04: 비동기 작업 실패는 detail 보존), 성격 조정 2(23·24 → UX 개선 성격), IME 전수로 05 범위 확장(런처·공통 대화상자 Esc), 27 목록 보완.
- **R3**: 불필요 — 의견이 갈린 항목(11)은 R2 에서 근거로 합의, R2 신규(30·31·05 확장)는 lead 가 표시 없이 재실행해 11건 모두 의도한 assert 실패 확인.

## 재현 테스트

- 커밋: `949fc59` (`review/shell-settings`) — 테스트만 19파일 +1875줄. 제품 Rust 파일 4개는 끝에 `#[cfg(test)] mod review_shell_settings` 추가뿐(삭제 0줄).
- 파일:
  - Rust: `src-tauri/tests/review_shell_settings_{boot,keymap,r2}.rs`, `src-tauri/src/{commands/system.rs, platform/mod.rs(Windows 전용), services/bookmarks.rs, services/settings.rs}` 끝 `review_shell_settings`
  - Vitest: `src/__review__/shell-settings-coldstart.app.test.tsx`, `src/components/__review__/shell-settings-{filter-palette,general,hosts,ime,sidebar,toast-notices}.test.tsx`, `src/lib/__review__/shell-settings-{cross-shelf,error,keymap,shell-menu}.test.ts`, `src/stores/__review__/shell-settings-localstorage.test.ts`
- 표시: 결함 재현은 `it.fails("shell-settings-NN: …")` / `#[ignore = "shell-settings-NN repro…"]`. 수정 라운드에서 표시만 떼면 회귀 테스트가 된다. `shell-settings-improve` 는 개선 제안 재현.
- 실행 (표시 있는 상태, 모두 통과 확인):
  ```bash
  H=/Users/ctmctm/Desktop/01_PROJECT/duet-ux/_review/bin/heavy.sh
  bash $H pnpm exec vitest run --minWorkers=1 --maxWorkers=2 src/__review__ src/components/__review__ src/lib/__review__ src/stores/__review__   # 12 files / 52 passed
  bash $H cargo test --manifest-path src-tauri/Cargo.toml --test review_shell_settings_boot --test review_shell_settings_keymap --test review_shell_settings_r2   # ok (12 ignored)
  bash $H cargo test --manifest-path src-tauri/Cargo.toml --lib review_shell_settings   # 4 passed, 4 ignored
  # 결함 재현 확인: 위 cargo 명령에 `-- --include-ignored`, vitest 는 it.fails → it 사본으로
  # Windows 전용: Windows 에서 cargo test --lib platform::review_shell_settings -- --include-ignored
  ```
- `pnpm exec tsc --noEmit` exit 0, 새 Rust 테스트 파일 `rustfmt --check` 통과, Windows 크로스 clippy exit 0(sol).
