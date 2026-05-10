# MVP-6 탭 + 북마크 + 히스토리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 패널당 다중 탭 + 탭별 back/forward 히스토리 + 북마크 (any) + 호스트별 즐겨찾기.

**Architecture:** TabState 가 기존 PaneState 의 위치/표시 옵션 캡슐화. PaneState 는 tabs[] + activeTabIndex 만. 모든 store 액션은 `(paneId, ...)` 시그니처 유지 — 내부에서 active tab 으로 dispatch. 북마크/즐겨찾기는 SavedHostsStore 패턴 (RwLock + JSON file at config_dir).

**Tech Stack:** Zustand store refactor + React, Rust services/commands (uuid v7, serde_json, tokio fs).

**Spec:** `docs/specs/2026-05-10-mvp6-tabs-bookmarks-history-design.md`

---

## File Structure

### Phase A — 탭

| File | Change |
|---|---|
| `src/stores/panes.ts` | Modify (PaneState→TabState 분리, openTab/closeTab/selectTab actions, history field placeholder) |
| `src/stores/panes.test.ts` | Modify (탭 관리 테스트 + 기존 테스트 active-tab 통과 확인) |
| `src/components/pane/TabBar.tsx` | Create |
| `src/components/pane/Pane.tsx` | Modify (TabBar 삽입, active tab accessor) |
| `src/hooks/useGlobalShortcuts.ts` | Modify (Ctrl+T/W/Tab + sort 단축키 Shift 추가) |
| `src/App.tsx` | Modify (sortEntries 이전엔 이미 제거, navigate 시그니처 미변경 — Phase B 에서) |

### Phase B — 히스토리

| File | Change |
|---|---|
| `src/stores/panes.ts` | Modify (history field + back/forward actions + setEntries pushHistory option) |
| `src/stores/panes.test.ts` | Modify (history 테스트 추가) |
| `src/components/pane/PathBar.tsx` | Modify (back/forward 버튼) |
| `src/components/pane/Pane.tsx` | Modify (back/forward 콜백 PathBar 전달) |
| `src/hooks/useGlobalShortcuts.ts` | Modify (Alt+←/→ 추가) |
| `src/App.tsx` | Modify (navigate pushHistory option, onBack/onForward) |

### Phase C — 북마크 + 호스트 즐겨찾기

| File | Change |
|---|---|
| `src-tauri/src/services/bookmarks.rs` | Create (Bookmark + BookmarksStore) |
| `src-tauri/src/services/host_favorites.rs` | Create (HostFavorite + HostFavoritesStore) |
| `src-tauri/src/services/mod.rs` | Modify (`pub mod bookmarks;` + `pub mod host_favorites;`) |
| `src-tauri/src/commands/bookmarks.rs` | Create (3 IPC) |
| `src-tauri/src/commands/host_favorites.rs` | Create (3 IPC) |
| `src-tauri/src/commands/mod.rs` | Modify (mod 선언) |
| `src-tauri/src/lib.rs` | Modify (6 commands 등록 + 2 stores manage) |
| `src-tauri/tests/mvp6_bookmarks_smoke.rs` | Create |
| `src-tauri/tests/mvp6_host_favorites_smoke.rs` | Create |
| `src/stores/bookmarks.ts` | Create |
| `src/stores/hostFavorites.ts` | Create |
| `src/components/Sidebar.tsx` | Modify (2 새 섹션) |
| `src/App.tsx` | Modify (bootstrap + onBookmarkActivate + onFavoriteActivate) |

### Phase D — 마무리

| File | Change |
|---|---|
| `ROADMAP.md` | Modify (MVP-6 [x]) |

---

## Phase A — 탭

### Task 1: PaneState/TabState 분리 + tab 관리 actions

**Files:**
- Modify: `src/stores/panes.ts`
- Modify: `src/stores/panes.test.ts`

이 task 가 가장 큰 리팩터. 기존 모든 액션 (setEntries/moveCursor/setCursor/toggleSelected/clearSelection/setSort/toggleSortKey/toggleShowHidden/setFilter/setFilterFocused) 의 외부 시그니처는 그대로 유지. 내부에서 `activeTabIndex` 의 탭으로 dispatch.

- [ ] **Step 1: panes.ts 전체 교체**

```ts
import { create } from "zustand";
import type { Entry, Location } from "@/types/bindings";

export type PaneId = "left" | "right";
export type SortKey = "name" | "size" | "mtime" | "kind" | "ext";
export type SortOrder = "asc" | "desc";

export interface TabState {
  id: string;
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
  history: { stack: Location[]; index: number };
}

export interface PaneState {
  tabs: TabState[];
  activeTabIndex: number;
}

interface PanesState {
  panes: Record<PaneId, PaneState>;
  activePane: PaneId;
  // tab management
  openTab: (id: PaneId, location?: Location) => void;
  closeTab: (id: PaneId, index: number) => void;
  selectTab: (id: PaneId, index: number) => void;
  // existing — 활성 탭에 dispatch
  setEntries: (id: PaneId, location: Location, entries: Entry[]) => void;
  setActivePane: (id: PaneId) => void;
  moveCursor: (id: PaneId, delta: number) => void;
  setCursor: (id: PaneId, index: number) => void;
  toggleSelected: (id: PaneId, name: string) => void;
  clearSelection: (id: PaneId) => void;
  setSort: (id: PaneId, key: SortKey, order: SortOrder) => void;
  toggleSortKey: (id: PaneId, key: SortKey) => void;
  toggleShowHidden: (id: PaneId) => void;
  setFilter: (id: PaneId, filter: string) => void;
  setFilterFocused: (id: PaneId, focused: boolean) => void;
}

const home = (): Location => ({
  source: { kind: "local" },
  path: "/",
});

let _idSeq = 0;
function newTabId(): string {
  // 단순 sequential — uuid 부담 X. test 결정성도 좋음.
  _idSeq += 1;
  return `t${_idSeq}`;
}

const initialTab = (location: Location = home()): TabState => ({
  id: newTabId(),
  location,
  entries: [],
  cursorIndex: -1,
  selected: new Set(),
  loadedAt: 0,
  sortKey: "name",
  sortOrder: "asc",
  showHidden: false,
  filter: "",
  filterFocused: false,
  history: { stack: [location], index: 0 },
});

const initialPane = (): PaneState => ({
  tabs: [initialTab()],
  activeTabIndex: 0,
});

/** active tab 반환 — 외부 helper. */
export function activeTab(state: PanesState, id: PaneId): TabState {
  const p = state.panes[id];
  return p.tabs[p.activeTabIndex] ?? p.tabs[0]!;
}

/** 액션 안에서 active tab 만 변경하는 헬퍼. tabs 배열 새로 만들고 active 만 교체. */
function withActiveTab(p: PaneState, fn: (t: TabState) => TabState): PaneState {
  const i = p.activeTabIndex;
  const cur = p.tabs[i];
  if (!cur) return p;
  const next = fn(cur);
  if (next === cur) return p;
  const tabs = p.tabs.slice();
  tabs[i] = next;
  return { ...p, tabs };
}

export const usePanes = create<PanesState>((set) => ({
  panes: {
    left: initialPane(),
    right: initialPane(),
  },
  activePane: "left",
  openTab: (id, location) =>
    set((s) => {
      const p = s.panes[id];
      const cur = p.tabs[p.activeTabIndex] ?? p.tabs[0]!;
      const loc = location ?? cur.location;
      const nt = initialTab(loc);
      const tabs = [...p.tabs, nt];
      return {
        panes: { ...s.panes, [id]: { tabs, activeTabIndex: tabs.length - 1 } },
      };
    }),
  closeTab: (id, index) =>
    set((s) => {
      const p = s.panes[id];
      if (p.tabs.length <= 1) return s; // 최소 1개 유지
      const tabs = p.tabs.slice();
      tabs.splice(index, 1);
      let next = p.activeTabIndex;
      if (index === p.activeTabIndex) {
        next = Math.max(0, index - 1);
      } else if (index < p.activeTabIndex) {
        next = p.activeTabIndex - 1;
      }
      return { panes: { ...s.panes, [id]: { tabs, activeTabIndex: next } } };
    }),
  selectTab: (id, index) =>
    set((s) => {
      const p = s.panes[id];
      if (index < 0 || index >= p.tabs.length) return s;
      return { panes: { ...s.panes, [id]: { ...p, activeTabIndex: index } } };
    }),
  setEntries: (id, location, entries) =>
    set((s) => {
      const p = s.panes[id];
      const cur = p.tabs[p.activeTabIndex];
      if (!cur) return s;
      const navigated = cur.location.path !== location.path;
      // history push: pushHistory 옵션은 Phase B Task 6 에서 추가. 현재는 항상 push.
      let history = cur.history;
      if (navigated) {
        const stack = history.stack.slice(0, history.index + 1);
        stack.push(location);
        history = { stack, index: stack.length - 1 };
      }
      const nextTab: TabState = {
        ...cur,
        location,
        entries,
        cursorIndex: entries.length > 0 ? 0 : -1,
        selected: new Set(),
        loadedAt: Date.now(),
        filter: navigated ? "" : cur.filter,
        filterFocused: navigated ? false : cur.filterFocused,
        history,
      };
      return { panes: { ...s.panes, [id]: withActiveTab(p, () => nextTab) } };
    }),
  setActivePane: (id) => set({ activePane: id }),
  moveCursor: (id, delta) =>
    set((s) => {
      const p = s.panes[id];
      const cur = p.tabs[p.activeTabIndex];
      if (!cur) return s;
      const visible = computeDisplayed(cur);
      const next = Math.max(0, Math.min(visible.length - 1, cur.cursorIndex + delta));
      return { panes: { ...s.panes, [id]: withActiveTab(p, (t) => ({ ...t, cursorIndex: next })) } };
    }),
  setCursor: (id, index) =>
    set((s) => ({
      panes: { ...s.panes, [id]: withActiveTab(s.panes[id], (t) => ({ ...t, cursorIndex: index })) },
    })),
  toggleSelected: (id, name) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => {
          const sel = new Set(t.selected);
          if (sel.has(name)) sel.delete(name);
          else sel.add(name);
          return { ...t, selected: sel };
        }),
      },
    })),
  clearSelection: (id) =>
    set((s) => ({
      panes: { ...s.panes, [id]: withActiveTab(s.panes[id], (t) => ({ ...t, selected: new Set() })) },
    })),
  setSort: (id, key, order) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({ ...t, sortKey: key, sortOrder: order, cursorIndex: 0 })),
      },
    })),
  toggleSortKey: (id, key) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => {
          if (t.sortKey === key) {
            return { ...t, sortOrder: t.sortOrder === "asc" ? "desc" : "asc" };
          }
          return { ...t, sortKey: key, sortOrder: "asc", cursorIndex: 0 };
        }),
      },
    })),
  toggleShowHidden: (id) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({ ...t, showHidden: !t.showHidden, cursorIndex: 0 })),
      },
    })),
  setFilter: (id, filter) =>
    set((s) => ({
      panes: { ...s.panes, [id]: withActiveTab(s.panes[id], (t) => ({ ...t, filter, cursorIndex: 0 })) },
    })),
  setFilterFocused: (id, focused) =>
    set((s) => ({
      panes: { ...s.panes, [id]: withActiveTab(s.panes[id], (t) => ({ ...t, filterFocused: focused })) },
    })),
}));

/** 표시 entries — 활성 탭 기준. raw → filter → hidden → sort. */
export function selectDisplayedEntries(id: PaneId, state: PanesState): Entry[] {
  const t = activeTab(state, id);
  return computeDisplayed(t);
}

function computeDisplayed(t: TabState): Entry[] {
  let arr = t.entries;
  if (t.filter.length > 0) {
    const q = t.filter.toLowerCase();
    arr = arr.filter((e) => e.name.toLowerCase().includes(q));
  }
  if (!t.showHidden) {
    arr = arr.filter((e) => !e.hidden);
  }
  return sortEntries(arr, t.sortKey, t.sortOrder);
}

function sortEntries(entries: Entry[], key: SortKey, order: SortOrder): Entry[] {
  const dirsFirst = (a: Entry, b: Entry) => {
    if (a.kind !== b.kind) {
      if (a.kind === "dir") return -1;
      if (b.kind === "dir") return 1;
    }
    return 0;
  };
  const cmpName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);
  const cmpExt = (a: Entry, b: Entry) => {
    const ax = a.name.lastIndexOf(".");
    const bx = b.name.lastIndexOf(".");
    const ae = ax >= 0 ? a.name.slice(ax + 1) : "";
    const be = bx >= 0 ? b.name.slice(bx + 1) : "";
    return ae.localeCompare(be) || cmpName(a, b);
  };
  const cmpKey = (a: Entry, b: Entry): number => {
    switch (key) {
      case "name":
        return cmpName(a, b);
      case "size":
        return (a.size ?? 0) - (b.size ?? 0) || cmpName(a, b);
      case "mtime":
        return (a.modified_ms ?? 0) - (b.modified_ms ?? 0) || cmpName(a, b);
      case "kind":
        return a.kind.localeCompare(b.kind) || cmpName(a, b);
      case "ext":
        return cmpExt(a, b);
    }
  };
  const sorted = [...entries].sort((a, b) => {
    const df = dirsFirst(a, b);
    if (df !== 0) return df;
    const c = cmpKey(a, b);
    return order === "asc" ? c : -c;
  });
  return sorted;
}
```

