# browse 점검 최종 보고

2026-11-08 · WT `/Users/ctmctm/Desktop/01_PROJECT/duet-ux/browse` (review/browse, main `adce9f4` 기준) · lead Claude Opus 5.5, 워커 browse-opus(Claude Opus 5.5)·browse-sol(Codex GPT-6.1-Sol) · 3라운드.

## 요약

- 목록·탐색·탭·미리보기의 기본 흐름(탭 열기/닫기/핀/복원, 늦은 목록·미리보기 경쟁, 선택·키보드·marquee, 인라인 이름 변경)은 정상이다. 지난 라운드에 고친 경쟁 조건도 회귀하지 않았다.
- 이슈 34건: **P1 1 · P2 19 · P3 14**. 모두 재현 테스트나 실측·코드 근거가 있고, P2 이상은 두 사람 이상이 독립 확인했다.
- **가장 중요한 것(P1, browse-01):** 동영상·음성 미리보기가 브라우저의 `Range: bytes=0-` 요청에 파일 전체를 한 번에 메모리로 읽는다. 큰 영상이면 메모리 할당 실패로 앱이 통째로 종료될 수 있고, 원격이면 파일 전체를 내려받는다. Windows(WebView2/Chromium)는 이 요청을 보낸다는 소스 근거가 있다.
- 그다음 묶음: 원격 편집 라운드트립(서버 쪽 변경 덮어쓰기·저장 실패 무표시), 보이지 않는 선택 항목이 복사·삭제 대상에 남음, 원격↔로컬 소스가 섞이는 탐색 경로 3곳(반대 패널 열기·뒤로/앞으로·시작 경로/검색 결과), **한국어 Windows 메모장(CP949)·UTF-16 텍스트를 "바이너리"로 표시**.
- 제품 코드는 고치지 않았다. 재현 테스트만 `review/browse` 에 커밋했다(아래).

## 점검 범위

