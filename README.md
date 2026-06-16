# duet

> 안전하고 빠른 듀얼 패널 SSH/SFTP + 로컬 파일 매니저.
> 모던 GUI. Windows / macOS / Linux.

## 한 줄 설명

Tauri + React 기반의 듀얼 패널 파일 매니저. 같은 호스트 SFTP 패널 간 복사는
원격에서 직접 `cp`/`rsync` 실행 (네트워크 왕복 없음). 영구 삭제 없는 안전한
휴지통 모델. 모든 파괴적 작업은 undo 가능.

## 왜 만드는가

기존 도구들의 구체적인 문제 해결:
- **TC(Total Commander):** Symantec DLP 충돌, 휴지통 동작 시 멈춤, 같은 호스트
  SFTP 간 복사 시 네트워크 왕복 (10GB 파일 → 30분이 5분이면 될 일)
- **WinSCP, FileZilla 등:** 듀얼 패널 약하거나 없음
- **yazi/ranger:** TUI라 GUI 워크플로우와 안 맞음
- **ForkLift, Path Finder:** 유료 + macOS 전용

## 상태

✅ **기능 완성.** MVP-1~7 전부 구현 + 장기(Maybe) 항목 대부분 완료.
본인용 도구 — 외부 사용자/배포 패키징은 고려하지 않음.

단계별 상세 진행 상황은 [`ROADMAP.md`](./ROADMAP.md).

---

## 핵심 기능

### 파일 관리 (로컬 + 원격 동일 UX)
- 듀얼 패널 + 가상 스크롤(`@tanstack/react-virtual`), 키보드 + 마우스 네비게이션
- 뷰 모드: **상세 / 그리드 / 타일**
- 복사(F5) / 이동(F6) / 이름변경(F2) / 새 폴더(F7) / 다중 선택 일괄 이름변경
- **마우스 다중 선택** — 클릭(단일), Ctrl/Cmd+클릭(토글), Shift+클릭(범위), 드래그 마키
- 패널 간 / 폴더로 드래그 앤 드롭(복사 기본 / Ctrl=이동)
- 탭(패널당), 사이드바 북마크, 호스트별 즐겨찾기, 최근 디렉토리 back/forward(Alt+←/→)
- 빠른 필터(Ctrl+F), 정렬(이름/크기/날짜/타입/확장자), 숨김 토글(Ctrl+H)
- 글로벌 파일명 검색(Ctrl+Shift+F) — 로컬은 `.gitignore` 존중, 원격은 SSH `find`
- 파일 미리보기 — 이미지 / 텍스트 / PDF / 미디어 스트리밍 / Quick Look(Space)
- **Places/Volumes 가 활성 패널에 적응** — 왼쪽=원격, 오른쪽=로컬이면 포커스에 따라
  사이드바가 해당 시스템의 홈/표준폴더/마운트로 전환

### 안전망 (가장 중요)
- 영구 삭제 디폴트 OFF — 삭제는 휴지통 이동 (로컬: OS 휴지통, 원격: `<home>/.duet-trash/`)
- 영구 삭제를 켜도 단어 "delete" 타이핑 확인 한 번 더
- 모든 파괴적 작업 → Journal(`journal.jsonl`) 기록 → `Ctrl+Z` undo (세션 간 영속)
- 충돌 시 backup 파일 자동 생성 (`name.bak.<ts>`)
- 원격 휴지통은 다른 파일시스템(EXDEV)이어도 동작 — atomic mv 실패 시 서버측
  `cp -a` + 원본 제거로 폴백
- Windows 로컬 휴지통은 탐색기로 열림(셸 가상폴더라 패널 탐색 불가)

### SSH / SFTP
- `russh` 순수 Rust — 시스템 `ssh`/`scp`/`sftp` 바이너리 호출 안 함
- `~/.ssh/config` 파싱 + 호스트 자동완성
- 인증: **config IdentityFile → 기본키(`~/.ssh/id_ed25519`/`id_ecdsa`/`id_rsa`) →
  ssh-agent(Unix) → 비밀번호** 순으로 시도
- **패스워드리스 설정**(ssh-copy-id): 비번 접속 후 `Ctrl+P → "Set up passwordless
  login"` → 로컬 공개키를 원격 `authorized_keys` 에 설치 → 이후 키로 자동 인증
- N-hop ProxyJump (nested session), 자동 재연결 + 백오프
- **같은 호스트 SFTP 간 복사는 원격에서 직접 실행**(`cp`/`rsync`, 본인 PC 안 거침)
  — duet 의 핵심 차별점. 진행률은 rsync `--info=progress2` 파싱

### 고급 작업
- 작업 큐(호스트당 FIFO worker) + 진행률 바(TasksBar) + 항목 단위 취소
- 폴더 비교(folder diff) — 트리뷰, rename/move 감지, 3-way(base) 비교 + 자동 해결 적용
- 동기화 모드 — 단방향 미러 / 비교 기반 양방향 머지, 드라이런 사전 표시
- 압축/해제(zip, tar.gz) + 아카이브 내부 탐색 + 편집 후 repack
- 비교 결과 export(CSV/JSON)
- 대용량 relay 복사 chunk 스트리밍(OOM 해소) + 중단 시 `.part` 재개

