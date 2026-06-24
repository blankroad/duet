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
- [x] 비밀번호 인증 (백엔드 메모리 only) — dialog `<input type=password>` → IPC, 사용 직후 zeroize (§5 2026-05 완화, Task 7b)
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
- [x] 큰 파일 / 많은 파일에서 검증 (10GB+, 1만개 파일+) — docker compose 통합 테스트 하니스
      (`scripts/ssh-it.sh`, `src-tauri/tests/ssh_it_*`). 기본 256MB/2000개, `DUET_SSH_IT_BYTES`/`_COUNT` 로 10GB/1만개 opt-in
- [x] 실패 시 폴백 정책: hard error (silent relay 절대 X — CLAUDE.md DON'T)

**완료 시 일상 사용**: TC보다 명백히 빠른 일상 도구.

## MVP-4: 작업 큐 + 비동기 안정성

**완료 조건**: 큰 작업 중에도 UI 반응. 동시 여러 작업.

- [x] `TaskQueue` 서비스 (per-host_key FIFO worker)
- [x] 진행률 바 컴포넌트 (TasksBar — StatusBar 위)
- [x] 작업 목록 (TasksBar dropdown 2+ active)
- [x] 작업 취소 (`CancellationToken` — 항목 경계 단위)
- [x] 동시 작업 제한 (호스트당 1, N개 사용자 설정은 후속 MVP-7)
- [x] 실패 시 재시도 (연결 끊김만 1회, 3초 sleep)

## MVP-5: 검색과 정렬

- [x] 빠른 필터 (Ctrl+F, 현재 패널 내) — substring case-insensitive
- [x] 정렬 (이름/크기/날짜/타입/확장자), 컬럼 헤더 클릭 / Ctrl+1..5
- [x] 숨김 토글 (Ctrl+H) — dotfiles 디폴트 숨김
- [x] 새로고침 (Ctrl+R / F5)
- [x] 글로벌 검색 (Ctrl+Shift+F) — **파일명 only** v1
  - 로컬: `ignore` crate (`.gitignore` 자동 존중)
  - 원격: SSH `find -iname` exec
  - 내용 검색 (grep) 은 후속 (SearchBackend trait 확장 가능)

## MVP-6: 탭 + 북마크 + 히스토리

- [x] 패널당 탭 (Ctrl+T 새 탭, Ctrl+W 닫기, Ctrl+Tab/Shift+Tab 전환) — 세션 내만
- [x] 사이드바 북마크 (any location, ⭐ 섹션) — Sidebar + 클릭 시 활성 탭 navigate
- [x] 최근 디렉토리 (Alt+←/→) — 탭당 back/forward 스택, cap 100
- [x] 호스트별 즐겨찾기 (💖 섹션, 활성 connection 의 alias 만 표시)

## MVP-7: 커맨드 팔레트 + 설정

- [x] Ctrl+P 커맨드 팔레트 — fuzzy 매칭, built-in + saved hosts + bookmarks + favorites + user aliases
- [x] 설정 화면 (`Ctrl+,`) — sidebar/content 섹션화 (General + Keymap + Aliases)
- [x] `keymap.toml` 핫 리로드 — `notify` watcher + `KeymapChangedEvent`
- [x] 사용자 명령 (alias) — Navigate / Connect, user-aliases.json

## 장기 (Maybe)

- [x] 파일 미리보기 (이미지, 텍스트, PDF/미디어 스트리밍, Quick Look)
- [x] 압축/해제 (zip, tar.gz) + 아카이브 내부 탐색(browse) + 편집 후 repack
- [x] 폴더 비교 (folder diff) — 두 패널 재귀 비교(좌측만/우측만/최신/다름/동일)
- [~] 동기화 모드 — local↔local 단방향 미러(추가 전용) + 비교 기반 안전 양방향 머지
      (한쪽-전용 파일 양방향 복사, 충돌·삭제 미변경). same-host rsync sync /
      prune(--delete) / 3-way 충돌해결은 후속(baseline·undo 추적 설계 필요)
- [x] 전송 안정성 — relay 복사 chunk 스트리밍(대용량 OOM 해소) + 진행률/취소 +
      중단 시 .part 재개(같은 op retry 한정)
- [x] 점프 호스트 풀 SSH 동작 — N-hop ProxyJump 체인
- [ ] Drag & Drop (외부 앱 → duet, duet → 외부)
- [x] 다중 선택 일괄 이름 변경 (batch rename)

## 사이드바 재설계 (2026-06-24) — 11섹션 정리·통합

> 리서치(Transmit·ForkLift·Cyberduck·Termius·FileZilla·Finder·Dolphin 등) 기반.
> 별명 전파 + 호스트/북마크 통합 + 태그. spec `docs/specs/2026-06-24-sidebar-redesign.md`.

- [x] **Phase 1 — 호스트 별명** — host-nicknames.json + hostLabel. 사이드바 Hosts 행
      별명 편집(우클릭) + 패널/상태바가 IP 대신 별명 표시. (2026-06-24)
- [x] **Phase 2 — Hosts 통합** — ssh-config + saved 를 한 "Hosts" 섹션으로(SubLabel
      구분, alias dedup, saved 도 별명 편집). (2026-06-24)
- [x] **Phase 3 — Bookmarks 통합** — Host Favorites 를 "Bookmarks" 섹션으로 흡수
      (Local/Remote SubLabel, "+" 가 소스별 라우팅, fav 그룹 헤더 별명). (2026-06-24)
- [x] **Phase 4 — 태그(다대다)** — tags.json(키→태그[], key=host:/bm:/fav:) +
      tag_list/set. TagBar 칩 필터(OR), 우클릭 "Edit tags…", 행 인라인 #tag 표시.
      Hosts·Bookmarks 가 활성 태그로 좁혀짐. (2026-06-24)
- [x] **Phase 5 — 섹션 정리** — Places+Volumes+This PC 를 한 "Places" 섹션으로
      (Volumes SubLabel, 원격일 때만 This PC 앵커). 11 → 6 섹션(+TagBar). (2026-06-24)

## 벤치마킹 후속 (2026-06-24) — 경쟁 탐색기 대비 가치 향상

> 대표 탐색기 24종(Directory Opus·TC·yazi·ForkLift·WinSCP·Path Finder·Dolphin 등)
> 벤치마킹 후 선정. 작은 승리 4종 + 간판 1종. spec 은 `docs/specs/2026-06-24-*`.

- [ ] **패턴 선택 (glob-select)** — `*.jpg` 일괄 선택/해제. 프론트 전용.
      → `docs/specs/2026-06-24-glob-select.md`
- [x] **동기화 브라우징** — 양 패널 상대경로 동행 이동(존재 시). 프론트 전용.
      폴더 진입/위로에만 동행, 툴바 토글 + `view.syncBrowse`. (2026-06-24)
      → `docs/specs/2026-06-24-synchronized-browsing.md`
- [x] **frecency 점프 (Ctrl+J)** — 자주·최근 방문 폴더 부분문자열 점프.
      services/frecency.rs(JSON, ln(count)×최근성 감쇠) + frecency_record/query +
      FrecencyJumper. navigate 성공 시 기록. (2026-06-24)
      → `docs/specs/2026-06-24-frecency-jump.md`
- [x] **Drop Stack / Shelf ⭐** — 여러 위치 수집 후 활성 패널로 일괄 복사/이동.
      기존 ops·저널·undo·same-host 전략 재사용(IPC 신규 없음). 사이드바 Shelf 섹션 +
      "Add to shelf"(Ctrl+Shift+A). 혼합 소스 순차 적용은 후속. (2026-06-24)
      → `docs/specs/2026-06-24-drop-stack-shelf.md`
- [ ] **그리드/타일 썸네일** — 이미지 lazy 썸네일 + 캐시(1차 순수 Rust, 영상 제외).
      `image` 크레이트 §6 승인 필요. → `docs/specs/2026-06-24-thumbnail-grid.md`

---

## 현재 단계

**모든 MVP 완료.** MVP-1~7 — duet 의 정식 기능 모두 구현. 이후 장기 (Maybe) 항목 또는 안정화/UX 개선.

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
