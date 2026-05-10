# MVP-6: 탭 + 북마크 + 히스토리 — 설계

> 패널당 다중 탭, 탭별 back/forward 히스토리, 북마크 (any location) + 호스트별
> 즐겨찾기 (host-scoped).

**상태**: 설계 승인 (2026-05-10) → plan → 실행

## 목적 + 성공 기준

- **목적**: 동시 여러 위치 작업, 빠른 위치 회귀, 자주 가는 곳 즐겨찾기.
- **성공 기준**:
  1. 한 패널에서 N 개 탭 동시 (각자 location/cursor/sort/filter 독립)
  2. Alt+←/→ 로 탭 내 이전/다음 location 이동
  3. Ctrl+T = 현재 탭 위치 복제, Ctrl+W = 활성 탭 닫기 (마지막 1개면 no-op)
  4. 북마크 더블클릭 → 활성 탭 navigate (히스토리 push)
  5. 호스트별 즐겨찾기 — 해당 호스트 연결된 동안만 사이드바 표시

## 비목적

- **탭 영속성**: 세션 내만. 재시작 시 패널당 1개 탭으로 복귀.
- 탭 reorder (drag) — 후속.
- 탭 그룹화 / 탭 색상 — 후속.
- Ctrl+1..9 탭 점프 — 후속 (현재 sort 단축키와 우선 정리만).
- 북마크 폴더 (계층 구조) — 후속.
- 북마크 가져오기/내보내기 — 후속.

## 작업 단위

3개 cohesive 단위 (한 spec, 한 plan):

- **A. 탭** — PaneState/TabState 분리, TabBar 컴포넌트, Ctrl+T/W/Tab 단축키
- **B. 히스토리** — 탭당 back/forward 스택, Alt+←/→, PathBar 버튼
- **C. 북마크 + 호스트별 즐겨찾기** — 2 backend store + 사이드바 2 섹션

A 가 foundational (B 가 위에 build, C 는 독립이지만 활성 탭 location 사용).

---

## A. 탭

### State 리팩터

`src/stores/panes.ts`. 현재 PaneState 의 location/entries/cursor/selected/loadedAt/sortKey/sortOrder/showHidden/filter/filterFocused 가 모두 **TabState** 로 이동. PaneState 는 tabs[] + activeTabIndex 만.

```ts
export interface TabState {
  id: string;            // uuid v7 (key 안정성용)
  location: Location;
  entries: Entry[];
  cursorIndex: number;
  selected: Set<string>;
  loadedAt: number;
  sortKey: SortKey;
  sortOrder: SortOrder;
  showHidden: boolean;
  filter: string;
  filterFocused: boolean;
  history: { stack: Location[]; index: number };  // B 단계
}

export interface PaneState {
  tabs: TabState[];      // 항상 ≥ 1
  activeTabIndex: number;
}
```

helper:
- `activeTab(state, paneId): TabState` — 자주 쓰는 접근 단축

### 액션 (탭 관리)

- `openTab(paneId, location?)` — location 미지정 시 현재 활성 탭 location 복제. 새 탭 push + activeTabIndex = 마지막 인덱스. 새 탭은 빈 entries, cursor=-1.
- `closeTab(paneId, index)` — 탭 1개 남았으면 no-op (최소 1개 유지). 활성 탭 닫으면 activeTabIndex = max(0, index-1).
- `selectTab(paneId, index)` — activeTabIndex 변경.

### 액션 (기존 — active tab 위로 dispatch)

기존 setEntries/moveCursor/setCursor/toggleSelected/clearSelection/setSort/toggleSortKey/toggleShowHidden/setFilter/setFilterFocused 모두 시그니처 그대로 (`paneId, ...`) 유지. 내부에서 `activeTabIndex` 의 탭만 변경.

### selectDisplayedEntries

`selectDisplayedEntries(paneId, state)` — 활성 탭 기준으로 raw → filter → hidden → sort. 기존과 동일 인터페이스, 내부만 변경.

### UI: TabBar

위치: PathBar 위.

```
┌────────────────────────────────────────────────┐
│ ▎duet  ▎var  ▎tmp  ✕  ▎ +                       │  ← 탭 바
├────────────────────────────────────────────────┤
│ ←  →  ↻  /home/user/Projects/duet               │  ← PathBar (B)
├────────────────────────────────────────────────┤
│ entries...                                     │
```

- 탭 라벨: location.path 의 마지막 segment, 또는 "/" 면 "/". SSH 면 prefix `host:` 추가.
- 활성 탭: left border = accent (DESIGN.md 동일 표현).
- 비활성 탭: hover 시 X 버튼 노출, 클릭 시 closeTab.
- 가장 오른쪽 + 버튼 (openTab 호출, location=undefined → 복제).
- 탭이 1개일 때 TabBar 자체 렌더 X (공간 절약).

