# ROADMAP.md

> 단계별 목표. 한 단계가 끝나야 다음으로.
> 각 MVP는 "혼자 일상에서 쓸 수 있는 상태"가 목표.

## MVP-0: Tauri 부트스트랩 + 로컬 듀얼 패널

**완료 조건**: 로컬 파일시스템에서 듀얼 패널이 동작하고 디렉토리 탐색 가능.

- [x] Tauri 프로젝트 부트스트랩 (Vite + React + TypeScript)
- [x] Tailwind + shadcn/ui 셋업, 다크/라이트 모드
- [x] `FileSystem` trait + `LocalFs` 기본 구현
- [x] `commands/list_directory` 첫 IPC
- [x] 듀얼 패널 컴포넌트 (`<Pane>`)
- [x] 가상 스크롤 적용 (`@tanstack/react-virtual`)
- [x] 키보드 네비 (↑↓, Enter, Backspace, Tab)
- [x] 활성 패널 표시
- [x] 사이드바 토글 (Ctrl+B)
- [x] 상태바 (선택 정보)
- [x] Ctrl+Q 종료

**완료 시 일상 사용**: 로컬 파일 탐색용 (read-only).

## MVP-1: SSH 연결

**완료 조건**: SSH 호스트에 연결해서 한 패널을 SFTP로 띄울 수 있다.

- [x] `russh` 통합, `ssh/connection.rs`
- [x] `~/.ssh/config` 파싱, 호스트 자동완성
- [x] 키 인증 (key file, agent)
- [ ] 비밀번호 인증 (백엔드 메모리 only) — 함수는 있으나 secure prompt 미연결 (Task 7b)
- [x] ProxyJump 지원 (russh nested session, 시스템 ssh 명령 사용 X) — 1-hop
- [x] `SshFs` 구현 (`russh-sftp`)
- [x] 사이드바에 호스트 목록 + 연결 상태
- [x] 새 연결 다이얼로그
- [x] 연결 상태 이벤트 (`connection:state`)
- [x] 자동 재연결 + 백오프
- [x] `getpeername()` 으로 peer IP 캡처 → `SourceId::Ssh.host_ip` 채우기
- [x] fs:changed 이벤트 (로컬 `notify`, SSH 활성 패널 디렉토리 mtime 폴링 3-5s + 포커스 복귀 시 강제 갱신)

**완료 시 일상 사용**: 로컬 + 원격 한 곳씩 띄워서 read-only 탐색.

## MVP-2: 파괴적 작업 + 안전망 (가장 중요)

**완료 조건**: 안전하게 복사/이동/삭제할 수 있다. 영구 삭제 사고 불가능.

- [x] `DeleteOp`, `CopyOp`, `MoveOp` — Confirmed 토큰은 plan/execute 두 단계 IPC 로 대체 (spec 참조)
- [x] 휴지통 모델
  - 로컬: `trash` crate (OS 휴지통). macOS 는 restore 미지원 (Finder 수동) — restore 시 NotSupported
  - 원격: `~/.duet-trash/<batch-id>/<original-absolute-path>/` 로 mv (batch-id = UTC ts + uuid)
  - mv 실패 시 작업 abort + UI alert (영구삭제 폴백 금지)
- [x] 영구 삭제 디폴트 OFF, 켜져 있어도 단어 "delete" 타이핑 확인
- [x] 확인 다이얼로그 컴포넌트 (Confirm / DangerConfirm) + Rename / Mkdir / Progress / Settings
- [x] Journal 시스템 (`<config_dir>/duet/journal.jsonl`, JSONL append-only, uuid v7 정렬)
- [x] Undo (`Ctrl+Z`) — N단계 스택, 세션 간 영속, 영구삭제는 Irreversible
- [x] 복사 (F5)
- [x] 이동 (F6)
- [x] 이름 변경 (F2)
- [x] 새 폴더 (F7)
- [x] 충돌 시 backup 파일 (`name.bak.<UTC ts>` — timestamp 충돌 시 .<n> retry)
- [x] 같은 호스트 SSH↔SSH copy 명시적 차단 (`NotSupported("MVP-3")`) — CLAUDE.md DON'T