### UX
- 커맨드 팔레트(Ctrl+P) — fuzzy, built-in 명령 + saved hosts + bookmarks + favorites + alias
- 설정 화면(Ctrl+,) — General + **Keymap(검색·재설정·기본값복원)** + Aliases
- 테마(System / Light / Dark), 외부 앱 연동(app launcher)

---

## 키보드 단축키 (기본값)

모든 단축키는 **설정 → Keymap** 에서 재설정 가능(검색 / Edit / Restore defaults).
macOS 는 `Ctrl` 이 자동으로 `Cmd` 로 매핑됩니다.

| 분류 | 키 | 동작 |
|---|---|---|
| **이동** | ↑ / ↓ | 커서 이동 |
| | Enter | 폴더 진입 / 파일 열기 |
| | Backspace | 상위 폴더 |
| | Tab | 좌우 패널 전환 |
| | Alt+← / Alt+→ | 뒤로 / 앞으로(history) |
| **파일** | F5 | 복사(반대 패널로) |
| | F6 | 이동 |
| | F2 | 이름변경(다중 선택 시 일괄) |
| | F7 | 새 폴더 |
| | Delete | 휴지통 |
| | Shift+Delete | 영구 삭제(설정 ON 시) |
| | Ctrl+Z | 되돌리기(undo) |
| | Ctrl+Shift+C | 전체 경로 복사 |
| | Ctrl+Alt+C | 파일명 복사 |
| **선택** | Space | Quick Look |
| | Ctrl/Cmd+Space | 선택 토글 |
| | (마우스) | 클릭=단일, Ctrl+클릭=토글, Shift+클릭=범위 |
| **뷰** | Ctrl+R | 새로고침 |
| | Ctrl+H | 숨김 파일 토글 |
| | Ctrl+B | 사이드바 토글 |
| | F11 | 미리보기 패널 토글 |
| | Ctrl+Shift+1..5 | 정렬(이름/크기/날짜/타입/확장자) |
| | Ctrl+U | 좌우 패널 swap |
| **검색** | Ctrl+F | 빠른 필터(현재 패널) |
| | Ctrl+Shift+F | 글로벌 검색 |
| **탭** | Ctrl+T / Ctrl+W | 새 탭 / 닫기 |
| | Ctrl+Tab / Ctrl+Shift+Tab | 다음 / 이전 탭 |
| **기타** | Ctrl+P | 커맨드 팔레트 |
| | Ctrl+, | 설정 |
| | Ctrl+D | 북마크 토글 |
| | Ctrl+Q | 종료(비-macOS) |

> ⚠️ **F5 = 복사**(TC 표준)입니다. 새로고침은 **Ctrl+R**.

---

## 설정

설정(Ctrl+,) → **General**:
- **테마** — System / Light / Dark
- **새 탭 기본값** — 정렬 키, 뷰 모드(상세/그리드/타일), 숨김 파일 표시
- **영구 삭제 활성화** — 디폴트 OFF (켜도 추가 확인)

설정/데이터 파일 위치 (`<config>` = Windows `%APPDATA%/duet`,
macOS `~/Library/Application Support/duet`, Linux `~/.config/duet`):

| 파일 | 용도 |
|---|---|
| `<config>/duet/settings.toml` | 일반 설정 |
| `<config>/duet/keymap.toml` | 키 재설정(`"키" = "command_id"`, 핫 리로드) — 예시 `config/keymap.toml.example` |
| `<config>/duet/journal.jsonl` | undo 작업 로그 |
| `<remote-home>/.duet-trash/` | 원격 휴지통 |

---

## 빌드

```bash
# 개발 모드 (핫 리로드)
pnpm tauri dev

# 릴리즈 빌드 (.exe / .msi / -setup.exe 등)
pnpm tauri build
```

Windows 빌드 사전 준비: Visual Studio Build Tools(C++) + Rust(MSVC) + Node + pnpm +
WebView2. russh 가 순수 Rust crypto 라 NASM/CMake/OpenSSL 은 불필요.

## 테스트

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # 백엔드 단위/통합
pnpm test                                          # 프론트엔드 (vitest)
./scripts/ssh-it.sh                                # SSH 통합 테스트 (docker)
```

SSH 통합 테스트는 기본 256MB / 2000개로 돌고,
`DUET_SSH_IT_BYTES` / `DUET_SSH_IT_COUNT` 로 10GB / 1만개까지 opt-in.

## 기술 스택

- **백엔드**: Rust + Tauri 2 + tokio + russh / russh-sftp
- **프론트엔드**: TypeScript + React + Vite
- **UI**: Tailwind CSS + shadcn/ui (+ `data-theme` CSS 토큰)
- **상태**: Zustand
- **IPC 타입**: tauri-specta 자동 생성(`src/types/bindings.ts`, devmode)
- **타겟 OS**: Windows 1순위, macOS / Linux 2순위

## 문서 읽는 순서

새 작업을 시작하기 전에 **반드시** 다음 순서로 읽으세요 (본인도, Claude Code도):

1. [`CLAUDE.md`](./CLAUDE.md) — 작업 규칙 (가장 짧음, 가장 중요)
2. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 레이어 구조, IPC 경계, 모듈 책임
3. [`DESIGN.md`](./DESIGN.md) — UI/UX 원칙
4. [`ROADMAP.md`](./ROADMAP.md) — 단계별 목표와 완료 상태
5. `docs/specs/` — 기능별 설계 문서