- [ ] **Step 2: panes.test.ts 갱신 — 기존 + 신규 테스트**

`src/stores/panes.test.ts` 전체 교체:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { usePanes, activeTab, selectDisplayedEntries } from "./panes";
import type { Entry } from "@/types/bindings";

const mk = (name: string, kind: "dir" | "file" = "file", size = 100, mtime = 0, hidden = false): Entry =>
  ({ name, kind, size, modified_ms: mtime, permissions: null, hidden }) as Entry;

const reset = () => {
  // 기본 1 탭 상태로 복원 (left/right 모두)
  usePanes.setState((s) => {
    const fresh = (id: "left" | "right") => ({
      tabs: [
        {
          ...s.panes[id].tabs[0]!,
          entries: [],
          cursorIndex: -1,
          selected: new Set<string>(),
          sortKey: "name" as const,
          sortOrder: "asc" as const,
          showHidden: false,
          filter: "",
          filterFocused: false,
          history: { stack: [s.panes[id].tabs[0]!.location], index: 0 },
        },
      ],
      activeTabIndex: 0,
    });
    return {
      panes: { left: fresh("left"), right: fresh("right") },
      activePane: "left" as const,
    };
  });
};

describe("panes — tab management", () => {
  beforeEach(reset);

  it("openTab clones current location", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/foo" }, []);
    usePanes.getState().openTab("left");
    const p = usePanes.getState().panes.left;
    expect(p.tabs.length).toBe(2);
    expect(p.activeTabIndex).toBe(1);
    expect(p.tabs[1]!.location.path).toBe("/foo");
  });

  it("openTab with explicit location", () => {
    usePanes.getState().openTab("left", { source: { kind: "local" }, path: "/bar" });
    const p = usePanes.getState().panes.left;
    expect(p.tabs[1]!.location.path).toBe("/bar");
    expect(p.activeTabIndex).toBe(1);
  });

  it("closeTab last tab is no-op", () => {
    usePanes.getState().closeTab("left", 0);
    expect(usePanes.getState().panes.left.tabs.length).toBe(1);
  });

  it("closeTab non-active shifts active down", () => {
    usePanes.getState().openTab("left", { source: { kind: "local" }, path: "/a" });
    usePanes.getState().openTab("left", { source: { kind: "local" }, path: "/b" });
    // tabs: [home, /a, /b], active=2
    usePanes.getState().closeTab("left", 0);
    const p = usePanes.getState().panes.left;
    expect(p.tabs.length).toBe(2);
    expect(p.activeTabIndex).toBe(1);
  });

  it("closeTab active selects left", () => {
    usePanes.getState().openTab("left", { source: { kind: "local" }, path: "/a" });
    usePanes.getState().openTab("left", { source: { kind: "local" }, path: "/b" });
    // active=2 (/b). 닫으면 activeTabIndex=1 (/a)
    usePanes.getState().closeTab("left", 2);
    const p = usePanes.getState().panes.left;
    expect(p.tabs.length).toBe(2);
    expect(p.activeTabIndex).toBe(1);
    expect(p.tabs[1]!.location.path).toBe("/a");
  });

  it("selectTab changes activeTabIndex", () => {
    usePanes.getState().openTab("left", { source: { kind: "local" }, path: "/a" });
    usePanes.getState().selectTab("left", 0);
    expect(usePanes.getState().panes.left.activeTabIndex).toBe(0);
  });
});

describe("panes — sort/hidden via active tab", () => {
  beforeEach(reset);

  it("sort by name asc — dirs first", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [
      mk("zeta", "file"),
      mk("alpha", "dir"),
      mk("beta", "file"),
      mk("gamma", "dir"),
    ]);
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["alpha", "gamma", "beta", "zeta"]);
  });

  it("sort by size desc", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [
      mk("a", "file", 100),
      mk("b", "file", 300),
      mk("c", "file", 200),
    ]);
    usePanes.getState().setSort("left", "size", "desc");
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["b", "c", "a"]);
  });

  it("toggleSortKey same key flips order", () => {
    usePanes.getState().setSort("left", "name", "asc");
    usePanes.getState().toggleSortKey("left", "name");
    expect(activeTab(usePanes.getState(), "left").sortOrder).toBe("desc");
  });

  it("toggleShowHidden shows dotfiles", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [
      mk(".bashrc", "file", 100, 0, true),
      mk("README.md", "file"),
    ]);
    usePanes.getState().toggleShowHidden("left");
    expect(selectDisplayedEntries("left", usePanes.getState()).map((e) => e.name)).toEqual([
      ".bashrc",
      "README.md",
    ]);
  });
});

describe("panes — cursor & selection (legacy)", () => {
  beforeEach(reset);

  it("setEntries resets cursor", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mk("a"), mk("b")]);
    expect(activeTab(usePanes.getState(), "left").cursorIndex).toBe(0);
  });

  it("moveCursor clamps", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mk("a"), mk("b")]);
    usePanes.getState().moveCursor("left", 5);
    expect(activeTab(usePanes.getState(), "left").cursorIndex).toBe(1);
    usePanes.getState().moveCursor("left", -10);
    expect(activeTab(usePanes.getState(), "left").cursorIndex).toBe(0);
  });

  it("toggleSelected adds and removes", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mk("x")]);
    usePanes.getState().toggleSelected("left", "x");
    expect(activeTab(usePanes.getState(), "left").selected.has("x")).toBe(true);
    usePanes.getState().toggleSelected("left", "x");
    expect(activeTab(usePanes.getState(), "left").selected.has("x")).toBe(false);
  });
});
```

- [ ] **Step 3: 테스트 + tsc + lint**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
pnpm test --run src/stores/panes.test.ts 2>&1 | tail -10
pnpm tsc --noEmit 2>&1 | tail -10
pnpm lint 2>&1 | tail -3
```

Expected: panes.test.ts pass. tsc 에러 — Pane.tsx 와 useGlobalShortcuts 가 `pane.location` / `pane.entries` 등 직접 접근 (Task 2/4 에서 수정). lint 가능한 한 clean.

이 task 단독으로 완전히 빌드 안 되어도 OK — Phase A 가 끝나면 다 fix.

