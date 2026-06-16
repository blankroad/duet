# 단축키 통합 + Keymap UI + 설정 보강

> 2026-06-16. 파일 작업을 재설정 가능하게 만들고, Keymap UI·Settings 를 보강.

## 문제

- `useGlobalShortcuts` 는 커맨드 레지스트리(`lib/commands.ts`) 기반(binding 우선, 없으면 defaultKey)
  이고 `KeymapSection` 은 이미 재바인딩 UI(Edit/Reset/충돌/키캡처)를 갖춤. **그런데 핵심 파일
  작업(복사·이동·삭제·이름변경·새폴더)만 레지스트리 밖**에서 하드코딩 훅(`useDestructiveKeys`,
  F5/F6/Del/F2/F7)으로 처리됨 → 재설정·팔레트 노출 불가. **경로/이름 복사**는 우클릭 메뉴에만 있고
  단축키 없음.
- `General` 설정 = `permanent_delete_enabled` 토글 1개. Settings struct 3필드.
- `keymap.toml.example` 는 옛 action-name 기반 → 현재 `command_id` 시스템과 불일치(stale).

## Part 1 — 파일 작업을 커맨드 레지스트리로 통합

`lib/commands.ts` 에 추가 (액션은 `fileActions.ts` 의 trigger* 재사용, `App.tsx` deps 주입):
- `file.copy`(F5), `file.move`(F6), `file.delete`(Delete), `file.deletePerm`(Shift+Delete),
  `file.rename`(F2; action 내부에서 단일=rename/다중=batch 분기), `file.newFolder`(F7),
  `file.newFile`, `file.selectAll`(Ctrl+A), `edit.undo`(Ctrl+Z)
- 신규: `file.copyPath`(전체경로 클립보드, Ctrl+Shift+C), `file.copyName`(파일명, Ctrl+Shift+Alt+C)
- `useDestructiveKeys` 하드코딩 디스패치 은퇴 → 전부 `useGlobalShortcuts` 경유(입력창 자동 차단).
- copyPath/copyName 는 우클릭 메뉴에도 노출.
- 유지: `Ctrl+C` = 반대 패널로 복사(TC식). 클립보드 복사는 신규 키로 분리.

## Part 2 — Keymap UI 폴리시 (`KeymapSection.tsx`)

- 검색/필터 박스(label·category·key), "전체 기본값 복원" 버튼(기존 `keymap_reset` 재사용),
  default/custom 출처 표시, 충돌 목록 개선.
- `keymap.toml.example` 를 현재 `command_id` 기반으로 갱신.

## Part 3 — 설정 보강 (curated)

각 항목 = `Settings` struct 필드(`#[serde(default)]` 하위호환) + `GeneralSection` UI + **실제 배선**:
- 테마(Light/Dark/System) → `stores/ui`
- 기본 뷰(상세/그리드/타일) → 탭 생성
- 숨김파일 기본 표시 → 패널 초기화
- 기본 정렬 → 탭 생성
- 삭제 전 확인 토글 → delete 게이트
- 날짜/크기 포맷 → `lib/format`
- 기본 터미널/에디터 앱 → app launch

구현 단계에서 우선순위로 트림 가능 (죽은 토글 금지 — 배선까지).

## 구현 순서

Part 1(프론트) → Part 2(프론트) → Part 3(백+프론트). 각 단계 `tsc`+`vitest` / `cargo test`+clippy
통과 후 별도 커밋.

## 테스트

- Part 1: 레지스트리에 파일 작업 등재 확인(단위), copyPath/Name 액션(클립보드 모킹), useGlobalShortcuts
  디스패치(입력창 차단 포함).
- Part 2: 검색 필터 로직, restore-defaults 호출.
- Part 3: settings 라운드트립(기존 패턴), 각 배선 지점.

## 범위 밖 (후속)

- 키 시퀀스(2-step, vim `gg`), 다중 keymap 프로파일, 버튼바 커스터마이즈.
