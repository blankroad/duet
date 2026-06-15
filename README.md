# duet

> 안전하고 빠른 듀얼 패널 SSH/SFTP + 로컬 파일 매니저.
> 모던 GUI. Windows / macOS / Linux.

## 한 줄 설명

Tauri + React 기반의 듀얼 패널 파일 매니저. 같은 호스트 SFTP 패널 간
복사는 원격에서 직접 `cp`/`rsync` 실행 (네트워크 왕복 없음). 영구 삭제 없는
안전한 휴지통 모델. 모든 파괴적 작업은 undo 가능.

## 왜 만드는가

기존 도구들의 구체적인 문제 해결:
- TC: Symantec DLP 충돌, 휴지통 동작 시 멈춤, 같은 호스트 SFTP 간 복사 시
  네트워크 왕복 (10GB 파일 → 30분이 5분이면 될 일)
- WinSCP, FileZilla 등: 듀얼 패널 약하거나 없음
- yazi/ranger: TUI라 GUI 워크플로우와 안 맞음
- ForkLift, Path Finder: 유료 + macOS 전용

## 상태

✅ **기능 완성.** MVP-1~7 전부 구현 + 장기(Maybe) 항목 대부분 완료.
본인용 도구 — 외부 사용자/배포 패키징은 고려하지 않음.

단계별 상세 진행 상황은 [`ROADMAP.md`](./ROADMAP.md).

## 핵심 기능

### 파일 관리 (로컬 + 원격 동일 UX)
- 듀얼 패널 + 가상 스크롤 (`@tanstack/react-virtual`), 설정 가능한 키보드 네비게이션
- 복사(F5) / 이동(F6) / 이름변경(F2) / 새 폴더(F7) / 다중 선택 일괄 이름변경
- 탭(패널당), 사이드바 북마크, 호스트별 즐겨찾기, 최근 디렉토리 back/forward(Alt+←/→)
- 빠른 필터(Ctrl+F), 정렬(이름/크기/날짜/타입/확장자), 숨김 토글(Ctrl+H)
- 글로벌 파일명 검색(Ctrl+Shift+F) — 로컬은 `.gitignore` 존중, 원격은 SSH `find`
- 파일 미리보기 — 이미지 / 텍스트 / PDF / 미디어 스트리밍 / Quick Look

### 안전망 (가장 중요)
- 영구 삭제 디폴트 OFF — 삭제는 휴지통 이동 (로컬: OS 휴지통, 원격: `~/.duet-trash/`)
- 영구 삭제를 켜도 단어 "delete" 타이핑 확인 한 번 더
- 모든 파괴적 작업 → Journal(`journal.jsonl`) 기록 → `Ctrl+Z` undo (세션 간 영속)
- 충돌 시 backup 파일 자동 생성 (`name.bak.<ts>`)

### SSH / SFTP
- `russh` 순수 Rust — 시스템 `ssh`/`scp`/`sftp` 바이너리 호출 안 함
- `~/.ssh/config` 파싱 + 호스트 자동완성, 키 / agent / 비밀번호 인증
- N-hop ProxyJump (nested session), 자동 재연결 + 백오프
- **같은 호스트 SFTP 간 복사는 원격에서 직접 실행** (`cp`/`rsync`, 본인 PC 안 거침)
  — duet 의 핵심 차별점. 진행률은 rsync `--info=progress2` 파싱

### 고급 작업
- 작업 큐 (호스트당 FIFO worker) + 진행률 바(TasksBar) + 항목 단위 취소
- 폴더 비교(folder diff) — 트리뷰, rename/move 감지, 3-way(base) 비교 + 자동 해결 적용
- 동기화 모드 — 단방향 미러 / 비교 기반 양방향 머지, 드라이런 사전 표시
- 압축/해제(zip, tar.gz) + 아카이브 내부 탐색 + 편집 후 repack
- 비교 결과 export(CSV/JSON)
- 대용량 relay 복사 chunk 스트리밍(OOM 해소) + 중단 시 `.part` 재개

### UX
- 커맨드 팔레트(Ctrl+P) — fuzzy, built-in + saved hosts + bookmarks + favorites + alias
- 설정 화면(Ctrl+,) + `keymap.toml` 핫 리로드 + 사용자 명령(alias)
- 다크 / 라이트 모드, 외부 앱 연동(app launcher)

## 빌드

```bash
# 개발 모드 (핫 리로드)
pnpm tauri dev

# 릴리즈 빌드
pnpm tauri build
```

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
- **UI**: Tailwind CSS + shadcn/ui
- **상태**: Zustand
- **타겟 OS**: Windows 1순위, macOS / Linux 2순위

## 문서 읽는 순서

새 작업을 시작하기 전에 **반드시** 다음 순서로 읽으세요 (본인도, Claude Code도):

1. [`CLAUDE.md`](./CLAUDE.md) — 작업 규칙 (가장 짧음, 가장 중요)
2. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 레이어 구조, IPC 경계, 모듈 책임
3. [`DESIGN.md`](./DESIGN.md) — UI/UX 원칙
4. [`ROADMAP.md`](./ROADMAP.md) — 단계별 목표와 완료 상태