- [ ] **Step 4: Commit**

```bash
git add src/stores/panes.ts src/stores/panes.test.ts
git commit -m "fe/store: PaneState/TabState 분리 + openTab/closeTab/selectTab

- TabState 가 location/entries/cursor/selected/sortKey/sortOrder/showHidden/
  filter/filterFocused/loadedAt/history 보유. PaneState 는 tabs[] +
  activeTabIndex 만.
- 모든 기존 액션 (setEntries 등) 시그니처 유지, 내부 active tab dispatch.
- activeTab(state, id) helper + withActiveTab 내부 헬퍼.
- selectDisplayedEntries 가 active tab 의 raw → filter → hidden → sort.
- history 필드 placeholder (back/forward 액션은 Task 5).
- 테스트: tab management 5 + sort/hidden 4 + cursor/selection 3 (총 12).
- 후속 Pane.tsx / useGlobalShortcuts 는 다음 task 에서 active tab accessor 사용."
```

---

### Task 2: TabBar 컴포넌트

**Files:**
- Create: `src/components/pane/TabBar.tsx`

- [ ] **Step 1: TabBar.tsx 작성**

```tsx
import { X, Plus } from "lucide-react";
import { usePanes, type PaneId } from "@/stores/panes";
import clsx from "clsx";

/**
 * 패널 상단 탭 바. 탭 1개일 때는 렌더 X.
 *
 * - 활성 탭: left border accent
 * - 비활성 탭: hover 시 X 노출, 클릭 시 closeTab
 * - 가장 우측 + 버튼: openTab (location 미지정 → 활성 탭 location 복제)
 */
export function TabBar({ id }: { id: PaneId }) {
  const tabs = usePanes((s) => s.panes[id].tabs);
  const activeIndex = usePanes((s) => s.panes[id].activeTabIndex);
  const openTab = usePanes((s) => s.openTab);
  const closeTab = usePanes((s) => s.closeTab);
  const selectTab = usePanes((s) => s.selectTab);

  if (tabs.length <= 1) return null;

  return (
    <div className="flex h-7 shrink-0 items-stretch border-b border-border bg-subtle text-meta">
      {tabs.map((t, i) => {
        const active = i === activeIndex;
        const label = labelOf(t.location.path);
        return (
          <div
            key={t.id}
            onClick={() => selectTab(id, i)}
            title={t.location.path}
            className={clsx(
              "group flex cursor-default items-center gap-1 border-l-2 px-2 hover:bg-border",
              active ? "border-l-accent bg-base text-fg" : "border-l-transparent text-fg-muted",
            )}
          >
            <span className="truncate max-w-[10rem]">{label}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(id, i);
              }}
              className={clsx(
                "rounded p-0.5 opacity-0 hover:bg-border group-hover:opacity-100",
                tabs.length <= 1 && "pointer-events-none opacity-30",
              )}
              aria-label="Close tab"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => openTab(id)}
        className="flex items-center px-2 text-fg-muted hover:bg-border hover:text-fg"
        aria-label="New tab"
        title="New tab"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

function labelOf(path: string): string {
  if (path === "/" || path === "") return "/";
  const segs = path.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? "/";
}
```

- [ ] **Step 2: tsc**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet && pnpm tsc --noEmit 2>&1 | tail -5
```

Expected: TabBar 자체는 clean. Pane.tsx 의 기존 에러 잔존 (Task 4 해결).

- [ ] **Step 3: Commit**

```bash
git add src/components/pane/TabBar.tsx
git commit -m "fe/ui: TabBar — 탭 1개 이상일 때만 렌더, openTab/closeTab/selectTab"
```

---

### Task 3: Pane 통합 + active tab accessor

**Files:**
- Modify: `src/components/pane/Pane.tsx`

- [ ] **Step 1: Pane.tsx 전체 교체**

```tsx
import { TabBar } from "./TabBar";
import { PathBar } from "./PathBar";
import { PaneFilterBar } from "./PaneFilterBar";
import { EntryList } from "./EntryList";
import { usePanes, activeTab, selectDisplayedEntries, type PaneId } from "@/stores/panes";
import type { Entry } from "@/types/bindings";
import clsx from "clsx";

interface PaneProps {
  id: PaneId;
  onNavigate: (id: PaneId, path: string) => void;
  onActivate: (id: PaneId, entry: Entry) => void;
  onRefresh: (id: PaneId) => void;
}

export function Pane({ id, onNavigate, onActivate, onRefresh }: PaneProps) {
  const isActive = usePanes((s) => s.activePane === id);
  const setActivePane = usePanes((s) => s.setActivePane);
  const setCursor = usePanes((s) => s.setCursor);
  const toggleSelected = usePanes((s) => s.toggleSelected);
  const toggleSortKey = usePanes((s) => s.toggleSortKey);
  const tab = usePanes((s) => activeTab(s, id));
  const displayed = usePanes((s) => selectDisplayedEntries(id, s));

  return (
    <div
      className={clsx(
        "flex flex-1 flex-col min-h-0 border border-border",
        isActive && "border-accent",
      )}
      onMouseDown={() => setActivePane(id)}
    >
      <TabBar id={id} />
      <PathBar
        location={tab.location}
        onUp={() => {
          const path = tab.location.path;
          if (path === "/" || path.length === 0) return;
          const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
          onNavigate(id, parent);
        }}
        onSegmentClick={(p) => onNavigate(id, p)}
        onRefresh={() => onRefresh(id)}
      />
      <PaneFilterBar id={id} />
      <EntryList
        entries={displayed}
        cursorIndex={tab.cursorIndex}
        selected={tab.selected}
        sortKey={tab.sortKey}
        sortOrder={tab.sortOrder}
        onCursorMove={(i) => setCursor(id, i)}
        onActivate={(entry) => onActivate(id, entry)}
        onToggleSelect={(name) => toggleSelected(id, name)}
        onSortClick={(k) => toggleSortKey(id, k)}
      />
    </div>
  );
}
```

- [ ] **Step 2: 다른 파일 영향 확인**

`grep -n "pane.location\|pane.entries\|pane.cursorIndex" src/` 로 다른 사용처 확인.
- App.tsx 의 `usePanes.getState().panes[id]` 직접 접근 부분 → `activeTab(usePanes.getState(), id)` 로 변경 필요
- useKeyboardNav 등 비슷한 패턴 확인

검색 + 수정. 예시 (App.tsx):

```ts
// 기존:
const pane = usePanes.getState().panes[id];
const sep = pane.location.path.endsWith("/") ? "" : "/";
navigate(id, pane.location.path + sep + entry.name);

// 변경:
import { activeTab } from "@/stores/panes";
const tab = activeTab(usePanes.getState(), id);
const sep = tab.location.path.endsWith("/") ? "" : "/";
navigate(id, tab.location.path + sep + entry.name);
```

같은 패턴: onRefresh, onKeyboardActivate, onKeyboardUp, refreshAffected 안 location 비교, onConnected 안 setEntries 호출, onPickHit 안 cursor.

useKeyboardNav.ts 도 `pane.entries[cursorIndex]` 접근하면 변경 필요. `grep` 결과 보고 일괄 수정.

- [ ] **Step 3: tsc + lint + test**

```bash
pnpm tsc --noEmit 2>&1 | tail -10
pnpm lint 2>&1 | tail -3
pnpm test --run 2>&1 | tail -5
```

Expected: clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/pane/Pane.tsx src/App.tsx src/hooks/useKeyboardNav.ts
git commit -m "fe/ui: Pane uses activeTab accessor + TabBar 삽입

- Pane: activeTab(state, id) 로 tab 가져와서 PathBar/PaneFilterBar/EntryList 에
  전달. TabBar 가 가장 위 (탭 1개 이상일 때만 렌더).
- App/useKeyboardNav: pane.location/entries 직접 접근 부분 모두
  activeTab(...) 통과로 변경."
```

---

### Task 4: useGlobalShortcuts — Ctrl+T/W/Tab + sort 단축키 이전

**Files:**
- Modify: `src/hooks/useGlobalShortcuts.ts`

- [ ] **Step 1: 단축키 추가 + 기존 sort 변경**

`src/hooks/useGlobalShortcuts.ts` 의 switch 블록 확장. 변경 사항:

A. 새 case "t" / "w": 활성 패널 openTab / closeTab
B. case "Tab" (modifier 분기): Ctrl+Tab = next, Ctrl+Shift+Tab = prev
C. case "1".."5" 의 sort 매핑 — `e.shiftKey` 일 때만 동작 (기존 단축키 보존성 위해 일단 Shift 가 있을 때만)

전체 useGlobalShortcuts.ts 갱신 — case 추가, case "1".."5" 변경:

```ts
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUI } from "@/stores/ui";
import { usePanes, type SortKey } from "@/stores/panes";
import { useSearch } from "@/stores/search";

/**
 * 글로벌 단축키.
 * Ctrl+B 사이드바, Ctrl+Q 종료, Ctrl+H hidden, Ctrl+R/F5 새로고침,
 * Ctrl+Shift+1..5 sort, Ctrl+F 필터, Ctrl+Shift+F 글로벌 검색,
 * Ctrl+T 새 탭, Ctrl+W 탭 닫기, Ctrl+Tab 다음 탭, Ctrl+Shift+Tab 이전 탭.
 */
export function useGlobalShortcuts(opts: { onRefresh: (id: "left" | "right") => void }) {
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const { onRefresh } = opts;

  useEffect(() => {
    const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isInput = tag === "input" || tag === "textarea";
      const isMod = isMac ? e.metaKey : e.ctrlKey;

      if (!isMod) {
        if (e.key === "F5" && !isInput) {
          e.preventDefault();
          onRefresh(usePanes.getState().activePane);
        }
        return;
      }

      // Tab 처리 — case 와 별개
      if (e.key === "Tab") {
        if (isInput) return;
        e.preventDefault();
        const id = usePanes.getState().activePane;
        const p = usePanes.getState().panes[id];
        if (e.shiftKey) {
          const prev = (p.activeTabIndex - 1 + p.tabs.length) % p.tabs.length;
          usePanes.getState().selectTab(id, prev);
        } else {
          const next = (p.activeTabIndex + 1) % p.tabs.length;
          usePanes.getState().selectTab(id, next);
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case "b":
          e.preventDefault();
          toggleSidebar();
          break;
        case "q":
          if (!isMac) {
            e.preventDefault();
            void getCurrentWindow().close();
          }
          break;
        case "h":
          if (!isInput) {
            e.preventDefault();
            usePanes.getState().toggleShowHidden(usePanes.getState().activePane);
          }
          break;
        case "r":
          if (!isInput) {
            e.preventDefault();
            onRefresh(usePanes.getState().activePane);
          }
          break;
        case "t":
          if (!isInput) {
            e.preventDefault();
            usePanes.getState().openTab(usePanes.getState().activePane);
          }
          break;
        case "w":
          if (!isInput) {
            e.preventDefault();
            const id = usePanes.getState().activePane;
            const p = usePanes.getState().panes[id];
            usePanes.getState().closeTab(id, p.activeTabIndex);
          }
          break;
        case "f":
          if (isInput) break;
          e.preventDefault();
          if (e.shiftKey) {
            const active = usePanes.getState().activePane;
            const tab = usePanes.getState().panes[active].tabs[
              usePanes.getState().panes[active].activeTabIndex
            ]!;
            useSearch.getState().open(active, tab.location);
          } else {
            usePanes.getState().setFilterFocused(usePanes.getState().activePane, true);
          }
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5": {
          if (isInput || !e.shiftKey) break;
          e.preventDefault();
          const map: Record<string, SortKey> = {
            "1": "name",
            "2": "size",
            "3": "mtime",
            "4": "kind",
            "5": "ext",
          };
          const key = map[e.key];
          if (key) usePanes.getState().toggleSortKey(usePanes.getState().activePane, key);
          break;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebar, onRefresh]);
}
```

- [ ] **Step 2: tsc + lint + test**

```bash
pnpm tsc --noEmit 2>&1 | tail -3
pnpm lint 2>&1 | tail -3
pnpm test --run 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useGlobalShortcuts.ts
git commit -m "fe/hook: Ctrl+T/W/Tab/Shift+Tab + sort 단축키 Shift+1..5 로 이전

- Ctrl+T: 활성 패널 새 탭 (현재 location 복제)
- Ctrl+W: 활성 탭 닫기 (1개 남으면 no-op via store)
- Ctrl+Tab / Ctrl+Shift+Tab: 다음/이전 탭 (modulo wrap)
- Ctrl+Shift+1..5: sort key (기존 Ctrl+1..5 → Shift 추가; Ctrl+1..9 는
  후속 탭 점프용 예약)"
```

---

## Phase B — 히스토리

### Task 5: history actions + setEntries pushHistory option

**Files:**
- Modify: `src/stores/panes.ts`
- Modify: `src/stores/panes.test.ts`

이 task 는 setEntries 가 이미 history 를 push 하도록 작성됨 (Task 1). 추가:
- `pushHistory` 옵션 추가
- `back`/`forward` actions 추가

- [ ] **Step 1: panes.ts setEntries 시그니처 변경 + back/forward 추가**

panes.ts 의 PanesState interface 에 추가:

```ts
interface PanesState {
  // ... 기존
  setEntries: (id: PaneId, location: Location, entries: Entry[], opts?: { pushHistory?: boolean }) => void;
  back: (id: PaneId) => Location | null;
  forward: (id: PaneId) => Location | null;
}
```

setEntries 구현 변경 — opts 받기:

```ts
setEntries: (id, location, entries, opts) =>
  set((s) => {
    const p = s.panes[id];
    const cur = p.tabs[p.activeTabIndex];
    if (!cur) return s;
    const navigated = cur.location.path !== location.path;
    const pushHistory = opts?.pushHistory ?? true;
    let history = cur.history;
    if (navigated && pushHistory) {
      const stack = history.stack.slice(0, history.index + 1);
      stack.push(location);
      // cap 100 — 오래된 것 drop
      const trimmed = stack.length > 100 ? stack.slice(stack.length - 100) : stack;
      history = { stack: trimmed, index: trimmed.length - 1 };
    }
    const nextTab: TabState = {
      ...cur,
      location,
      entries,
      cursorIndex: entries.length > 0 ? 0 : -1,
      selected: new Set(),
      loadedAt: Date.now(),
      filter: navigated ? "" : cur.filter,
      filterFocused: navigated ? false : cur.filterFocused,
      history,
    };
    return { panes: { ...s.panes, [id]: withActiveTab(p, () => nextTab) } };
  }),
```

`back` / `forward` 추가 (액션은 store 레벨, but 반환값 있어야 — set callback 안에서 반환 못 함. get 으로 반환하는 패턴):

```ts
// usePanes 정의 시 set, get 둘 다 받기
export const usePanes = create<PanesState>((set, get) => ({
  // ...
  back: (id) => {
    const p = get().panes[id];
    const cur = p.tabs[p.activeTabIndex];
    if (!cur || cur.history.index <= 0) return null;
    const newIndex = cur.history.index - 1;
    const loc = cur.history.stack[newIndex]!;
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          history: { ...t.history, index: newIndex },
        })),
      },
    }));
    return loc;
  },
  forward: (id) => {
    const p = get().panes[id];
    const cur = p.tabs[p.activeTabIndex];
    if (!cur || cur.history.index >= cur.history.stack.length - 1) return null;
    const newIndex = cur.history.index + 1;
    const loc = cur.history.stack[newIndex]!;
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          history: { ...t.history, index: newIndex },
        })),
      },
    }));
    return loc;
  },
}));
```

- [ ] **Step 2: panes.test.ts 에 history 테스트 추가**

`describe("panes — history")` block 추가:

```ts
describe("panes — history", () => {
  beforeEach(reset);

  it("setEntries pushes history on path change", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/b" }, []);
    const t = activeTab(usePanes.getState(), "left");
    expect(t.history.stack.map((l) => l.path)).toEqual(["/", "/a", "/b"]);
    expect(t.history.index).toBe(2);
  });

  it("setEntries same path does not push", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    const t = activeTab(usePanes.getState(), "left");
    expect(t.history.stack.length).toBe(2); // ["/", "/a"] — 같은 path 두 번 = 한 번만
  });

  it("setEntries pushHistory=false skips", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/b" }, [], { pushHistory: false });
    const t = activeTab(usePanes.getState(), "left");
    expect(t.history.stack.map((l) => l.path)).toEqual(["/", "/a"]);
  });

  it("back returns previous location", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/b" }, []);
    const prev = usePanes.getState().back("left");
    expect(prev?.path).toBe("/a");
    expect(activeTab(usePanes.getState(), "left").history.index).toBe(1);
  });

  it("back at index 0 returns null", () => {
    expect(usePanes.getState().back("left")).toBeNull();
  });

  it("forward after back", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/b" }, []);
    usePanes.getState().back("left");
    const next = usePanes.getState().forward("left");
    expect(next?.path).toBe("/b");
  });

  it("navigate after back truncates forward stack", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/b" }, []);
    usePanes.getState().back("left");
    // 지금 stack=["/", "/a", "/b"], index=1 (= /a)
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/c" }, []);
    const t = activeTab(usePanes.getState(), "left");
    expect(t.history.stack.map((l) => l.path)).toEqual(["/", "/a", "/c"]);
    expect(t.history.index).toBe(2);
  });
});
```

- [ ] **Step 3: 테스트 + tsc**

```bash
pnpm test --run src/stores/panes.test.ts 2>&1 | tail -10
pnpm tsc --noEmit 2>&1 | tail -3
```

Expected: 12 + 7 = 19 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/stores/panes.ts src/stores/panes.test.ts
git commit -m "fe/store: tab history — back/forward + setEntries pushHistory opt

- TabState.history { stack: Location[]; index: number }, cap 100
- setEntries(id, loc, entries, { pushHistory?: boolean }) — default true.
  navigated 시 stack.splice(index+1) + push, navigated false 면 push 안 함.
- back(id) / forward(id): index 변경 + 새 location 반환 (없으면 null)
- 7 history 테스트 추가 (push, same-path no push, pushHistory=false skip,
  back/forward, navigate after back truncates)"
```

---

### Task 6: PathBar back/forward 버튼 + Pane onBack/onForward + Alt 단축키 + App navigate pushHistory

**Files:**
- Modify: `src/components/pane/PathBar.tsx`
- Modify: `src/components/pane/Pane.tsx`
- Modify: `src/hooks/useGlobalShortcuts.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: PathBar back/forward 버튼 추가**

`src/components/pane/PathBar.tsx` 수정 — 기존 props 에 추가:

```tsx
interface PathBarProps {
  location: Location;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onSegmentClick: (path: string) => void;
  onRefresh: () => void;
}
```

JSX 의 PathBar 렌더 안에 `↑` 옆에 ← / → 버튼 추가:

```tsx
import { ArrowLeft, ArrowRight, ArrowUp, RotateCw } from "lucide-react";
// ... 기존
<button
  type="button"
  onClick={onBack}
  disabled={!canBack}
  className="rounded p-1 text-fg-muted hover:bg-border hover:text-fg disabled:opacity-30"
  aria-label="Back"
  title="Back (Alt+←)"
>
  <ArrowLeft size={12} />
</button>
<button
  type="button"
  onClick={onForward}
  disabled={!canForward}
  className="rounded p-1 text-fg-muted hover:bg-border hover:text-fg disabled:opacity-30"
  aria-label="Forward"
  title="Forward (Alt+→)"
>
  <ArrowRight size={12} />
</button>
{/* 기존 ↑ + segment + ↻ */}
```