**완료 시 일상 사용**: TC 대체 가능 (단, 같은 호스트 복사는 아직 느림).

## MVP-3: 같은 호스트 복사 최적화 (핵심 차별점)

**완료 조건**: 같은 SSH 호스트 내에서 복사하면 본인 PC를 거치지 않는다.

- [x] `core::CopyStrategy` 결정 로직 (Local/Relay/SshSameHost)
- [x] 같은 호스트 감지 (`host_ip` 일치 시 same-host, user 달라도 OK)
- [x] SSH exec 채널로 `rsync` 또는 `cp -a` 실행 (russh exec, 시스템 ssh X)
- [x] 진행률 파싱 (rsync `--info=progress2`) + ProgressEvent + ProgressModal
- [ ] 큰 파일 / 많은 파일에서 검증 (10GB+, 1만개 파일+) — docker compose 후속
- [x] 실패 시 폴백 정책: hard error (silent relay 절대 X — CLAUDE.md DON'T)

**완료 시 일상 사용**: TC보다 명백히 빠른 일상 도구.

## MVP-4: 작업 큐 + 비동기 안정성

**완료 조건**: 큰 작업 중에도 UI 반응. 동시 여러 작업.

- [ ] `TaskQueue` 서비스
- [ ] 진행률 바 컴포넌트 (Toast 위)
- [ ] 작업 목록 패널 (확장)
- [ ] 작업 취소 (`CancellationToken`)
- [ ] 동시 작업 제한 (호스트당 N개)
- [ ] 실패 시 재시도 (네트워크 오류만)

## MVP-5: 검색과 정렬

- [ ] 빠른 필터 (Ctrl+F, 현재 패널 내)
- [ ] 정렬 (이름/크기/날짜/타입), 컬럼 헤더 클릭
- [ ] 숨김 토글 (Ctrl+H)
- [ ] 새로고침 (Ctrl+R)
- [ ] 글로벌 검색 (Ctrl+Shift+F)
  - 로컬: `ignore` crate
  - 원격: SSH 통해 ripgrep 또는 find

## MVP-6: 탭 + 북마크

- [ ] 패널당 탭 (Ctrl+T, Ctrl+W)
- [ ] 북마크 (사이드바)
- [ ] 최근 디렉토리 (Alt+←/→ 히스토리)
- [ ] 호스트별 즐겨찾기

## MVP-7: 커맨드 팔레트 + 설정

- [ ] Ctrl+P 커맨드 팔레트
- [ ] 설정 화면 (`Ctrl+,`)
- [ ] `keymap.toml` 핫 리로드
- [ ] 사용자 명령 (alias)

## 장기 (Maybe)

- [ ] 파일 미리보기 (이미지, 텍스트)
- [ ] 압축/해제 (zip, tar.gz)
- [ ] 동기화 모드 (rsync 기반)
- [ ] 점프 호스트 풀 SSH 동작
- [ ] Drag & Drop (외부 앱 → duet, duet → 외부)
- [ ] 다중 선택 일괄 이름 변경

---

## 현재 단계

**MVP-4 시작 직전.** MVP-3 핵심 완료 — same-host SSH 복사가 server-side rsync/cp 로 실행됨 (silent relay 차단). 큰 파일 stress test 는 docker 환경 마련 후 후속.

## 단계 변경 규칙

- 한 MVP 완료 전에 다음 단계 작업 시작 금지
- 단계 내에서는 순서 자유
- 단계 변경 시 이 파일에 체크 표시 + 커밋
- "이거 한 김에 저것도" 금지 — 다음 단계로 미루기

## 절대 미루지 말 것

다음 두 가지는 **MVP-2** 이내에 반드시 완성:
1. **영구 삭제 사고 방지** (휴지통 디폴트 + 단어 타이핑 확인)
2. **Undo 시스템** (Journal + Ctrl+Z)

이 두 가지가 본인이 TC에서 겪던 문제의 직접 해결책이고,
이게 없는 도구는 본인이 일상에서 못 씀. 다른 기능 다 미뤄도 이건 MVP-2.
