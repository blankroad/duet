# Drop Stack / Shelf (선반) — 설계 ⭐

> 2026-06-24. 여러 폴더·여러 호스트에서 파일을 **선반**에 모은 뒤, 한 번에 현재 위치로
> 복사/이동. Path Finder 의 Drop Stack, Directory Opus 의 Collections 계열.
> duet 의 간판 차별화 기능.

**상태**: 설계 (벤치마킹 후속 #4, 간판). 프론트 상태 + **기존 ops 재사용**(IPC 신규 없음).

## 문제

서로 다른 위치/호스트에 흩어진 파일을 한곳에 모으려면, 매번 양 패널을 그 위치로 맞추고
복사하는 왕복을 반복해야 한다. 듀얼패널의 "좌→우" 단일 쌍 모델로는 "A폴더 3개 + B폴더 2개
+ 원격 C 1개를 D로" 같은 수집-후-일괄 작업이 불편하다.

## 합의된 동작 (UX)

- **선반에 담기**: 항목 선택 후 키 `Ctrl+Shift+A`(Add to shelf) / 컨텍스트 메뉴 "선반에
  담기" / 드래그하여 선반 패널에 드롭.
- **선반 패널**: 사이드바 하단(또는 하단 도크)에 모인 항목 리스트. **source 혼합** 표시
  (로컬/각 SSH 호스트 칩 + 경로 + 이름). 개별 제거(×), 전체 비우기.
- **여기로 가져오기**: 선반 패널의 `여기로 복사` / `여기로 이동` → **현재 활성 패널 위치**
  를 목적지로 실행. 작업 후 선반 유지/비우기 토글.
- 선반에서 패널로 **드래그 아웃** = 그 위치로 복사(`Ctrl`=이동).

## 핵심 설계 — 기존 ops 100% 재사용

레이어: **프론트 상태 + 기존 `fs_*` command.** 새 IPC 없음.

- 선반 항목 = `EntryRef`(`{ location, name }`). 여러 source 혼재 가능.
- `여기로 복사` 실행 시:
  1. 선반 항목을 **source 별로 그룹화**(같은 source 끼리 묶음).
  2. 각 묶음마다 `fs_copy_plan(items, dst = 활성 location)` → 충돌 있으면 기존
     `CopyMoveConfirmDialog` → `fs_copy_execute`.
  3. 같은 SSH 호스트끼리면 core 의 `CopyStrategy` 가 **same-host 직접 복사**를 자동 선택
     (네트워크 왕복 없음 — duet 핵심 가치가 선반에도 그대로 적용).
- → **작업 큐, 진행률, 저널, undo(`Ctrl+Z`) 전부 공짜로 따라온다.** 선반은 "EntryRef 모음 +
  목적지 = 활성 패널" 이라는 얇은 오케스트레이션일 뿐.

## 프론트엔드

- `stores/shelf.ts` (신규):
  ```ts
  interface ShelfState {
    items: EntryRef[];                 // 중복 제거(source+path+name 키)
    add(refs: EntryRef[]): void;
    remove(key: string): void;
    clear(): void;
    keepAfterApply: boolean;
  }
  ```
- `components/ShelfPanel.tsx`: 항목 리스트(source 칩 + 아이콘 + 이름), 헤더에
  `복사`/`이동`/`비우기`, 항목별 ×. 비었으면 접힘.
- 액션 연결: `lib/fileActions.ts` 에 `applyShelfTo(dstLocation, mode)` — source 그룹화 후
  기존 copy/move plan→execute 흐름 호출.
- 담기 경로: 컨텍스트 메뉴(`lib/entryMenu.tsx`), 키(`useKeyboardNav`), 드래그
  (`hooks/useEntryDrag.ts` → 선반 드롭 타깃 추가, `lib/dropTarget.ts`).

### command id (재바인딩 가능)

| command id | 기본 키 | 동작 |
|---|---|---|
| `shelf.add` | `Ctrl+Shift+A` | 선택 항목 선반에 담기 |
| `shelf.applyCopy` | — | 선반 → 활성 패널로 복사 |
| `shelf.applyMove` | — | 선반 → 활성 패널로 이동 |
| `shelf.clear` | — | 선반 비우기 |
| `shelf.toggle` | `Ctrl+Shift+B` | 선반 패널 토글 |

## 엣지/에러

- 목적지가 선반 항목의 부모와 동일 → "같은 위치" 경고/스킵.
- 이동인데 항목이 원본에서 사라짐 → 해당 묶음 plan 이 NotFound → 그 항목만 스킵 + 토스트.
- 혼합 source 는 묶음마다 별도 task(호스트별 FIFO 큐로 들어감). 부분 실패해도 저널은
  성공분만 기록 → undo 정확.
- 같은 항목 중복 담기 = no-op(키 중복 제거).

## 범위 밖 (후속)

- 선반 **영속**(세션 간) — 우선 세션 내 메모리.
- 다중 명명 선반(슬롯), 선반 내 정렬/필터.
- 선반에서 직접 압축/삭제 등 추가 일괄 액션.