**현재 PathBar.tsx 의 정확한 구조 모르므로**: 파일 전체 읽고 적절히 수정. ArrowLeft/ArrowRight 아이콘 import + 버튼 2개 + props 4개 추가.

- [ ] **Step 2: Pane.tsx PathBar 호출 갱신**

```tsx
import { back as backStore, forward as forwardStore } from somewhere... // 직접 store action 사용
// 또는 inline:

const back = usePanes((s) => s.back);
const forward = usePanes((s) => s.forward);
const canBack = tab.history.index > 0;
const canForward = tab.history.index < tab.history.stack.length - 1;

// PathBar:
<PathBar
  location={tab.location}
  canBack={canBack}
  canForward={canForward}
  onBack={() => {
    const loc = back(id);
    if (loc) onNavigate(id, loc.path); // pushHistory false 는 App 에서 처리 — 별 시그널 필요
    // 단, onNavigate 가 pushHistory 옵션 없음. 대안: 별도 prop onBackNavigate 만들거나
    // App 의 navigate 가 store.back 호출 결과를 받아 setEntries pushHistory=false.
  }}
  ...
/>
```

**문제**: Pane 이 직접 store.back 호출 + IPC navigate 까지 하면 layer 위반. 깔끔한 방법: Pane 이 `onBack(id)` callback 받기. App 이 onBack 안에서 store.back + listDirectory + setEntries(pushHistory=false).

→ Pane.tsx 의 PaneProps 에 `onBack(id) / onForward(id)` 추가:

```tsx
interface PaneProps {
  id: PaneId;
  onNavigate: (id: PaneId, path: string) => void;
  onActivate: (id: PaneId, entry: Entry) => void;
  onRefresh: (id: PaneId) => void;
  onBack: (id: PaneId) => void;
  onForward: (id: PaneId) => void;
}
```

PathBar 호출:

```tsx
<PathBar
  location={tab.location}
  canBack={tab.history.index > 0}
  canForward={tab.history.index < tab.history.stack.length - 1}
  onBack={() => onBack(id)}
  onForward={() => onForward(id)}
  onUp={...}
  onSegmentClick={...}
  onRefresh={() => onRefresh(id)}
/>
```

- [ ] **Step 3: App.tsx navigate pushHistory + onBack/onForward**

`src/App.tsx`:

A. navigate 시그니처 옵션 추가:

```tsx
const navigate = useCallback(
  async (id: PaneId, path: string, opts: { pushHistory?: boolean } = {}) => {
    const tab = activeTab(usePanes.getState(), id);
    const location = { ...tab.location, path };
    try {
      const entries = await listDirectory(location);
      usePanes.getState().setEntries(id, location, entries, { pushHistory: opts.pushHistory ?? true });
      void commands.paneWatchSet(id, location);
    } catch (e) {
      // ... 기존 toast
    }
  },
  [listDirectory, showToast],
);
```

B. onBack / onForward callback:

```tsx
const onBack = useCallback(
  (id: PaneId) => {
    const loc = usePanes.getState().back(id);
    if (loc) void navigate(id, loc.path, { pushHistory: false });
  },
  [navigate],
);

const onForward = useCallback(
  (id: PaneId) => {
    const loc = usePanes.getState().forward(id);
    if (loc) void navigate(id, loc.path, { pushHistory: false });
  },
  [navigate],
);
```

C. JSX 의 Pane 에 prop 추가:

```tsx
<Pane id="left" onNavigate={navigate} onActivate={onActivate} onRefresh={onRefresh}
       onBack={onBack} onForward={onForward} />
<Pane id="right" ... onBack={onBack} onForward={onForward} />
```

- [ ] **Step 4: useGlobalShortcuts Alt+←/→**

handler 안 modifier 분기 전에 Alt 처리 추가 (modifier 없을 때 Alt 만 잡기):

```ts
if (e.altKey && !isMod) {
  if (isInput) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    const loc = usePanes.getState().back(usePanes.getState().activePane);
    // App 의 onBack 과 같은 동작 — 하지만 IPC navigate 는 App 이 함.
    // 단축키만으로 처리하려면 App callback 필요. opts 에 onBack 추가하는 게 깨끗함.
    // 또는: useGlobalShortcuts 가 store.back 만 호출하고, useEffect 가 location 변경 감지해
    // listDirectory 호출 (반응형). — 하지만 layer 침범.
    // 가장 깔끔: opts.onBack(activePane) / opts.onForward(activePane) 추가.
  }
}
```

→ useGlobalShortcuts opts 시그니처 확장:

```ts
export function useGlobalShortcuts(opts: {
  onRefresh: (id: "left" | "right") => void;
  onBack: (id: "left" | "right") => void;
  onForward: (id: "left" | "right") => void;
}) {
  const { onRefresh, onBack, onForward } = opts;
  // ...
}
```

handler 안 (case 들 위쪽, `if (!isMod)` 블록):

```ts
if (e.altKey && !isMod) {
  if (isInput) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    onBack(usePanes.getState().activePane);
    return;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    onForward(usePanes.getState().activePane);
    return;
  }
}
```

useEffect deps 에 `[toggleSidebar, onRefresh, onBack, onForward]`.

App.tsx 호출처:

```tsx
useGlobalShortcuts({ onRefresh, onBack, onForward });
```

- [ ] **Step 5: tsc + lint + test**

```bash
pnpm tsc --noEmit 2>&1 | tail -3
pnpm lint 2>&1 | tail -3
pnpm test --run 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/pane/PathBar.tsx src/components/pane/Pane.tsx src/hooks/useGlobalShortcuts.ts src/App.tsx
git commit -m "fe: history back/forward — PathBar 버튼 + Alt+←/→ + navigate pushHistory

- PathBar: ←/→ 버튼 추가, canBack/canForward props (disabled 표시)
- Pane: onBack/onForward props → PathBar 전달
- App: navigate(id, path, { pushHistory? }) 옵션, onBack/onForward 가
  store.back/forward 후 navigate(pushHistory=false) 호출
- useGlobalShortcuts: opts.onBack/onForward, Alt+←/→ → onBack/onForward(active)"
```

---

## Phase C — 북마크 + 호스트별 즐겨찾기

### Task 7: Backend services/bookmarks.rs + smoke

**Files:**
- Create: `src-tauri/src/services/bookmarks.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Create: `src-tauri/tests/mvp6_bookmarks_smoke.rs`

- [ ] **Step 1: services/mod.rs**

`src-tauri/src/services/mod.rs` 의 alphabetic 위치 (between `bookmarks` between `_` and `connection_events` 또는 적절히):

```rust
pub mod bookmarks;
```

(현재 mod 순서 확인 후 적절한 위치 — alphabetic.)

- [ ] **Step 2: services/bookmarks.rs**

```rust
//! 사용자 북마크 (any location). `<config_dir>/duet/bookmarks.json`.
//!
//! Bookmark { id (uuid v7), name, location: Location }.
//! SavedHostsStore 와 동일 패턴 (RwLock + JSON file).

use crate::services::settings::duet_config_dir;
use crate::types::{DuetError, Location};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct Bookmark {
    pub id: String,
    pub name: String,
    pub location: Location,
}

pub struct BookmarksStore {
    path: PathBuf,
    inner: RwLock<Vec<Bookmark>>,
}

impl BookmarksStore {
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("bookmarks.json");
        Self::load_from(&path).await
    }

    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let bookmarks = if path.exists() {
            let text = tokio::fs::read_to_string(path)
                .await
                .map_err(DuetError::from)?;
            if text.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str::<Vec<Bookmark>>(&text)
                    .map_err(|e| DuetError::Io(format!("bookmarks parse: {e}")))?
            }
        } else {
            Vec::new()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(bookmarks),
        }))
    }

    pub async fn list(&self) -> Vec<Bookmark> {
        self.inner.read().await.clone()
    }

    /// 새 북마크 추가 (uuid v7 자동 발급). 갱신 list 반환.
    pub async fn add(&self, name: String, location: Location) -> Result<Vec<Bookmark>, DuetError> {
        if name.trim().is_empty() {
            return Err(DuetError::Io("bookmark name required".into()));
        }
        let bm = Bookmark {
            id: uuid::Uuid::now_v7().to_string(),
            name,
            location,
        };
        let mut v = self.inner.write().await;
        v.push(bm);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    pub async fn remove(&self, id: &str) -> Result<Vec<Bookmark>, DuetError> {
        let mut v = self.inner.write().await;
        v.retain(|b| b.id != id);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    async fn write_to_disk(&self, items: &[Bookmark]) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = serde_json::to_string_pretty(items)
            .map_err(|e| DuetError::Io(format!("bookmarks serialize: {e}")))?;
        tokio::fs::write(&self.path, text)
            .await
            .map_err(DuetError::from)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SourceId;
    use tempfile::tempdir;

    fn loc(p: &str) -> Location {
        Location { source: SourceId::Local, path: PathBuf::from(p) }
    }

    #[tokio::test]
    async fn empty_then_add_then_reload() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("b.json");
        let s = BookmarksStore::load_from(&path).await.unwrap();
        assert!(s.list().await.is_empty());
        s.add("Project".into(), loc("/home/u/proj")).await.unwrap();
        s.add("Tmp".into(), loc("/tmp")).await.unwrap();
        let s2 = BookmarksStore::load_from(&path).await.unwrap();
        let list = s2.list().await;
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "Project");
    }

    #[tokio::test]
    async fn remove_by_id() {
        let dir = tempdir().unwrap();
        let s = BookmarksStore::load_from(&dir.path().join("b.json")).await.unwrap();
        let after_add = s.add("X".into(), loc("/x")).await.unwrap();
        let id = after_add[0].id.clone();
        s.remove(&id).await.unwrap();
        assert!(s.list().await.is_empty());
    }

    #[tokio::test]
    async fn remove_nonexistent_noop() {
        let dir = tempdir().unwrap();
        let s = BookmarksStore::load_from(&dir.path().join("b.json")).await.unwrap();
        s.remove("ghost").await.unwrap();
        assert!(s.list().await.is_empty());
    }

    #[tokio::test]
    async fn empty_name_rejected() {
        let dir = tempdir().unwrap();
        let s = BookmarksStore::load_from(&dir.path().join("b.json")).await.unwrap();
        assert!(s.add("  ".into(), loc("/x")).await.is_err());
    }
}
```

- [ ] **Step 3: tests/mvp6_bookmarks_smoke.rs**

```rust
//! MVP-6 bookmarks smoke — lifecycle.

