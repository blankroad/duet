# duet

> 안전하고 빠른 듀얼 패널 SSH/SFTP + 로컬 파일 매니저.
> 모던 GUI. Windows / macOS / Linux.

## 한 줄 설명

Tauri + React 기반의 듀얼 패널 파일 매니저. 같은 호스트 SFTP 패널 간
복사는 원격에서 직접 `cp` 실행 (네트워크 왕복 없음). 영구 삭제 없는
안전한 휴지통 모델. 모든 파괴적 작업은 undo 가능.

## 왜 만드는가

기존 도구들의 구체적인 문제 해결:
- TC: Symantec DLP 충돌, 휴지통 동작 시 멈춤, 같은 호스트 SFTP 간 복사 시
  네트워크 왕복 (10GB 파일 → 30분이 5분이면 될 일)
- WinSCP, FileZilla 등: 듀얼 패널 약하거나 없음
- yazi/ranger: TUI라 GUI 워크플로우와 안 맞음
- ForkLift, Path Finder: 유료 + macOS 전용

## 상태

🚧 초기 설계 단계. 본인용 도구 — 외부 사용자는 고려하지 않음.

## 문서 읽는 순서

새 작업을 시작하기 전에 **반드시** 다음 순서로 읽으세요 (본인도, Claude Code도):

1. [`CLAUDE.md`](./CLAUDE.md) — 작업 규칙 (가장 짧음, 가장 중요)
2. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 레이어 구조, IPC 경계, 모듈 책임
3. [`DESIGN.md`](./DESIGN.md) — UI/UX 원칙
4. [`ROADMAP.md`](./ROADMAP.md) — 현재 단계와 다음 목표

## 빌드

```bash
# 개발 모드 (핫 리로드)
pnpm tauri dev

# 릴리즈 빌드
pnpm tauri build
```

## 기술 스택

- **백엔드**: Rust + Tauri 2 + tokio + russh
- **프론트엔드**: TypeScript + React + Vite
- **UI**: Tailwind CSS + shadcn/ui
- **상태**: Zustand
- **타겟 OS**: Windows 1순위, macOS / Linux 2순위
