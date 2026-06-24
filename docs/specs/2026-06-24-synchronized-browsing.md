# 동기화 브라우징 (synchronized browsing) — 설계

> 2026-06-24. 토글 ON 시 한 패널이 폴더로 이동하면 반대 패널도 같은 **상대 경로**만큼
> 따라 이동(존재할 때만). WinSCP/FileZilla/ForkLift 의 synchronized browsing.

**상태**: 설계 (벤치마킹 후속 #2). 프론트 전용, 기존 navigate 재사용.

## 문제

듀얼패널인데 두 폴더 트리를 나란히 따라다니며 비교/탐색하려면 양쪽을 수동으로 맞춰야
한다. 미러 구조(예: `src/`↔`backup/src/`, 로컬↔원격 동일 트리)에서 반복 노동.

## 합의된 동작 (UX)

- 툴바 토글 버튼 + command `view.syncBrowse` (기본 키 없음, 팔레트/툴바로 토글).
- ON 상태에서 **활성 패널**이 navigate(폴더 진입/상위이동/주소창/북마크/히스토리)하면:
  - 그 이동의 **상대 변화(delta)** 를 반대 패널 현재 경로에 적용 → 그 경로가 존재하면
    반대 패널도 navigate, 없으면 **조용히 skip**(반대 패널 유지).
- 어느 패널이 활성이든 기준 = 활성 패널(양방향).
- 토글 상태는 전역 1개(좌우 공유), 세션 내 유지.

## 동작 정의 (delta)

- 진입: 활성이 `A/x` → `A/x/sub` 이면 delta = `+sub` → 반대 `B/x` → `B/x/sub`.
- 상위: 활성이 `A/x/sub` → `A/x` 이면 delta = `-1 level` → 반대도 한 단계 상위.
- 절대 점프(주소창/북마크): 공통 접두 기준 상대화가 모호 → **basename 동행**만 시도
  (반대 패널의 같은 부모 아래 같은 이름 폴더가 있으면 이동, 없으면 skip). 단순·예측가능 우선.
- source 는 각자 유지 — 로컬↔원격 혼합에서도 **상대 경로 문자열만** 공유.

## 프론트엔드

레이어: **프론트 전용.** 새 command 없음(기존 `list_directory` 로 존재 확인 후 navigate).

- `stores/ui.ts`: `syncBrowse: boolean` + `toggleSyncBrowse()`.
- `stores/panes.ts` `navigate()` 후처리 훅:
  - sync ON이고, 이번 navigate 가 **사용자 발(發)**(동기화로 인한 것이 아님)일 때만
    반대 패널 동행. **재진입 가드** 플래그(`__syncOrigin`)로 무한 루프 차단.
  - 반대 패널 후보 location 계산 → `listDirectory(候補)` 시도 → Ok 면 `navigate(반대, 候補,
    { pushHistory: true })`, Err(NotFound/권한) 면 무시.
- 툴바: `components/pane/PaneToolbar.tsx` 또는 `TopBar.tsx` 에 토글 아이콘(활성 강조).

## 엣지/에러

- 아카이브 browse 중인 패널이 관여하면 동행 비활성(임시추출 경로라 의미 없음).
- 반대 패널이 미연결 원격이면 skip(연결 자동복구는 후속).
- 루트 위로는 더 못 감 → skip.
- 탭 전환으로 활성 패널의 location 이 바뀌는 경우는 동행 **안 함**(명시적 navigate 만 대상).

## 범위 밖 (후속)

- 스크롤/커서 위치 동기화, 선택 동기화.
- 양 패널 자동 비교 하이라이트(비교 기능과 연계).
- 공통 접두 기반 정교한 절대경로 상대화.