use duet_lib::services::bookmarks::BookmarksStore;
use duet_lib::types::{Location, SourceId};
use std::path::PathBuf;
use tempfile::tempdir;

fn loc(p: &str) -> Location {
    Location { source: SourceId::Local, path: PathBuf::from(p) }
}

#[tokio::test]
async fn smoke_lifecycle() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("bm.json");
    let s = BookmarksStore::load_from(&path).await.unwrap();
    assert!(s.list().await.is_empty());

    s.add("Alpha".into(), loc("/a")).await.unwrap();
    s.add("Beta".into(), loc("/b")).await.unwrap();
    let list = s.list().await;
    assert_eq!(list.len(), 2);

    let id_alpha = list.iter().find(|b| b.name == "Alpha").unwrap().id.clone();
    s.remove(&id_alpha).await.unwrap();
    s.remove("ghost").await.unwrap(); // no-op

    let s2 = BookmarksStore::load_from(&path).await.unwrap();
    let list2 = s2.list().await;
    assert_eq!(list2.len(), 1);
    assert_eq!(list2[0].name, "Beta");
}
```

- [ ] **Step 4: cargo check + test + clippy**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo check --lib --tests 2>&1 | tail -5
cargo test --lib services::bookmarks 2>&1 | tail -5
cargo test --test mvp6_bookmarks_smoke 2>&1 | tail -5
cargo clippy --lib --tests -- -D warnings 2>&1 | tail -3
```

Expected: 4 unit + 1 smoke pass, clippy clean

- [ ] **Step 5: Commit**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/services/bookmarks.rs src-tauri/src/services/mod.rs src-tauri/tests/mvp6_bookmarks_smoke.rs
git commit -m "be/svc: BookmarksStore — JSON store at <config_dir>/duet/bookmarks.json

- Bookmark { id (uuid v7), name, location }
- list / add / remove. add 가 새 uuid 발급. SavedHostsStore 패턴 동형.
- 4 unit + 1 smoke 테스트"
```

---

### Task 8: Backend services/host_favorites.rs + smoke

**Files:**
- Create: `src-tauri/src/services/host_favorites.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Create: `src-tauri/tests/mvp6_host_favorites_smoke.rs`

- [ ] **Step 1: services/mod.rs**

`pub mod host_favorites;` 추가.

- [ ] **Step 2: services/host_favorites.rs**

```rust
//! 호스트별 즐겨찾기. `<config_dir>/duet/host-favorites.json`.
//!
//! HostFavorite { id, host_alias, name, path }.
//! 사이드바는 활성 connections store 의 alias 와 매칭되는 항목만 표시 (frontend).

use crate::services::settings::duet_config_dir;
use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct HostFavorite {
    pub id: String,
    pub host_alias: String,
    pub name: String,
    pub path: PathBuf,
}

pub struct HostFavoritesStore {
    path: PathBuf,
    inner: RwLock<Vec<HostFavorite>>,
}

impl HostFavoritesStore {
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("host-favorites.json");
        Self::load_from(&path).await
    }

    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let items = if path.exists() {
            let text = tokio::fs::read_to_string(path)
                .await
                .map_err(DuetError::from)?;
            if text.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str::<Vec<HostFavorite>>(&text)
                    .map_err(|e| DuetError::Io(format!("host-favorites parse: {e}")))?
            }
        } else {
            Vec::new()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(items),
        }))
    }

    pub async fn list(&self) -> Vec<HostFavorite> {
        self.inner.read().await.clone()
    }

    pub async fn add(
        &self,
        host_alias: String,
        name: String,
        path: PathBuf,
    ) -> Result<Vec<HostFavorite>, DuetError> {
        if host_alias.trim().is_empty() {
            return Err(DuetError::Io("host_alias required".into()));
        }
        if name.trim().is_empty() {
            return Err(DuetError::Io("favorite name required".into()));
        }
        let item = HostFavorite {
            id: uuid::Uuid::now_v7().to_string(),
            host_alias,
            name,
            path,
        };
        let mut v = self.inner.write().await;
        v.push(item);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    pub async fn remove(&self, id: &str) -> Result<Vec<HostFavorite>, DuetError> {
        let mut v = self.inner.write().await;
        v.retain(|f| f.id != id);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    async fn write_to_disk(&self, items: &[HostFavorite]) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = serde_json::to_string_pretty(items)
            .map_err(|e| DuetError::Io(format!("host-favorites serialize: {e}")))?;
        tokio::fs::write(&self.path, text)
            .await
            .map_err(DuetError::from)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn add_list_remove() {
        let dir = tempdir().unwrap();
        let s = HostFavoritesStore::load_from(&dir.path().join("hf.json")).await.unwrap();
        s.add("srv1".into(), "logs".into(), PathBuf::from("/var/log")).await.unwrap();
        s.add("srv1".into(), "app".into(), PathBuf::from("/opt/app")).await.unwrap();
        s.add("srv2".into(), "home".into(), PathBuf::from("/home/u")).await.unwrap();
        let list = s.list().await;
        assert_eq!(list.len(), 3);
        let id = list[0].id.clone();
        s.remove(&id).await.unwrap();
        assert_eq!(s.list().await.len(), 2);
    }

    #[tokio::test]
    async fn empty_alias_or_name_rejected() {
        let dir = tempdir().unwrap();
        let s = HostFavoritesStore::load_from(&dir.path().join("hf.json")).await.unwrap();
        assert!(s.add("  ".into(), "x".into(), PathBuf::from("/x")).await.is_err());
        assert!(s.add("a".into(), "  ".into(), PathBuf::from("/x")).await.is_err());
    }

    #[tokio::test]
    async fn remove_nonexistent_noop() {
        let dir = tempdir().unwrap();
        let s = HostFavoritesStore::load_from(&dir.path().join("hf.json")).await.unwrap();
        s.remove("ghost").await.unwrap();
        assert!(s.list().await.is_empty());
    }
}
```

- [ ] **Step 3: tests/mvp6_host_favorites_smoke.rs**

```rust
//! MVP-6 host favorites smoke — lifecycle + persistence.

use duet_lib::services::host_favorites::HostFavoritesStore;
use std::path::PathBuf;
use tempfile::tempdir;

#[tokio::test]
async fn smoke_lifecycle() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("hf.json");
    let s = HostFavoritesStore::load_from(&path).await.unwrap();
    assert!(s.list().await.is_empty());

    s.add("alpha".into(), "logs".into(), PathBuf::from("/var/log")).await.unwrap();
    s.add("beta".into(), "home".into(), PathBuf::from("/home/u")).await.unwrap();
    assert_eq!(s.list().await.len(), 2);

    let s2 = HostFavoritesStore::load_from(&path).await.unwrap();
    let list = s2.list().await;
    assert_eq!(list.len(), 2);
    assert!(list.iter().any(|f| f.host_alias == "alpha"));
    assert!(list.iter().any(|f| f.host_alias == "beta"));

    let id = list[0].id.clone();
    s2.remove(&id).await.unwrap();
    assert_eq!(s2.list().await.len(), 1);
}
```

- [ ] **Step 4: cargo check + test + clippy**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo check --lib --tests 2>&1 | tail -5
cargo test --lib services::host_favorites 2>&1 | tail -5
cargo test --test mvp6_host_favorites_smoke 2>&1 | tail -5
cargo clippy --lib --tests -- -D warnings 2>&1 | tail -3
```

Expected: 3 unit + 1 smoke pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/services/host_favorites.rs src-tauri/src/services/mod.rs src-tauri/tests/mvp6_host_favorites_smoke.rs
git commit -m "be/svc: HostFavoritesStore — host-scoped favorites JSON store

- HostFavorite { id, host_alias, name, path }
- list / add / remove. add 새 uuid 발급, alias/name 비어있으면 Err.
- 3 unit + 1 smoke 테스트"
```

---

### Task 9: Backend commands/bookmarks.rs + commands/host_favorites.rs + lib.rs 등록

**Files:**
- Create: `src-tauri/src/commands/bookmarks.rs`
- Create: `src-tauri/src/commands/host_favorites.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: commands/bookmarks.rs**

```rust
//! Bookmarks IPC — list / add / remove.

use std::sync::Arc;

use crate::services::bookmarks::{Bookmark, BookmarksStore};
use crate::types::{DuetError, Location};