| ID   | 기능                                 | 결과                                                        | 확인 방법                                                                                                         | 확인한 사람             |
| ---- | ------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------- |
| C-01 | 로컬 목록(숨김·링크·비UTF-8·대량)    | 이슈(browse-21, 27) / Windows 기기확인                      | Rust 실행(tempdir, 20,000항목 44ms, 링크 순환 OK), Windows std 소스 추적(정션=Symlink→target stat), 크로스 clippy | sol, opus(R2)           |
| C-02 | 폴더 크기                            | 이슈(09, 18, 19, 20)                                        | Rust·Vitest 재현, 실제 `du` 실행                                                                                  | sol, opus(R2)           |
| C-03 | 미리보기 백엔드(인코딩·cap·스트리밍) | 이슈(01, 06, 33)                                            | Rust 재현, pdf.js 실측(Node)                                                                                      | lead, sol(R2), opus(R3) |
| C-04 | 썸네일·아이콘                        | 이슈(16, 29) / 기기확인                                     | Rust·Vitest 재현, unsafe 위치 확인(platform/ 안)                                                                  | sol, opus(R2)           |
| C-05 | 변경 감지·자동 새로고침              | 이슈(12, 13)                                                | notify 실행 재현, App 전체 테스트(이벤트 200개 → 목록 400회)                                                      | sol, opus(R2)           |
| C-06 | 기본 앱 열기·위치 보기·원격 편집     | 이슈(02, 17, 22) / 기기확인                                 | Rust 재현(edit_session), 코드 추적(ShellExecuteW — 인젝션 없음)                                                   | sol, opus(R2·R3)        |
| C-07 | 볼륨·루트·위로 가기                  | 이슈(10) / 기기확인                                         | Vitest 재현(UNC·`\\?\`)                                                                                           | sol, opus(R2)           |
| C-08 | 경로 바·브레드크럼                   | 이슈(11)                                                    | 기존 14테스트 통과 + Vitest 재현                                                                                  | sol, opus(R2)           |
| C-09 | 탭                                   | OK                                                          | Vitest 6건(복제 독립·핀 보호·닫은 탭 복원)                                                                        | opus                    |
| C-10 | 세션 저장·복원                       | 이슈(15, 26) · StrictMode 활성 탭(이미 알려짐)은 재현 안 됨 | App 전체 테스트                                                                                                   | opus, sol(R2)           |
| C-11 | 탐색·히스토리·경쟁                   | 이슈(04, 05, 23) · 늦은 목록 경쟁 OK                        | App 전체 테스트                                                                                                   | opus, lead, sol(R2·R3)  |
| C-12 | 정렬·필터·패턴·숨김·보기 모드        | 이슈(03, 25, 28)                                            | Vitest                                                                                                            | opus, sol(R2)           |
| C-13 | 선택·키보드·marquee·이름 변경 진입   | OK                                                          | Vitest + 기존 26테스트                                                                                            | opus                    |
| C-14 | 미리보기 패널·QuickLook UI           | 이슈(07, 08) · 늦은 미리보기 경쟁 OK                        | RTL, highlight.js 실측                                                                                            | opus, lead, sol(R2)     |
| C-15 | 드래그&드롭 UI                       | 이슈(14) / OS 연동 기기확인                                 | Vitest                                                                                                            | opus, sol(R2)           |
| C-16 | 동기 탐색                            | 이슈(24)                                                    | App 전체 테스트                                                                                                   | opus, sol(R2)           |
| C-17 | 끊긴 원격 패널                       | 이미 알려짐 → browse-15 로 묶음                             | RTL(it.fails 고정)                                                                                                | opus                    |
| C-18 | 오류 문구·토스트·알림 배지(새 변경)  | OK + 이슈(30, 31)                                           | 기존 테스트 19건 통과, Vitest 재현                                                                                | lead, sol(R2)           |
| C-19 | 프론트 경로 문자열 조작(§7)          | 이슈(04 의 `+ sep +`) + 관찰                                | grep 전수                                                                                                         | lead, sol(R2)           |
| C-20 | 북마크 이동(패널 쪽)                 | OK                                                          | App 전체 테스트 3건                                                                                               | opus(R2)                |
| C-21 | 압축 내부 보기 패널 문맥             | 이슈(32, 34)                                                | App 전체 테스트                                                                                                   | opus(R2), sol(R3)       |

## 이슈 대장 (심각도순)

표기: 원인은 `WT` 기준 파일:라인, 비용 S/M/L. 재현 파일 경로는 아래 "재현 테스트" 절.

### P1

**browse-01 [P1] [bug] 미디어 미리보기: 열린 Range(`bytes=0-`) 요청에 파일 전체를 메모리로 읽음**

- 증상: 큰 동영상(수 GB)을 미리보기 패널에서 열면 백엔드가 그 크기만큼 버퍼를 한 번에 잡는다. 할당 실패 시 Rust 기본 동작으로 **프로세스가 abort** 한다(앱 종료). 원격 파일이면 재생 전에 파일 전체를 SFTP 로 받는다("통째 다운로드 회피" 설계와 반대).
- 근거·재현: `services/preview_stream.rs` try_handle Range 분기(~177–180) `end = end_opt.unwrap_or(last)` → `want = 전체` → `read_range` 의 `vec![0u8; len]`(`fs/local.rs:263`, `fs/ssh.rs:508`). 재현 `preview_stream.rs mod review_browse`(64MB 희소 파일 → 64MB 반환), sol 독립 재현(4MiB 시작 열린 Range → 20MiB 읽음). Chromium 미디어 로더가 RightUnbounded Range(`bytes=N-`)를 보낸다는 소스 근거(sol R2), Rust 할당 실패 = abort 근거(rustc 1.93.1 alloc.rs, release `panic=abort`).
- 수정안(M): 한 응답 상한(예 4–8MiB)으로 잘라 정확한 `206 + Content-Range: bytes N-M/total` 로 응답(브라우저는 이어서 다음 Range 요청). browse-33 과 함께.
- 상태: **확인됨**(산술·할당) / 기기확인: WebView2·WKWebView 의 실제 첫 요청 헤더. 교차검토: sol 동의(P1 유지).

### P2 — 데이터 안전

**browse-02 [P2] [bug] 원격 편집(F4) 저장이 그사이 바뀐 서버 파일을 확인 없이 덮어씀**

- 증상: 원격 파일을 편집기로 연 뒤 다른 사람·배포·앱이 서버 파일을 고쳐도, 다음 저장이 그 변경을 지운다. 백업·undo(§4)·안내 없음. 서버 쓰기는 create(잘라내기)→write.
- 근거: `services/edit_session.rs:31-36`(서버 기준값 없음), `:166-171, 198` upload, `fs/ssh.rs:516-531`. 재현 `edit_session.rs mod review_browse`.
- 수정안(S~M): 다운로드 시 서버 mtime·size 기록 → 업로드 직전 비교, 다르면 충돌 선택. 덮을 서버 사본 보존·원자 업로드.
- 상태: 확인됨. **심각도 의견 갈림:** sol P1(데이터 손실) / opus P2(동시 수정이 있어야 함, 사용자가 의도한 저장, 업계 도구 기본 동작도 같음 — 기억 기반). **lead 판정 P2**: 흔한 상황에서의 손실이 아니다. 단 browse-17 과 묶어 **P2 최우선 수정 단위**로 권한다.

**browse-17 [P2] [ux] 원격 편집 업로드 실패·감시 종료가 사용자에게 안 보임**

- 증상: 연결이 약 1분 넘게 끊기면(노트북 잠자기·망 전환) 감시가 조용히 끝나고, 수동 재연결은 새 연결 id 라 이어지지 않는다. 이후 저장은 서버에 영영 안 올라가는데 표시가 없다. 편집본은 옛 temp 에만 남는다.
- 근거: `edit_session.rs:186-189`(pool.get 실패 → break), `:200-207`(업로드 실패 → 로그만), `:28,37-48`(세션 키=connection id). 코드 추적(opus R2: browse-02 보다 흔함).
- 수정안(M): 저장 결과·감시 종료 이벤트 → 토스트/상태바(가장 싸고 두 실패 모두 드러냄), 세션 키를 alias+경로로.
- 상태: 확인됨(코드). 교차검토: opus 동의.

**browse-03 [P2] [bug] 빠른 필터로 가려진 선택 항목이 복사·이동·삭제·드래그 대상에 남음**

- 증상: Ctrl+A 후 필터에 `.txt` 를 치면 화면엔 `.txt` 만 보이지만 Delete/F5/F6·드래그·우클릭 복사·클립보드가 안 보이는 파일까지 대상으로 삼는다. 상태바는 "1개 표시 … 2개 선택".
- 근거: `stores/panes.ts:915-925` setFilter 가 선택을 안 건드림(숨김 토글은 같은 위험을 `:853-868` 에서 이미 막음). 소비자: `lib/fileActions.ts:51-70,205`, `hooks/useEntryDrag.ts:62-73`, `lib/entryMenu.tsx:311-317`, `StatusBar.tsx:86-101`. 재현 `browse-panes.test.ts`, `browse-sol2-state.test.tsx`(5경로).
- 수정안(S): setFilter 에서 보이는 이름으로 선택 정리(숨김 토글과 같은 정책). 한 곳만 바꾸면 모든 소비자가 맞는다.
- 상태: 확인됨. 교차검토: sol 동의, 수정안 (b) 추천.

**browse-14 [P2] [bug] 폴더를 자기 손자 이하 폴더로 드롭·붙여넣기를 프론트가 막지 않음**

- 증상: `/w/proj` 를 `/w/proj/sub` 에 놓거나 붙여넣으면 "자기 자신 안" 안내 없이 복사 계획을 요청한다. 백엔드에도 가드가 없어(이미 알려진 B-05) 재귀 복사로 이어질 수 있다. 직접 붙여넣기는 `C:\a` vs `C:/a/` 표기 차이도 놓친다.
- 근거: `hooks/useEntryDrag.ts:200-226`, `lib/fileActions.ts:259-266`, `lib/selfDrag.ts:51-53` — 모두 직접 자식만 비교. 재현 `browse-dnd-guard.test.ts`, `browse-sol2-state.test.tsx`.
- 수정안(S): 공용 `isInside(dst, src)`(같은 source + 정규화 prefix + 구분자 경계). 근본 방어는 백엔드(B-05).
- 상태: 확인됨. 교차검토: sol 부분 동의(selfDrag 는 이미 `sameLocationDir` 라 표기 차이는 OS 드롭 경로에선 통과, 후손 누락은 맞음). 실제 실행 결과는 fileops 팀.

### P2 — 핵심 기능

**browse-04 [P2] [bug] 우클릭 "반대 패널에서 열기"가 원격 폴더를 반대 패널의 소스(로컬)로 엶**

- 증상: 왼쪽 SSH `/srv`, 오른쪽 로컬에서 `app` 을 우클릭 → "반대 패널에서 열기" 하면 오른쪽이 **로컬** `/srv/app` 을 연다(대개 실패 토스트, 같은 경로가 있으면 엉뚱한 로컬 폴더). 키보드 명령은 정상.
- 근거: `App.tsx:679-688` `navigate(opposite, path + sep + name)` — `navigate`(`:241-243`)는 대상 패널 source 에 path 만 끼운다. 문자열 경로 결합(§7 위반)도 같은 줄. 재현 `browse-app-nav.test.tsx`(opus), lead 독립 재현.
- 수정안(S): `navigateTo(opposite, childLocation(tab.location, entry.name))`.
- 상태: 확인됨. 교차검토: sol 동의(사이드바 6곳은 Location 을 보존해 해당 없음 — 반박 확인).

**browse-05 [P2] [bug] 경로만 넘기는 탐색 3곳에서 원격↔로컬 소스가 섞임: 뒤로/앞으로 · OS 시작 경로 · 남아 있는 검색 결과**

- 증상: (1) 같은 탭에서 로컬 → 사이드바 원격 북마크/호스트로 이동 후 "뒤로"를 누르면 로컬 `/home` 을 **원격에서** 연다(경로가 같으면 원격 폴더를 로컬로 착각). (2) 왼쪽 마지막 탭이 원격인 채 종료 → 탐색기 "duet 으로 열기"로 시작하면 로컬 경로를 원격 source 로 읽는다. (3) 로컬 검색 결과가 남은 채 패널을 원격으로 옮기고 결과를 누르면 원격에서 연다.
- 근거: `App.tsx:647-661`(onBack/onForward `navigate(id, loc.path)`), `:2077-2079`(startupOpenPath), `:869`(onPickHit) — 모두 Location 의 source 를 버림. 재현 `browse-lead-app.test.tsx`, `browse-sol2-app-cross.test.tsx`(실제 사이드바 클릭), `browse-sol3-app.test.tsx`(시작 경로·검색).
- 수정안(S): 세 곳 모두 전체 Location 으로 `navigateTo`. browse-23(히스토리 커밋 시점)과 함께 정리하면 단순.
- 상태: 확인됨. 교차검토: sol 동의 + 2경로 확장(R3). `useOpenPathEvents`(실행 중 인스턴스)는 로컬 새 탭을 먼저 만들어 해당 없음.

**browse-06 [P2] [bug] 텍스트 미리보기: CP949(한국어 ANSI)·UTF-16 텍스트를 "바이너리"로 표시, 비UTF-8 본문은 조용히 잘림**

- 증상: 한국어 Windows 메모장 ANSI(CP949) 저장 파일, 메모장 "유니코드"(UTF-16) 파일이 "미리보기할 수 없는 바이너리"로 나온다. ASCII 머리 + 한글 본문이면 머리만 보이고 "잘림" 표시도 없다. 로컬·원격 공통. 이 사용자(한국어·Windows)에게 흔하다.
- 근거: `commands/fs_ops.rs` `looks_binary`(NUL → 바이너리 → UTF-16 탈락), `decode_text`(UTF-8 유효 prefix 만, truncated 안 켬). 재현 `fs_ops.rs mod review_browse` 3건. sol R2 Shift-JIS·Latin-1·UTF-16 cap 경계 보강.
- 수정안(M): BOM 감지(UTF-8/16), 비UTF-8 이면 로캘 폴백 디코드(CP949 등 — 인코딩 crate 는 §6 의존성 승인 필요) 또는 최소한 "UTF-8 아님" 안내 + 잘림 표시.
- 상태: 확인됨. 교차검토: sol 동의.

**browse-07 [P2] [bug] 확장자 미등록 큰 텍스트(.log/.txt/.csv) 미리보기가 UI 를 수 초 멈춤**

- 증상: 256KB 로그 파일에 커서를 두면 화면이 1~6초 굳는다. 커서를 따라가는 미리보기라 여러 파일을 지나가면 반복된다.
- 근거: `components/pane/PreviewContent.tsx:95-104` 동기 `hljs.highlightAuto`. 실측(Node, highlight.js 11.11.1): 로그 256KB 2.5s(lead), 산문 0.9–2.0s·CSV 2.4–6.6s(sol). 단일 언어 지정 시 176ms. QuickLook 도 같은 컴포넌트.
- 수정안(S~M): 미등록 확장자는 plain text, 큰 텍스트는 길이 상한 후 plain, 필요하면 Worker.
- 상태: 확인됨(실측) / 실제 webview 체감은 기기확인. 교차검토: sol 동의.

**browse-08 [P2] [bug] 마크다운 미리보기의 링크 클릭을 막지 않아 앱 창 자체가 그 주소로 이동할 수 있음**

- 증상: README 의 `https://…` 나 `other.md` 링크를 누르면 앱 webview 가 그 페이지로 바뀔 수 있다. 창 장식이 없는 앱(`decorations:false`)이라 돌아올 버튼도 없다. 상대 링크는 파일 옆이 아니라 앱 origin 기준으로 해석된다.
- 근거: `PreviewContent.tsx` ReactMarkdown 기본 `<a href>`, 전역 가로채기 없음. Tauri 2 `navigation_handler` 기본 None, Wry WebView2 는 callback 이 있을 때만 취소(sol R2 소스 근거). 재현 `browse-lead-preview.test.tsx`, `browse-sol2-preview-perf.test.tsx`(defaultPrevented=false).
- 수정안(S): 마크다운 `a` 컴포넌트에서 기본 이동 차단 + http(s) 는 OS 브라우저로 열기(백엔드 명령). 보조로 builder `on_navigation` 가드.
- 상태: 확인됨(미차단) / 기기확인(실제 이동 모습). 교차검토: sol 동의.

**browse-33 [P2] [bug] 16MiB 넘는 PDF 는 미리보기가 항상 실패**

- 증상: 스캔 문서·이미지 많은 보고서 같은 큰 PDF 가 "열 수 없음 → 기본 앱으로 열기" 로 빠진다. 이유 안내 없음. 원격이면 16MiB 를 받은 뒤 실패.
- 근거: `preview_stream.rs:203-212` Range 없는 첫 요청에 16MiB 로 자른 본문을 `200 + Content-Length=16MiB` 로 보냄 → pdf.js 4.10.38 이 그 길이를 파일 전체로 믿음(Windows fetch 경로·macOS XHR 경로 모두, opus R3 소스 추적). Node 실측: 앞 16MiB 만 주면 `InvalidPDFException` (카탈로그가 앞에 있어도). 재현 `tests/review_browse_sol2_preview.rs`, `browse-opus3-pdf-truncation.test.ts`.
- 수정안(M): 서버는 잘린 200 금지(상한 초과면 413 등), 프론트는 `PDFDataRangeTransport(length=total_size)` 로 처음부터 명시 Range. browse-01 상한과 함께.
- 상태: 확인됨. 교차검토: opus 동의(실측으로 확정). 회귀 테스트는 수정 방식에 맞춰 다시 써야 함(표시만 떼면 안 맞음).

**browse-32 [P2] [bug] 압축 파일에서 "위로" 나온 뒤 "뒤로" 가면 압축 문맥 없이 임시 추출 폴더로 들어감**

- 증상: 경로 바·탭 제목이 `x.zip` 이 아니라 임시 경로, "위로"는 임시 폴더 부모로, **"압축 파일 갱신" 버튼이 사라짐**, 세션도 임시 경로를 저장. 거기서 고친 내용을 반영됐다고 믿고 종료하면 다음 시작 때 임시 폴더 정리로 잃을 수 있다.
- 근거: 히스토리가 Location 만 저장(`panes.ts:54, 567-578`), 문맥은 현재 탭에 있을 때만 이어짐. 임시 추출물은 다음 시작 때 정리(`lib.rs:388` → `core/archive.rs:842-843`). 재현 `browse-opus2-app.test.tsx`, `browse-sol3-app.test.tsx`.
- 수정안(S~M): 히스토리 항목에 `ArchiveBrowse` 를 함께 저장해 back/forward 가 복원, 임시 폴더가 사라졌으면 `exitTo`.
- 상태: 확인됨. 교차검토: sol 동의(P2).

**browse-09 [P2] [bug] 커서만 둔 폴더의 "크기 계산"이 다른 폴더를 계산**

- 증상: 키보드(Shift+Space)·팔레트로 커서 폴더 크기를 구하면, 화면(정렬·필터·`..` 행) 인덱스를 원본 배열에 적용해 **다른 항목**을 계산하거나 아무것도 안 한다. 기본 정렬(수정일)에서는 거의 항상 틀린다. 우클릭 메뉴 경로는 정상.
- 근거: `lib/dirSize.ts:23`. 재현 `browse-dir-size-race.test.ts`, `browse-opus2-app.test.tsx`.
- 수정안(S): `computeDisplayed(tab)[tab.cursorIndex]` 사용, `..` 제외.
- 상태: 확인됨. 교차검토: opus 동의(범위 더 넓음).

**browse-10 [P2] [bug] Windows UNC 공유 루트에서 "위로"가 `\\서버` 로 가서 실패**

- 증상: 회사 NAS `\\srv\share` 에서 `..` 가 보이고 누르면 오류. `\\?\` 경로 루트·브레드크럼도 잘못 나뉜다(드묾 — P3 부분).
- 근거: `panes.ts:1064` isRootPath, `lib/entryDnd.ts:103` parentPath, `components/pane/pathCrumbs.ts:23`. 재현 `browse-platform-paths.test.ts`.
- 수정안(M): Windows 경로 접두(UNC/verbatim) 해석을 백엔드 `Path` 로(§7), 프론트는 결과만 사용.
- 상태: 확인됨 / Windows 기기확인. 교차검토: opus 부분 동의(UNC P2, verbatim P3).

**browse-11 [P2] [bug] 탐색기 "경로로 복사"(따옴표 포함)를 경로 바에 붙이면 열리지 않음**

- 증상: Win11 Ctrl+Shift+C 는 항상 `"C:\…"` 처럼 따옴표를 붙인다. 붙여 넣고 Enter → 열기 실패.
- 근거: `PathBar.tsx:117` trim 만. 재현 `browse-path-input.test.tsx`.
- 수정안(S): 바깥 따옴표 한 쌍 제거(백엔드 경로 입력 해석). 같은 문제가 심볼릭 링크 대화상자에도 있음(fileops 로).
- 상태: 확인됨. 교차검토: opus 동의.

**browse-12 [P2] [bug] 두 패널이 같은 폴더를 볼 때 한쪽이 떠나면 다른 쪽 자동 새로고침이 끊김**

- 증상: 첫 실행은 양쪽 모두 홈에서 시작한다 — 한쪽만 이동하면 남은 쪽은 외부 변경(다운로드 등)이 반영되지 않는다.
- 근거: `services/fs_watcher.rs:52-56, 71-74, 133-146` — watcher 하나에 패널별 cleanup 이 경로를 unwatch(참조 수 없음). 재현 `tests/review_browse_local.rs`(notify 실행).
- 수정안(S~M): 경로별 참조 수, 마지막 구독자일 때만 unwatch.
- 상태: 확인됨. 교차검토: opus 동의(서비스 흐름 = 테스트).

**browse-13 [P2] [bug] 파일 변경 이벤트마다 목록 전체를 다시 읽음**

- 증상: 압축 해제·빌드로 파일 1,000개가 생기면 목록 재조회 1,000회(패널 둘이면 배). 매번 감시도 다시 걸어 그 사이 이벤트를 놓칠 수 있다.
- 근거: `fs_watcher.rs:109`(경로마다 emit), `hooks/useFsChangedEvents.ts:21`, `App.tsx:251, 272-274`. 재현 `browse-fs-events.test.tsx`, `browse-opus2-app.test.tsx`(이벤트 200 → listDirectory 400 · paneWatchSet 400).
- 수정안(M): 폴더별 디바운스 + 진행 중 요청 합치기(마지막 변경은 반드시 1회 반영).
- 상태: 확인됨. 교차검토: opus 동의.

**browse-15 [P2] [ux] 목록을 못 연 탭이 "빈 폴더입니다"로 보임 (세션 복원 시 사라진 폴더 · 끊긴 원격 — 후자는 이미 알려짐)**

- 증상: 지난번 열어 둔 USB·네트워크 폴더가 없어진 채 시작하면 그 탭은 옛 경로 + "빈 폴더입니다". 오류 토스트는 8초 뒤 사라진다. 사용자는 폴더가 비었다고 오해한다.
- 근거: `components/pane/Pane.tsx:206-213`(목록 실패 상태가 탭에 없음). 재현 `browse-app-nav.test.tsx`, `browse-disconnected.test.tsx`, `browse-sol2-app-cross.test.tsx`.
- 수정안(M): `TabState.loadError` 를 두고 "이 폴더를 열 수 없습니다 — 이유 [다시 시도] [위로]".
- 상태: 확인됨. 교차검토: sol 동의.

**browse-18 [P2] [bug] 원격 폴더 크기: 하위 하나만 못 읽어도 0 B 로 표시**

- 증상: `du` 가 권한 오류로 exit 1 을 내면(합계는 출력함) 코드가 0 으로 바꾼다. 서버의 /var·/home·/srv 는 흔히 그렇다. BusyBox(`-b` 미지원)도 0.
- 근거: `fs/ssh.rs:208-236` 모든 실패 → `Ok(0)`. opus 실행: 권한 없는 하위가 있는 폴더에서 `du -sk` → 합계 출력 + exit 1.
- 수정안(S~M): 사용자용 크기는 실패/미상/0 구분, 부분 합계면 표시. 전송 진행률용 0 폴백과 분리.
- 상태: 확인됨(코드 + du 실행). 교차검토: opus 동의(sol 보다 흔함).

**browse-19 [P2] [ux] 권한 없는 하위 폴더 하나로 로컬 폴더 크기 계산 전체 실패**

- 증상: Windows 드라이브 루트(`System Volume Information`), macOS 홈(TCC 보호 폴더) 같은 흔한 대상에서 크기가 아예 안 나온다.
- 근거: `fs/local.rs:458` 하위 read_dir 오류 즉시 전파. 재현 `tests/review_browse_local.rs`.
- 수정안(M): 읽을 수 있는 만큼 합산 + "일부 폴더 제외" 표시.
- 상태: 확인됨. 심각도: sol P2 → lead R1 P3 → **opus R2 P2 (흔한 대상 근거) 채택**.

### P3

| ID        | 종류        | 제목·증상                                                                                                     | 원인                                                            | 수정안·비용                                         | 근거·상태                                                        | 교차검토                         |
| --------- | ----------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------- |
| browse-16 | bug         | 이미지를 고쳐도 그리드 썸네일이 옛것(최대 1시간 캐시), 실패 상태 고착                                         | `EntryGrid.tsx:360,376`, `previewUrl.ts:36`, `thumbnail.rs:112` | URL 에 `?v=<mtime>-<size>`, `key` 로 실패 초기화(S) | 재현 `browse-thumbnail-refresh.test.tsx` / webview 캐시 기기확인 | opus P2→P3(파일·미리보기는 정상) |
| browse-20 | bug         | 폴더 크기 계산 중 같은 탭에서 이동하면 늦은 결과가 새 폴더의 같은 이름 항목에 붙음                            | `dirSize.ts:20-45`, `panes.ts:946`                              | 시작 위치와 현재 위치 비교 후 폐기(S)               | 재현 `browse-dir-size-race.test.ts`                              | opus 동의                        |
| browse-21 | bug         | macOS Finder 숨김(UF_HIDDEN) 항목이 숨김 꺼도 보임(`/` 의 `bin usr private` 등, `~/Library`)                  | `fs/local.rs:485`                                               | macOS `st_flags & UF_HIDDEN` 반영(S)                | 재현 `review_browse_local.rs`                                    | opus 동의                        |
| browse-22 | bug         | 원격 파일 일반 열기(Enter)는 같은 파일명이면 같은 temp 를 덮음 + 그 사본을 고쳐도 서버에 안 올라감(안내 없음) | `commands/system.rs:374-397`                                    | UUID 하위 폴더 + 읽기 전용 또는 "편집은 F4" 안내(S) | 코드                                                             | opus 동의                        |
| browse-23 | bug         | 뒤로/앞으로 실패 시 히스토리 위치만 먼저 옮겨져 화면과 어긋남                                                 | `panes.ts:966-999`, `App.tsx:647-661`                           | 성공 시 index 이동(S~M)                             | 재현 `browse-app-nav.test.tsx`                                   | sol 동의                         |
| browse-24 | ux          | 동기 탐색: 반대 패널에 대응 폴더 없으면 조용히 건너뜀, 뒤로/앞으로 미동기                                     | `App.tsx:386-388,647-661`                                       | 일시 중단 안내(S); 뒤로 동기 여부는 설계 결정       | 재현(기록용)                                                     | sol 부분 동의(개선)              |
| browse-25 | bug         | 패턴 선택 `[!a]*` 가 반대로 선택, 클래스 안 `\d` 가 정규식 숫자                                               | `lib/glob.ts:36-44`                                             | `[!` → `[^`, 클래스 내 이스케이프(S)                | 재현 `browse-panes.test.ts`, `browse-sol2-state.test.tsx`        | sol 동의                         |
| browse-26 | bug         | 세션 저장이 500ms 디바운스뿐 — 탭 조작 직후 닫으면 유실                                                       | `stores/session.ts:145-155`, 닫기 버튼 flush 없음               | close/pagehide 에서 flush(S)                        | 재현 `browse-sol2-session-toast.test.tsx`(mock close) / 기기확인 | sol 동의                         |
| browse-27 | bug         | 비 UTF-8 로컬 이름이 목록·폴더 크기에서 경고 없이 빠짐(Linux)                                                 | `fs/local.rs:363,460`                                           | 손실 변환 표시 + 스킵 수 안내(M)                    | 코드 / Linux 기기확인                                            | opus 동의                        |
| browse-28 | improvement | 크기 정렬이 계산한 폴더 크기를 안 씀                                                                          | `panes.ts:1135`                                                 | `dirSizes[name] ?? size`(S)                         | 재현 `browse-panes.test.ts`                                      | sol 동의                         |
| browse-29 | improvement | 썸네일 디스크 캐시·아이콘 메모리 캐시 상한 없음, 썸네일이 **설정 폴더**(Windows Roaming AppData)에 쌓임       | `thumbnail.rs:88-95,191`, `fileIcons.ts:63-83`                  | `dirs::cache_dir()` 로 이동 + LRU(S~M)              | 코드                                                             | opus 동의(+위치 문제)            |
| browse-30 | ux          | 폴더 열기 실패 알림에 원문(detail)이 없어 알림 목록 "자세히"가 생략됨(오류 토스트 ~41곳 중 5곳만 전달)        | `App.tsx:287-290,345-351`                                       | `explainError` 의 detail 전달(S)                    | 재현 `browse-sol2-app-cross.test.tsx`                            | sol 동의(표현 정정)              |
| browse-31 | ux          | 오류 토스트 8초 자동 소멸에 마우스 올림 일시정지 없음                                                         | `stores/toast.ts`                                               | hover 시 타이머 정지(S)                             | 재현 `browse-sol2-session-toast.test.tsx`                        | sol 부분 동의(알림 기록은 남음)  |
| browse-34 | ux          | 압축 파일 루트에서 위로 나오면 커서가 `x.zip` 이 아니라 `..` 에                                               | `App.tsx:493-495`(navigateTo 에 focusName 없음)                 | focusName 옵션 추가(S)                              | 재현 `browse-opus2-app.test.tsx`, `browse-sol3-app.test.tsx`     | sol 동의                         |

## 개선 제안 (버그는 아님)

- 원격 썸네일이 40MiB 이하 원본을 통째로 받는다 — 모듈 주석("통째 다운로드 회피")과 다르다(`thumbnail.rs:174`).
- SSH 변경 감지는 문서와 달리 비활성 패널도 폴링한다. 디렉터리 mtime 만 봐서 기존 파일 내용 수정은 못 잡는다(문서화된 한계).
- 감시 등록 실패(네트워크 드라이브 등)가 경고 로그뿐 — "자동 새로고침 안 됨" 표시나 폴링 대체가 없다(`fs_watcher.rs:146`, `commands/pane.rs:54`).
- 부팅 복원 시 패널마다 목록을 두 번 읽는다(`App.tsx:2069` selectTab → 탭 전환 effect).
- 확장자 정렬이 `.bashrc` 를 확장자 "bashrc" 로 본다.
- 실행 파일(.exe/.bat) 열기 전 경고 없음 — 정책 결정 사항.
- Windows OS 오류 번호 표에 21(장치 준비 안 됨)·1326(네트워크 로그온 실패)·225(바이러스 감지)·클라우드 파일 오류(362 등) 미매핑 → 원문 노출(정보는 보존).
- 원격(Linux) 폴더 이름에 `\` 가 있으면 프론트 `childLocation`/`parentPath` 가 구분자로 오인(§7 — 경로 조작을 백엔드로 옮길 때 같이 해결).
- `archive.root`/`trashRoot` 문맥 판정이 구분자 경계 없는 `startsWith`(실해 낮음).
- 텍스트 미리보기가 UTF-8 BOM(U+FEFF)을 그대로 넘긴다(화면에서는 보이지 않음).
- 백엔드 `local_abs` 가 `\\?\UNC\srv\share` 를 `UNC\srv\share` 로 잘못 벗긴다(상대경로 입력일 때만, `platform/mod.rs:77-95`).

## 기기 확인 필요

| 항목                                                          | 확인 방법                                                                                                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| browse-01 실제 Range 헤더·메모리                              | Windows: 2GB 이상 mp4 를 미리보기 → 작업 관리자에서 duet 메모리 급증 여부, 개발자 도구 Network 에서 `Range: bytes=0-`. macOS 도 같은 방법(WKWebView 첫 요청 형식 확인) |
| browse-08 링크 클릭                                           | README.md 미리보기에서 외부 링크·상대 링크 클릭 → 앱 화면이 바뀌는지, 돌아올 수 있는지                                                                                 |
| browse-07 체감                                                | 256KB .log 위로 커서 이동 시 멈춤 시간(Windows 저사양 포함)                                                                                                            |
| browse-10 UNC                                                 | `\\NAS\share` 에서 위로·브레드크럼                                                                                                                                     |
| browse-16 썸네일 캐시                                         | 그리드에서 이미지 편집 후 새로고침                                                                                                                                     |
| browse-26 세션                                                | 탭 핀 직후 0.5초 안에 창 닫기 → 재실행                                                                                                                                 |
| browse-27 비UTF-8 이름                                        | Linux 로컬에서 비UTF-8 파일이 있는 폴더                                                                                                                                |
| Windows 정션·심볼릭 링크·OneDrive 자리표시자·시스템+숨김 속성 | 코드상 정션=Symlink→대상 stat→Dir, HIDDEN(0x2)만 숨김(SYSTEM 단독은 표시). 실기 폴더로 목록·크기·진입 확인                                                             |
| Windows 볼륨 열거                                             | 끊긴 네트워크 드라이브·빈 광학 드라이브가 있을 때 사이드바 드라이브 목록 지연(A~Z 순차, timeout 없음)                                                                  |
| 드래그&드롭 OS 연동                                           | OS 로 끌어내기, Finder/탐색기 → 원격 패널 드롭, 고DPI 좌표                                                                                                             |
| PDF·미디어 실제 재생                                          | 16MiB 이하/초과 PDF, 원격 영상 seek                                                                                                                                    |

## 다른 영역으로 넘긴 것

- **fileops:** 손자 폴더 복사·이동 실제 실행 결과(browse-14 / 기존 B-05), 대소문자만 바꾸는 이름 변경(대소문자 무시 FS), 심볼릭 링크 대화상자 대상 경로 따옴표 미처리(`SymlinkDialog.tsx:31-34`), 폴더 복사가 비UTF-8 하위 이름을 조용히 빠뜨리는지(browse-27 관련).
- **remote:** `fs/ssh.rs:516` write_full 이 create(잘라내기)→write 라 업로드 중 끊기면 서버 파일이 잘림(원격 편집 포함). 원격 서버의 EUC-KR 등 비UTF-8 이름이 SFTP 목록에서 어떻게 되는지.
- **shell-settings:** Windows 볼륨 열거 A~Z 순차 metadata, timeout 없음(사이드바).
- **search:** `onPickHit` 이 원본 entries 인덱스로 커서를 놓음(`App.tsx:871`, 정렬이 다르면 다른 항목) — source 유실 부분은 browse-05 에 포함.

## 라운드 기록

| 라운드 | 누가 무엇을                                                                                | 결과                                                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1     | sol: C-01·02·04~08 (백엔드·플랫폼) / opus: C-09~17 (프론트 흐름) / lead: C-03·18·19 + 공통 | 발견 sol 15 · opus 9 · lead 8(1건 opus 와 중복) → 대장 31건                                                                                                                                                                                         |
| R2     | opus: sol 발견 15건 + 빈 항목 C-20·21 / sol: opus 발견 9건 + lead 발견 7건                 | 31건 중 동의 23 · 부분 동의 5(04·10·14·24·31) · 심각도 조정 3(02 P1→P2 의견, 16 P2→P3, 19 P3→P2; 10 의 verbatim 부분 P3) · 반박 0(부분 동의 안에서 04 의 사이드바 확대·14 의 selfDrag 표기 차이 주장만 반박) · 새 발견 3(F-opus-201·202, F-sol-201) |
| R3     | sol: F-opus-201·202 + browse-05 확장 / opus: F-sol-201 + browse-02 심각도                  | 새 발견 3건 모두 동의, browse-05 에 2경로 병합, browse-02 는 P1(sol)/P2(opus) 의견 차 → lead P2 판정                                                                                                                                                |

## 재현 테스트

- 커밋: `review/browse` **`50c8db6`** — 테스트 파일만(제품 코드 무변경. Rust 4개 파일은 끝에 `#[cfg(test)] mod review_browse` 만 덧붙임).
- 결함 재현 테스트는 Vitest `it.fails("browse-NN …")`, Rust `#[ignore = "browse-NN repro …"]` 로 표시(괄호 안은 워커 원 ID). 수정 라운드에서 표시만 떼면 회귀 테스트가 된다(browse-33 의 pdf 테스트는 수정 방식에 맞춰 다시 쓸 것).
- 일부는 교차 검증용 사본이라 같은 결함을 두 파일이 재현한다(`browse-sol2-app-cross`·`browse-sol3-app` ↔ `browse-app-nav`·`browse-opus2-app`).

파일:

```
src/__review__/browse-lead-app.test.tsx                      browse-05
src/components/__review__/browse-sol2-session-toast.test.tsx browse-26, 31
src/components/pane/__review__/browse-app-nav.test.tsx       browse-04, 15, 23 (+ C-10·11·16 확인)
src/components/pane/__review__/browse-disconnected.test.tsx  browse-15 (이미 알려짐 고정)
src/components/pane/__review__/browse-lead-preview.test.tsx  browse-08
src/components/pane/__review__/browse-opus2-app.test.tsx     browse-09, 32, 34 (+ 13 측정, C-20·21)
src/components/pane/__review__/browse-opus3-pdf-truncation.test.ts  browse-33
src/components/pane/__review__/browse-path-input.test.tsx    browse-11
src/components/pane/__review__/browse-preview.test.tsx       C-14 경쟁·문구·previewUrl (통과)
src/components/pane/__review__/browse-sol2-app-cross.test.tsx  browse-04, 05, 15, 23, 30
src/components/pane/__review__/browse-sol2-preview-perf.test.tsx browse-08
src/components/pane/__review__/browse-sol3-app.test.tsx      browse-05, 32, 34
src/components/pane/__review__/browse-thumbnail-refresh.test.tsx browse-16
src/hooks/__review__/browse-fs-events.test.tsx               browse-13
src/lib/__review__/browse-dir-size-race.test.ts              browse-09, 20
src/lib/__review__/browse-platform-paths.test.ts             browse-10
src/lib/__review__/browse-sol2-state.test.tsx                browse-03, 14, 25, 28
src/stores/__review__/browse-dnd-guard.test.ts               browse-14
src/stores/__review__/browse-panes.test.ts                   browse-03, 25, 28 (+ C-09·12·13 확인)
src-tauri/tests/review_browse_local.rs                       browse-12, 19, 21 (+ 링크·대량 목록)
src-tauri/tests/review_browse_sol2_preview.rs                browse-01, 33
src-tauri/src/commands/fs_ops.rs        (mod review_browse)  browse-06
src-tauri/src/services/preview_stream.rs (mod review_browse) browse-01
src-tauri/src/services/edit_session.rs  (mod review_browse)  browse-02
src-tauri/src/services/thumbnail.rs     (mod review_browse)  썸네일 캐시 키·손상 이미지 (통과)
```

실행:

```
H=/Users/ctmctm/Desktop/01_PROJECT/duet-ux/_review/bin/heavy.sh
cd /Users/ctmctm/Desktop/01_PROJECT/duet-ux/browse
bash $H pnpm exec vitest run --minWorkers=1 --maxWorkers=2 $(git show --name-only --format= 50c8db6 | grep -E '\.tsx?$')
bash $H cargo test --manifest-path src-tauri/Cargo.toml --lib review_browse
bash $H cargo test --manifest-path src-tauri/Cargo.toml --test review_browse_local --test review_browse_sol2_preview
# 결함 재현 확인: Rust 는 -- --include-ignored, Vitest 는 it.fails 를 it 으로 바꿔 실행
```

최종 확인 결과(커밋 직전, heavy.sh): Vitest **19 files / 120 passed**(it.fails 포함), eslint 0, prettier 통과, `tsc --noEmit` 0,
`cargo test --lib review_browse` 3 passed / 5 ignored, 통합 테스트 `review_browse_local` 6 passed / 3 ignored · `review_browse_sol2_preview` 3 passed / 2 ignored, `cargo fmt --check` 0.
`cargo clippy --all-targets -D warnings` 는 **기존 제품 코드** `src-tauri/src/fs/local.rs:637`(`items_after_test_module`, 이번에 건드리지 않음)만 실패 — 재현 테스트 쪽 경고는 없다. main 에서도 같은 상태일 것이므로 수정 라운드에서 함께 정리할 것.
