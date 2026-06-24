# Drop Stack / Shelf — 실행 plan

> spec: `docs/specs/2026-06-24-drop-stack-shelf.md`. 프론트 상태 + 기존 ops 재사용.

## 핵심 제약 (백엔드 확인됨)

`fs_copy_plan` 은 `items[0].location.source` 를 src fs 로 사용 — **단일 소스 가정**.
따라서 shelf 적용은 **소스별 그룹화** 필요. 확인 다이얼로그는 단일 상태(`open` 이 교체)라
v1 은 **첫 소스 그룹만 다이얼로그로 적용**, 나머지 소스는 선반에 남기고 토스트 안내.
(혼합 소스 순차 적용은 후속.) 같은 소스 그룹은 parent path 가 달라도 OK(같은 fs).

## 작업

1. `src/lib/entryDnd.ts` — `sourceKey(SourceId): string` 추가(local|ssh:<connId>).
2. `src/stores/shelf.ts` — `items: EntryRef[]`, `add(refs)→added수`, `remove(key)`,
   `clear()`. dedup 키 = `sourceKey|path|name`. + `shelfKey(ref)` export.
   - `src/stores/shelf.test.ts` — add/dedup/remove/clear.
3. `src/lib/fileActions.ts` — `addSelectionToShelf(showToast)`(resolveActiveTargets →
   shelf.add) + `applyShelfTo(mode, open, showToast)`(소스 그룹화 → 첫 그룹 planTransferTo,
   나머지 토스트).
4. `src/components/ShelfSection.tsx` — 선반 항목 리스트(소스 칩+이름, 개별 ×),
   헤더 `복사`/`이동`/`비우기`. 비었으면 null. Section 컴포넌트는 자체 구현(독립).
5. `src/components/Sidebar.tsx` — `<ShelfSection />` 를 RecentSection 뒤에 렌더.
6. `src/lib/entryMenu.tsx` — "Add to shelf" 항목.
7. `src/lib/commands.ts` — `shelf.add`(Ctrl+Shift+A) / `shelf.applyCopy` /
   `shelf.applyMove` / `shelf.clear` + dep 타입.
8. `src/App.tsx` — 4개 dep 배선.

## 재사용 (신규 IPC 없음)

`planTransferTo` → `fs_copy_plan`/`fs_move_plan` → 확인 다이얼로그 → execute → 작업큐·
저널·undo·same-host 전략 전부 그대로. 같은 호스트 그룹이면 core 가 직접 복사 선택.

## 검증

shelf.test.ts + tsc/lint/build. 수동: 여러 폴더에서 Add to shelf → 활성 패널에서
"복사" → 확인 다이얼로그 → 작업.

## 범위 밖

영속(세션 간), 다중 슬롯, 혼합 소스 순차 적용, shelf 내 정렬/필터, 드래그 인/아웃.
