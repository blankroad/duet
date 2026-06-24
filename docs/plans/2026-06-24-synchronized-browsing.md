# 동기화 브라우징 — 실행 plan

> spec: `docs/specs/2026-06-24-synchronized-browsing.md`. 프론트 전용.

## 접근 — 의미 단위 후킹 (경로 diff 회피)

`navigate`/`navigateTo` 를 일반 diff 하는 대신, **이미 의미가 분명한 두 액션**에만 동행을
건다 → 단순·예측가능, 무한루프 없음(동행은 `setEntries` 직접 호출이라 재진입 안 함).

- `onActivate` 의 **폴더 진입** 분기: 반대 패널을 `childLocation(반대.location, name)` 으로 동행.
- `onUp` 의 **부모 이동** 분기: 반대 패널을 `parentLocation(반대.location)` 으로 동행.
- 주소창/북마크/back-forward(절대 점프)·아카이브·휴지통 진입은 **동행 안 함**(예측가능).

## 작업

1. `src/stores/ui.ts` — `syncBrowse: boolean` + `toggleSyncBrowse()` (localStorage 영속).
2. `src/App.tsx` — `syncMirror(srcId, target)` 헬퍼(조용한 listDirectory+setEntries,
   실패 무시). `onActivate` 폴더 분기 / `onUp` 부모 분기에서 syncBrowse·비아카이브일 때 호출.
   `buildBuiltins` 에 `toggleSyncBrowse` dep.
3. `src/lib/commands.ts` — `view.syncBrowse` 명령(기본 키 없음) + dep 타입.
4. `src/components/pane/PaneToolbar.tsx` — 동기화 토글 버튼(전역 상태, active 강조).

## 검증

수동: sync ON → 좌측에서 `src/` 진입 시 우측도 `src/` 로(있으면), 위로 가면 양쪽 위로.
없으면 우측 그대로. tsc/lint/build.

## 범위 밖

스크롤/커서 동기화, 절대점프 basename 동행, 자동 비교.