#[tauri::command]
#[specta::specta]
pub async fn bookmarks_list(
    store: tauri::State<'_, Arc<BookmarksStore>>,
) -> Result<Vec<Bookmark>, DuetError> {
    Ok(store.inner().list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn bookmarks_add(
    name: String,
    location: Location,
    store: tauri::State<'_, Arc<BookmarksStore>>,
) -> Result<Vec<Bookmark>, DuetError> {
    store.inner().add(name, location).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookmarks_remove(
    id: String,
    store: tauri::State<'_, Arc<BookmarksStore>>,
) -> Result<Vec<Bookmark>, DuetError> {
    store.inner().remove(&id).await
}
```

- [ ] **Step 2: commands/host_favorites.rs**

```rust
//! Host favorites IPC — list / add / remove.

use std::path::PathBuf;
use std::sync::Arc;

use crate::services::host_favorites::{HostFavorite, HostFavoritesStore};
use crate::types::DuetError;

#[tauri::command]
#[specta::specta]
pub async fn host_favorites_list(
    store: tauri::State<'_, Arc<HostFavoritesStore>>,
) -> Result<Vec<HostFavorite>, DuetError> {
    Ok(store.inner().list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn host_favorites_add(
    host_alias: String,
    name: String,
    path: PathBuf,
    store: tauri::State<'_, Arc<HostFavoritesStore>>,
) -> Result<Vec<HostFavorite>, DuetError> {
    store.inner().add(host_alias, name, path).await
}

#[tauri::command]
#[specta::specta]
pub async fn host_favorites_remove(
    id: String,
    store: tauri::State<'_, Arc<HostFavoritesStore>>,
) -> Result<Vec<HostFavorite>, DuetError> {
    store.inner().remove(&id).await
}
```

- [ ] **Step 3: commands/mod.rs**

`pub mod bookmarks;` + `pub mod host_favorites;` 추가 (alphabetic).

- [ ] **Step 4: lib.rs**

A. `collect_commands![]` 에 6 commands 추가:

```rust
commands::bookmarks::bookmarks_list,
commands::bookmarks::bookmarks_add,
commands::bookmarks::bookmarks_remove,
commands::host_favorites::host_favorites_list,
commands::host_favorites::host_favorites_add,
commands::host_favorites::host_favorites_remove,
```

B. `run()` 에서 2 stores 로드:

```rust
let bookmarks = tauri::async_runtime::block_on(async {
    services::bookmarks::BookmarksStore::load_default().await
})
.expect("bookmarks load");
let host_favorites = tauri::async_runtime::block_on(async {
    services::host_favorites::HostFavoritesStore::load_default().await
})
.expect("host favorites load");
```

C. `tauri::Builder` 에 `.manage(bookmarks)` + `.manage(host_favorites)` 추가.

- [ ] **Step 5: cargo check + clippy**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo check --lib --tests --bins 2>&1 | tail -5
cargo clippy --lib --tests --bins -- -D warnings 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/commands/bookmarks.rs src-tauri/src/commands/host_favorites.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "be/cmd: bookmarks + host_favorites IPC (6 commands)

- bookmarks_list / bookmarks_add / bookmarks_remove
- host_favorites_list / host_favorites_add / host_favorites_remove
- lib.rs: 6 commands 등록 + 2 stores manage in run()"
```

---

### Task 10: Frontend stores/bookmarks.ts + stores/hostFavorites.ts

**Files:**
- Create: `src/stores/bookmarks.ts`
- Create: `src/stores/hostFavorites.ts`

- [ ] **Step 1: stores/bookmarks.ts**

```ts
import { create } from "zustand";
import { commands } from "@/types/bindings";
import type { Bookmark, Location } from "@/types/bindings";

interface State {
  items: Bookmark[];
  setAll: (items: Bookmark[]) => void;
}

export const useBookmarks = create<State>((set) => ({
  items: [],
  setAll: (items) => set({ items }),
}));

export async function bootstrapBookmarks(): Promise<void> {
  const r = await commands.bookmarksList();
  if (r.status === "ok") useBookmarks.getState().setAll(r.data);
}

export async function addBookmark(name: string, location: Location): Promise<boolean> {
  const r = await commands.bookmarksAdd(name, location);
  if (r.status === "ok") {
    useBookmarks.getState().setAll(r.data);
    return true;
  }
  return false;
}

export async function removeBookmark(id: string): Promise<void> {
  const r = await commands.bookmarksRemove(id);
  if (r.status === "ok") useBookmarks.getState().setAll(r.data);
}
```

- [ ] **Step 2: stores/hostFavorites.ts**

```ts
import { create } from "zustand";
import { commands } from "@/types/bindings";
import type { HostFavorite } from "@/types/bindings";

interface State {
  items: HostFavorite[];
  setAll: (items: HostFavorite[]) => void;
}

export const useHostFavorites = create<State>((set) => ({
  items: [],
  setAll: (items) => set({ items }),
}));

export async function bootstrapHostFavorites(): Promise<void> {
  const r = await commands.hostFavoritesList();
  if (r.status === "ok") useHostFavorites.getState().setAll(r.data);
}

export async function addHostFavorite(host_alias: string, name: string, path: string): Promise<boolean> {
  const r = await commands.hostFavoritesAdd(host_alias, name, path);
  if (r.status === "ok") {
    useHostFavorites.getState().setAll(r.data);
    return true;
  }
  return false;
}

export async function removeHostFavorite(id: string): Promise<void> {
  const r = await commands.hostFavoritesRemove(id);
  if (r.status === "ok") useHostFavorites.getState().setAll(r.data);
}
```

- [ ] **Step 3: tsc**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
pnpm tsc --noEmit 2>&1 | tail -5
```

Expected: clean (bindings.ts 자동 재생성 후).

- [ ] **Step 4: Commit**

```bash
git add src/stores/bookmarks.ts src/stores/hostFavorites.ts
git commit -m "fe/store: bookmarks + hostFavorites stores

- mirror SavedHostsStore 패턴: bootstrap + add + remove
- 백엔드 IPC 호출 후 store.setAll(반환된 list)"
```

---

### Task 11: Sidebar 2 새 섹션 (Bookmarks + Favorites) + App 통합

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Sidebar 갱신**

`src/components/Sidebar.tsx` — 두 섹션 추가. SavedHostsSection 패턴 따라.

import 추가:
```tsx
import { Star, Heart } from "lucide-react";
import { useBookmarks, removeBookmark } from "@/stores/bookmarks";
import { useHostFavorites, removeHostFavorite } from "@/stores/hostFavorites";
import type { Bookmark, HostFavorite, Location } from "@/types/bindings";
```

Sidebar props 확장:
```tsx
export function Sidebar({
  onHostActivate,
  onAdHocOpen,
  onSavedActivate,
  onBookmarkActivate,
  onFavoriteActivate,
  onAddBookmark,
  onAddFavorite,
}: {
  onHostActivate: (alias: string) => void;
  onAdHocOpen: () => void;
  onSavedActivate: (host: SavedHost) => void;
  onBookmarkActivate: (location: Location) => void;
  onFavoriteActivate: (favorite: HostFavorite) => void;
  onAddBookmark: () => void;
  onAddFavorite: () => void;
}) {
```

JSX 추가 (SavedHostsSection 다음, Bookmarks 섹션 → Favorites 섹션 → 기존 Bookmarks 자리는 제거):

```tsx
<BookmarksSection onActivate={onBookmarkActivate} onAdd={onAddBookmark} />
<HostFavoritesSection onActivate={onFavoriteActivate} onAdd={onAddFavorite} />
{/* 기존 "Bookmarks" placeholder 섹션 제거 — MVP-5 의 (MVP-6) placeholder */}
```

새 섹션 컴포넌트 추가 (Sidebar.tsx 안 또는 별도 export — 같은 파일):

```tsx
function BookmarksSection({
  onActivate,
  onAdd,
}: {
  onActivate: (location: Location) => void;
  onAdd: () => void;
}) {
  const items = useBookmarks((s) => s.items);
  return (
    <SectionWithAction
      title="Bookmarks"
      icon={<Star size={14} />}
      action={
        <button
          type="button"
          onClick={onAdd}
          className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
          aria-label="Add bookmark"
          title="Add active tab to bookmarks"
        >
          <Plus size={11} />
        </button>
      }
    >
      {items.length === 0 ? (
        <Item label="(none — + to add active tab)" muted />
      ) : (
        items.map((b) => (
          <BookmarkItem key={b.id} bookmark={b} onActivate={onActivate} />
        ))
      )}
    </SectionWithAction>
  );
}

function BookmarkItem({
  bookmark,
  onActivate,
}: {
  bookmark: Bookmark;
  onActivate: (location: Location) => void;
}) {
  return (
    <div
      onDoubleClick={() => onActivate(bookmark.location)}
      title={`${bookmark.location.source.kind === "ssh" ? "ssh:" : ""}${bookmark.location.path}`}
      className="group flex cursor-default items-center gap-1 rounded px-2 py-0.5 hover:bg-border"
    >
      <Star size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{bookmark.name}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void removeBookmark(bookmark.id);
        }}
        className="ml-auto shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-danger group-hover:opacity-100"
        aria-label="Remove bookmark"
      >
        <X size={11} />
      </button>
    </div>
  );
}

function HostFavoritesSection({
  onActivate,
  onAdd,
}: {
  onActivate: (favorite: HostFavorite) => void;
  onAdd: () => void;
}) {
  const items = useHostFavorites((s) => s.items);
  const activeAliases = useConnections((s) => s.actives.map((c) => c.alias));
  // 활성 connection 의 alias 와 매칭되는 항목만
  const visible = items.filter((f) => activeAliases.includes(f.host_alias));
  // alias 별 그룹화
  const groups: Record<string, HostFavorite[]> = {};
  for (const f of visible) {
    (groups[f.host_alias] ??= []).push(f);
  }
  const groupKeys = Object.keys(groups).sort();

  return (
    <SectionWithAction
      title="Favorites"
      icon={<Heart size={14} />}
      action={
        <button
          type="button"
          onClick={onAdd}
          className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
          aria-label="Add favorite"
          title="Add active tab path (SSH only)"
        >
          <Plus size={11} />
        </button>
      }
    >
      {groupKeys.length === 0 ? (
        <Item label="(none — connect to host first)" muted />
      ) : (
        groupKeys.map((alias) => (
          <div key={alias}>
            <div className="px-2 text-meta text-fg-muted">{alias}</div>
            {groups[alias]!.map((f) => (
              <FavoriteItem key={f.id} fav={f} onActivate={onActivate} />
            ))}
          </div>
        ))
      )}
    </SectionWithAction>
  );
}

function FavoriteItem({
  fav,
  onActivate,
}: {
  fav: HostFavorite;
  onActivate: (favorite: HostFavorite) => void;
}) {
  return (
    <div
      onDoubleClick={() => onActivate(fav)}
      title={fav.path as unknown as string}
      className="group flex cursor-default items-center gap-1 rounded pl-4 pr-2 py-0.5 hover:bg-border"
    >
      <Heart size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{fav.name}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void removeHostFavorite(fav.id);
        }}
        className="ml-auto shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-danger group-hover:opacity-100"
        aria-label="Remove favorite"
      >
        <X size={11} />
      </button>
    </div>
  );
}
```

기존 `(MVP-6) placeholder` 의 Bookmarks Section (`<Section title="Bookmarks" icon={<Star size={14} />}> <Item label="(MVP-6)" muted /> </Section>`) 제거.

- [ ] **Step 2: App.tsx 통합**

A. import 추가:
```tsx
import { bootstrapBookmarks, addBookmark } from "@/stores/bookmarks";
import { bootstrapHostFavorites, addHostFavorite } from "@/stores/hostFavorites";
import type { Bookmark, HostFavorite } from "@/types/bindings";
import { useConnections } from "@/stores/connections";
```

B. bootstrap 추가 (기존 bootstrap useEffect 안에):

```tsx
void bootstrapBookmarks();
void bootstrapHostFavorites();
```

C. callback 추가:

```tsx
const onBookmarkActivate = useCallback(
  (location: Location) => {
    const id = usePanes.getState().activePane;
    void navigate(id, location.path);
    // SSH bookmark 면 location.source 가 다름 — TabState.location 자체를 교체해야.
    // 현재 navigate 는 path 만. 확장 필요:
    //   navigate 가 location 전체 받도록 시그니처 변경, 또는 별도 navigateTo(id, location).
    //   여기서는 navigateTo 별도 추가.
  },
  [],
);

const navigateTo = useCallback(
  async (id: PaneId, location: Location, opts: { pushHistory?: boolean } = {}) => {
    try {
      const entries = await listDirectory(location);
      usePanes.getState().setEntries(id, location, entries, { pushHistory: opts.pushHistory ?? true });
      void commands.paneWatchSet(id, location);
    } catch (e) {
      const msg = e && typeof e === "object" && "kind" in e
        ? `${(e as { kind: string }).kind}: ${formatErr(e as DuetError)}`
        : String(e);
      showToast(`Cannot open ${location.path} — ${msg}`);
    }
  },
  [listDirectory, showToast],
);

// 위의 onBookmarkActivate 다시 작성:
const onBookmarkActivate2 = useCallback(
  (location: Location) => {
    const id = usePanes.getState().activePane;
    void navigateTo(id, location);
  },
  [navigateTo],
);

const onFavoriteActivate = useCallback(
  (fav: HostFavorite) => {
    const conn = useConnections.getState().actives.find((c) => c.alias === fav.host_alias);
    if (!conn) {
      showToast(`Connect to ${fav.host_alias} first`);
      return;
    }
    const id = usePanes.getState().activePane;
    const location: Location = {
      source: { kind: "ssh", connection_id: conn.id, host_ip: conn.host_ip, user: conn.user },
      path: fav.path as unknown as string,
    };
    void navigateTo(id, location);
  },
  [navigateTo, showToast],
);

const onAddBookmark = useCallback(() => {
  const id = usePanes.getState().activePane;
  const tab = activeTab(usePanes.getState(), id);
  // 단순 prompt — 디폴트 = path 마지막 segment
  const defaultName = tab.location.path.split("/").filter(Boolean).pop() || "/";
  const name = window.prompt("Bookmark name", defaultName);
  if (name) void addBookmark(name, tab.location);
}, []);

const onAddFavorite = useCallback(() => {
  const id = usePanes.getState().activePane;
  const tab = activeTab(usePanes.getState(), id);
  if (tab.location.source.kind !== "ssh") {
    showToast("Favorites: switch to SSH pane first");
    return;
  }
  // alias 찾기 — connections store
  const conn = useConnections.getState().actives.find(
    (c) => tab.location.source.kind === "ssh" && c.id === tab.location.source.connection_id,
  );
  if (!conn) {
    showToast("Active connection not found");
    return;
  }
  const defaultName = (tab.location.path as unknown as string).split("/").filter(Boolean).pop() || "/";
  const name = window.prompt("Favorite name", defaultName);
  if (name) void addHostFavorite(conn.alias, name, tab.location.path as unknown as string);
}, [showToast]);
```

D. Sidebar 호출 갱신:

```tsx
<Sidebar
  onHostActivate={onHostActivate}
  onAdHocOpen={onAdHocOpen}
  onSavedActivate={onSavedActivate}
  onBookmarkActivate={onBookmarkActivate2}
  onFavoriteActivate={onFavoriteActivate}
  onAddBookmark={onAddBookmark}
  onAddFavorite={onAddFavorite}
/>
```

위 코드의 `onBookmarkActivate` 와 `onBookmarkActivate2` 는 통합 — 첫 번째는 placeholder 였고 두 번째가 진짜. 한 callback 으로 정리.

**현재 connections store 의 `actives` 필드명 확인**: `useConnections((s) => s.actives)` 또는 `s.activeConnections`. 코드 읽어서 정확히 매칭.

- [ ] **Step 3: tsc + lint + test**

```bash
pnpm tsc --noEmit 2>&1 | tail -10
pnpm lint 2>&1 | tail -3
pnpm test --run 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/Sidebar.tsx src/App.tsx
git commit -m "fe/ui: Sidebar Bookmarks + Favorites 섹션 + App 통합

- Sidebar: 기존 (MVP-6) placeholder 제거, Bookmarks (always-shown) +
  Favorites (host-scoped, alias 그룹화) 섹션 추가. + 버튼/X 버튼
- App: navigateTo(id, location, opts) helper (location 전체 받음 — bookmark
  의 SSH 가능). onBookmarkActivate / onFavoriteActivate / onAddBookmark
  (window.prompt 이름) / onAddFavorite (SSH 패널 필수)
- bootstrap useEffect 에 bookmarks + hostFavorites 추가"
```

---

## Phase D — 마무리

### Task 12: ROADMAP MVP-6 + final gates

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: 모든 게이트**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo fmt --check 2>&1 | tail -3
cargo clippy --all-targets -- -D warnings 2>&1 | tail -3
cargo test --lib 2>&1 | tail -3
cargo test --tests 2>&1 | tail -15

cd /Users/ctmctm/Desktop/01_PROJECT/duet
pnpm tsc --noEmit 2>&1 | tail -3
pnpm lint 2>&1 | tail -3
pnpm test --run 2>&1 | tail -5
```

Expected: 모두 pass.

- [ ] **Step 2: ROADMAP.md 갱신**

찾기:
```markdown
## MVP-6: 탭 + 북마크

- [ ] 패널당 탭 (Ctrl+T, Ctrl+W)
- [ ] 북마크 (사이드바)
- [ ] 최근 디렉토리 (Alt+←/→ 히스토리)
- [ ] 호스트별 즐겨찾기
```

대체:
```markdown
## MVP-6: 탭 + 북마크 + 히스토리

- [x] 패널당 탭 (Ctrl+T 새 탭, Ctrl+W 닫기, Ctrl+Tab/Shift+Tab 전환) — 세션 내만
- [x] 사이드바 북마크 (any location, ⭐ 섹션) — Sidebar + 클릭 시 활성 탭 navigate
- [x] 최근 디렉토리 (Alt+←/→) — 탭당 back/forward 스택, cap 100
- [x] 호스트별 즐겨찾기 (💖 섹션, 활성 connection 의 alias 만 표시)
```

찾기 (현재 단계):
```markdown
**MVP-6 시작 직전.** ...
```

대체:
```markdown
**MVP-7 시작 직전.** MVP-6 완료 — 탭/히스토리/북마크/호스트 즐겨찾기.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
git add ROADMAP.md
git commit -m "docs: MVP-6 완료 표시"
```

---

## 자기 점검

**Spec 커버리지:**

| Spec section | Task |
|---|---|
| A. PaneState/TabState 분리 + 액션 dispatch | 1 |
| A. TabBar 컴포넌트 | 2 |
| A. Pane 통합 + active tab accessor | 3 |
| A. Ctrl+T/W/Tab + sort 단축키 이전 | 4 |
| B. history field + back/forward + setEntries pushHistory | 5 |
| B. PathBar back/forward + Pane onBack/onForward + Alt+←/→ + App navigate pushHistory | 6 |
| C. BookmarksStore + smoke | 7 |
| C. HostFavoritesStore + smoke | 8 |
| C. 6 IPC commands + lib.rs | 9 |
| C. Frontend stores | 10 |
| C. Sidebar 섹션 + App 통합 | 11 |
| Final | 12 |

**Placeholder scan:** 없음. 모든 step 에 실제 코드.

**Type consistency:**
- TabState / PaneState / SortKey / SortOrder: panes.ts 정의, 모든 사용처 일관
- `selectDisplayedEntries(id, state)`, `activeTab(state, id)`: 시그니처 일관
- `onBack(id)` / `onForward(id)`: Pane / useGlobalShortcuts opts / App callbacks 일관
- Bookmark / HostFavorite: backend specta Type derive → bindings.ts 자동
- `navigateTo` helper 가 Task 11 신규 — 이전 navigate 는 path만, navigateTo 는 location 전체

---

## 실행 핸드오프

Plan saved to `docs/plans/2026-05-10-mvp6-tabs-bookmarks-history.md`.

12 tasks. Subagent-driven 또는 inline.