### 단축키

| 키 | 동작 |
|---|---|
| Ctrl+T | 활성 패널 새 탭 (현재 location 복제) |
| Ctrl+W | 활성 패널 활성 탭 닫기 (1개 남으면 no-op) |
| Ctrl+Tab | 활성 패널 다음 탭 |
| Ctrl+Shift+Tab | 활성 패널 이전 탭 |

기존 단축키 변경:
- **Ctrl+1..5 (sort)** → **Ctrl+Shift+1..5** 로 이전. DESIGN.md 가이드 358 라인. 향후 Ctrl+1..9 = 탭 점프 (MVP-6 후속).

---

## B. 히스토리 (탭당 back/forward)

### State

각 TabState 의 `history: { stack: Location[]; index: number }`:
- `stack` = 시간순 방문 location 리스트
- `index` = 현재 위치 (보통 stack.length - 1)
- `back` 가능: index > 0
- `forward` 가능: index < stack.length - 1

신규 탭: `history = { stack: [tab.location], index: 0 }`.

### 액션 의미

- `setEntries(paneId, location, entries, opts?)` — `opts.pushHistory ?? true`. true 일 때:
  - 현재 stack[index].path 와 location.path 비교 → 같으면 push 안 함 (refresh 동일 위치)
  - 다르면 stack 을 index+1 까지 자르고 push, index = stack.length - 1
- `back(paneId): Location | null` — index > 0 일 때 index-- + stack[index] 반환. 아니면 null.
- `forward(paneId): Location | null` — 대칭.

### App.tsx navigate 갱신

```ts
const navigate = (id, path, { pushHistory = true } = {}) => {
  // listDirectory 호출, 성공 시 setEntries(id, loc, entries, { pushHistory })
};

const onBack = (id) => {
  const prev = usePanes.getState().back(id);
  if (prev) navigate(id, prev.path, { pushHistory: false });
};
const onForward = (id) => { /* 대칭 */ };
```

### UI: PathBar back/forward 버튼

```
┌──────────────────────────────────────┐
│ ←(disabled)  →  ↻  /home/user        │  index=0 (back disabled)
└──────────────────────────────────────┘
```

- 좌측 ← / → 아이콘 버튼. 가능 여부에 따라 disabled.
- 클릭 시 onBack(id) / onForward(id).
- 새로고침 ↻ 는 기존 그대로.

### 단축키

| 키 | 동작 |
|---|---|
| Alt+← | 활성 패널 활성 탭 back |
| Alt+→ | forward |

---

## C. 북마크 + 호스트별 즐겨찾기

### Backend

#### Bookmarks (any location)

`src-tauri/src/services/bookmarks.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct Bookmark {
    pub id: String,            // uuid v7
    pub name: String,          // 사용자 표시명
    pub location: Location,    // source + path
}

pub struct BookmarksStore {
    path: PathBuf,
    inner: RwLock<Vec<Bookmark>>,
}

// API: list, add (name, location → Bookmark with new uuid), remove (id), rename (id, new_name)
```

저장: `<config_dir>/duet/bookmarks.json` (SavedHostsStore 동형).

#### Host favorites (host-scoped)

`src-tauri/src/services/host_favorites.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct HostFavorite {
    pub id: String,
    pub host_alias: String,    // ssh_config alias 또는 saved_host alias
    pub name: String,
    pub path: PathBuf,         // 절대경로
}

pub struct HostFavoritesStore { /* 동일 패턴 */ }

// API: list, add, remove
```

저장: `<config_dir>/duet/host-favorites.json`.

### IPC commands

각 store 당 3 commands (총 6):

- `bookmarks_list() -> Vec<Bookmark>`
- `bookmarks_add(name, location) -> Vec<Bookmark>` — 새 uuid 발급, 갱신된 list 반환
- `bookmarks_remove(id) -> Vec<Bookmark>`
- `host_favorites_list() -> Vec<HostFavorite>`
- `host_favorites_add(host_alias, name, path) -> Vec<HostFavorite>`
- `host_favorites_remove(id) -> Vec<HostFavorite>`

### Frontend

#### stores

- `src/stores/bookmarks.ts` — list state + bootstrap/add/remove/rename helpers (savedHosts 패턴)
- `src/stores/hostFavorites.ts` — 동일 패턴

#### Sidebar 갱신

```
┌──────────────┐
│ 📁 Local     │
│ 🖥 Hosts     │
│ 📌 Saved     │
│ ⭐ Bookmarks │  ← 새 (any location, 항상 표시)
│   ⭐ Project │
│   ⭐ /tmp    │
│ 💖 Favorites │  ← 새 (host-scoped, 활성 connection 만)
│   ▸ srv1     │
│     /var/log │
│     /opt/app │
│   ▸ srv2     │
│     /home/u  │
└──────────────┘
```

- **Bookmarks 섹션**: 항상 표시. + 버튼 = 활성 탭 location 캡쳐 + 인라인 input (이름) + Enter. 항목 더블클릭 → onBookmarkActivate(location) → App.navigate(active, loc.path) (source 가 다르면 SourceId 도 교체). 호버 시 X 로 삭제.
- **Favorites 섹션**: connections store 의 활성 alias 와 매칭되는 항목만 표시. host_alias 별 그룹화. + 버튼은 활성 탭이 SSH 일 때만 활성. 같은 add/remove 패턴.

### 동작 정의

- 북마크 더블클릭 = 활성 탭에서 navigate (history push). 새 탭 X.
- Favorite 클릭 시 connection_id 확인:
  - alias 가 활성 connections 에 있으면 그 connection_id 사용
  - 없으면 (자동 disconnect 등) 사용자에게 toast — "Connect to <alias> first"

---

## 통합 / 충돌

### 기존 코드 영향 (탭 리팩터)

대부분의 store accessor 이미 `(paneId, ...)` 시그니처라 인터페이스 안정. 내부적으로 `activeTabIndex` 통과하는 helper 만 추가.

영향 컴포넌트:
- `Pane.tsx` — TabBar 추가, `pane.location` → `activeTab.location` 등
- `App.tsx::navigate` — pushHistory 옵션
- `useKeyboardNav` — 거의 무변경 (active tab 가져옴)
- `useGlobalShortcuts` — 새 키 + sort 단축키 이전

### 단축키 표 (변경 후)

| 키 | 동작 | 비고 |
|---|---|---|
| Ctrl+T | 새 탭 | NEW |
| Ctrl+W | 탭 닫기 | NEW |
| Ctrl+Tab | 다음 탭 | NEW |
| Ctrl+Shift+Tab | 이전 탭 | NEW |
| Alt+← | back | NEW |
| Alt+→ | forward | NEW |
| Ctrl+Shift+1..5 | sort | **CHANGED** (was Ctrl+1..5) |
| Ctrl+1..5 | (예약) | 현재 미사용; 후속 탭 점프 |

---

## 데이터 흐름

### 새 탭

```
Ctrl+T → openTab(active, currentLoc)
      → tabs.push(newTab(currentLoc))
      → activeTabIndex = tabs.length - 1
Pane re-renders, TabBar shows new tab
```

### Navigate + 히스토리

```
User clicks dir / Enter / PathBar segment / bookmark
  → App.navigate(paneId, path, { pushHistory: true })
  → listDirectory(loc)
  → setEntries(paneId, loc, entries, { pushHistory: true })
       └ activeTab.history.stack.splice(index+1) + push(loc)
         + activeTab.history.index++
```

### Back

```
Alt+← → onBack(active)
     → store.back(active) — index--, returns stack[index]
     → navigate(active, prevLoc.path, { pushHistory: false })
     → setEntries 가 pushHistory=false 로 호출되어 히스토리 안 변경
```

---

## 에러 / 엣지

- **마지막 탭 닫기**: closeTab 가 no-op (최소 1개 유지). UI X 버튼 disabled 표시.
- **back 도중 새 탭 열림**: activeTab 변경. 기존 탭의 history 영향 X.
- **Favorite 클릭 시 host disconnected**: toast "Connect to <alias> first". 자동 connect 시도 X (사용자 명시 클릭 요구).
- **Bookmark navigate 실패** (path 없음): 기존 navigate 의 toast 처리 (MVP-5 에서 추가됨).
- **history 스택 무한 증가**: 한 탭당 cap N=100 (오래된 것 drop). 메모리 안전.

---

## 테스트

### Backend

- `services::bookmarks` 단위: roundtrip / overwrite (id 기반) / remove non-existent no-op
- `services::host_favorites` 단위: 동일 패턴
- `tests/mvp6_bookmarks_smoke.rs`: 라이프사이클
- `tests/mvp6_host_favorites_smoke.rs`: 동일

### Frontend

- `stores/panes.test.ts`: openTab/closeTab/selectTab + history push/back/forward + setEntries pushHistory=false 동작 + last-tab-not-closed 보장
- `stores/bookmarks.test.ts`: list bootstrap + add/remove
- `stores/hostFavorites.test.ts`: 동일

---

## 후속

- 탭 점프 (Ctrl+1..9)
- 탭 reorder (drag)
- 탭 영속성 (settings.toml)
- 북마크 폴더 (계층)
- 북마크 import/export
