# MVP-5 검색과 정렬 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 듀얼패널 파일 매니저에 정렬/숨김/새로고침/빠른필터/글로벌 검색 5개 기능 추가.

**Architecture:** 패널 표시 옵션 (sort/hidden/filter) 은 zustand `PaneState` 확장 + selector. 글로벌 검색은 backend `SearchBackend` trait (LocalFilenameSearch via `ignore::WalkBuilder`, SshFilenameSearch via russh `find` exec) + 결과 패널 컴포넌트.

**Tech Stack:** Rust (`ignore` crate already in deps, `russh` for SSH find exec, `tokio_util::CancellationToken`), TypeScript/React + zustand, Vitest.

**Spec:** `docs/specs/2026-05-10-mvp5-search-and-sort-design.md`

---

## File Structure

### Phase A — 패널 표시 옵션 (sort + hidden + refresh)

| File | Change | Responsibility |
|---|---|---|
| `src/stores/panes.ts` | Modify | sortKey/sortOrder/showHidden state + setter actions + `selectDisplayedEntries` selector |
| `src/stores/panes.test.ts` | Create | selector + actions 단위 테스트 |
| `src/components/pane/EntryList.tsx` | Modify | 컬럼 헤더 (Name/Size/Modified/Type) + sort 화살표 + 클릭 핸들러 |
| `src/components/pane/Pane.tsx` | Modify | `pane.entries` 대신 `selectDisplayedEntries(id)` 사용 |
| `src/hooks/useGlobalShortcuts.ts` | Modify | Ctrl+H/R/1..5 추가 |
| `src/App.tsx` | Modify | `sortEntries` 헬퍼 제거 (selector 로 이동), setEntries raw 그대로 전달 |

### Phase B — 빠른 필터 (Ctrl+F)

| File | Change | Responsibility |
|---|---|---|
| `src/stores/panes.ts` | Modify | filter/filterFocused state + setters + selector 에 filter 단계 추가 |
| `src/components/pane/PaneFilterBar.tsx` | Create | 필터 input + ESC/Enter 핸들러 |
| `src/components/pane/Pane.tsx` | Modify | PaneFilterBar 삽입 (PathBar 와 EntryList 사이) |
| `src/hooks/useGlobalShortcuts.ts` | Modify | Ctrl+F 추가 |
| `src/App.tsx` | Modify | navigate 시 filter 자동 clear |

### Phase C — 글로벌 검색 (Ctrl+Shift+F)

| File | Change | Responsibility |
|---|---|---|
| `src-tauri/src/core/search.rs` | Create | `SearchBackend` trait + `LocalFilenameSearch` + `SshFilenameSearch` + DTO 타입 |
| `src-tauri/src/core/mod.rs` | Modify | `pub mod search;` |
| `src-tauri/src/commands/search.rs` | Create | `search_global` + `search_cancel` IPC |
| `src-tauri/src/commands/mod.rs` | Modify | `pub mod search;` |
| `src-tauri/src/lib.rs` | Modify | 2 commands 등록 + `Mutex<Option<CancellationToken>>` State |
| `src-tauri/tests/mvp5_search_smoke.rs` | Create | 로컬 + ssh `find` 파서 smoke |
| `src/stores/search.ts` | Create | 검색 상태 + debounced query |
| `src/stores/search.test.ts` | Create | debounce + 결과 setter 테스트 |
| `src/components/SearchPanel.tsx` | Create | 결과 패널 (input + 결과 리스트) |
| `src/hooks/useGlobalShortcuts.ts` | Modify | Ctrl+Shift+F 추가 |
| `src/App.tsx` | Modify | SearchPanel 렌더 + 결과 클릭 시 navigate |

### Phase D — 마무리

| File | Change | Responsibility |
|---|---|---|
| `ROADMAP.md` | Modify | MVP-5 [x] |

---

## Phase A — 패널 표시 옵션

### Task 1: PaneState 확장 + selectDisplayedEntries selector

**Files:**
- Modify: `src/stores/panes.ts`
- Create: `src/stores/panes.test.ts`

- [ ] **Step 1: 테스트 작성 (panes.test.ts)**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { usePanes, selectDisplayedEntries } from "./panes";
import type { Entry } from "@/types/bindings";

const mk = (name: string, kind: "dir" | "file" = "file", size = 100, mtime = 0, hidden = false): Entry =>
  ({ name, kind, size, modified_ms: mtime, permissions: null, hidden }) as Entry;

describe("panes store sort/hidden", () => {
  beforeEach(() => {
    usePanes.setState((s) => ({
      panes: {
        ...s.panes,
        left: { ...s.panes.left, entries: [], sortKey: "name", sortOrder: "asc", showHidden: false, filter: "", filterFocused: false },
      },
    }));
  });

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

  it("toggleSortKey: 같은 key — order toggle", () => {
    usePanes.getState().setSort("left", "name", "asc");
    usePanes.getState().toggleSortKey("left", "name");
    expect(usePanes.getState().panes.left.sortOrder).toBe("desc");
    usePanes.getState().toggleSortKey("left", "name");
    expect(usePanes.getState().panes.left.sortOrder).toBe("asc");
  });

  it("toggleSortKey: 다른 key — 새 key + asc", () => {
    usePanes.getState().setSort("left", "name", "desc");
    usePanes.getState().toggleSortKey("left", "size");
    expect(usePanes.getState().panes.left.sortKey).toBe("size");
    expect(usePanes.getState().panes.left.sortOrder).toBe("asc");
  });

  it("hidden default — dotfiles 숨김", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [
      mk(".bashrc", "file", 100, 0, true),
      mk("README.md", "file"),
    ]);
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["README.md"]);
  });

  it("toggleShowHidden — dotfiles 표시", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [
      mk(".bashrc", "file", 100, 0, true),
      mk("README.md", "file"),
    ]);
    usePanes.getState().toggleShowHidden("left");
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual([".bashrc", "README.md"]);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd /Users/ctmctm/Desktop/01_PROJECT/duet && pnpm test --run src/stores/panes.test.ts 2>&1 | tail -10`
Expected: FAIL — `setSort`, `toggleSortKey`, `toggleShowHidden`, `selectDisplayedEntries` 미정의

- [ ] **Step 3: panes.ts 확장**

`src/stores/panes.ts` 전체 내용:

```ts
import { create } from "zustand";
import type { Entry, Location } from "@/types/bindings";

export type PaneId = "left" | "right";
export type SortKey = "name" | "size" | "mtime" | "kind" | "ext";
export type SortOrder = "asc" | "desc";

export interface PaneState {
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
}

interface PanesState {
  panes: Record<PaneId, PaneState>;
  activePane: PaneId;
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

const initialPane = (): PaneState => ({
  location: home(),
  entries: [],
  cursorIndex: -1,
  selected: new Set(),
  loadedAt: 0,
  sortKey: "name",
  sortOrder: "asc",
  showHidden: false,
  filter: "",
  filterFocused: false,
});

export const usePanes = create<PanesState>((set) => ({
  panes: {
    left: initialPane(),
    right: initialPane(),
  },
  activePane: "left",
  setEntries: (id, location, entries) =>
    set((s) => {
      const prevPath = s.panes[id].location.path;
      const navigated = prevPath !== location.path;
      return {
        panes: {
          ...s.panes,
          [id]: {
            ...s.panes[id],
            location,
            entries,
            cursorIndex: entries.length > 0 ? 0 : -1,
            selected: new Set(),
            loadedAt: Date.now(),
            // navigate 시 filter 자동 clear (의도된 새 컨텍스트)
            filter: navigated ? "" : s.panes[id].filter,
            filterFocused: navigated ? false : s.panes[id].filterFocused,
          },
        },
      };
    }),
  setActivePane: (id) => set({ activePane: id }),
  moveCursor: (id, delta) =>
    set((s) => {
      const p = s.panes[id];
      const visible = computeDisplayed(p);
      const next = Math.max(0, Math.min(visible.length - 1, p.cursorIndex + delta));
      return { panes: { ...s.panes, [id]: { ...p, cursorIndex: next } } };
    }),
  setCursor: (id, index) =>
    set((s) => ({
      panes: { ...s.panes, [id]: { ...s.panes[id], cursorIndex: index } },
    })),
  toggleSelected: (id, name) =>
    set((s) => {
      const p = s.panes[id];
      const next = new Set(p.selected);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { panes: { ...s.panes, [id]: { ...p, selected: next } } };
    }),
  clearSelection: (id) =>
    set((s) => ({
      panes: { ...s.panes, [id]: { ...s.panes[id], selected: new Set() } },
    })),
  setSort: (id, key, order) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: { ...s.panes[id], sortKey: key, sortOrder: order, cursorIndex: 0 },
      },
    })),
  toggleSortKey: (id, key) =>
    set((s) => {
      const p = s.panes[id];
      if (p.sortKey === key) {
        return {
          panes: {
            ...s.panes,
            [id]: { ...p, sortOrder: p.sortOrder === "asc" ? "desc" : "asc" },
          },
        };
      }
      return {
        panes: { ...s.panes, [id]: { ...p, sortKey: key, sortOrder: "asc", cursorIndex: 0 } },
      };
    }),
  toggleShowHidden: (id) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: { ...s.panes[id], showHidden: !s.panes[id].showHidden, cursorIndex: 0 },
      },
    })),
  setFilter: (id, filter) =>
    set((s) => ({
      panes: { ...s.panes, [id]: { ...s.panes[id], filter, cursorIndex: 0 } },
    })),
  setFilterFocused: (id, focused) =>
    set((s) => ({
      panes: { ...s.panes, [id]: { ...s.panes[id], filterFocused: focused } },
    })),
}));

/** 표시 entries 계산 — raw → filter → hidden → sort. */
export function selectDisplayedEntries(id: PaneId, state: PanesState): Entry[] {
  return computeDisplayed(state.panes[id]);
}

function computeDisplayed(p: PaneState): Entry[] {
  let arr = p.entries;
  if (p.filter.length > 0) {
    const q = p.filter.toLowerCase();
    arr = arr.filter((e) => e.name.toLowerCase().includes(q));
  }
  if (!p.showHidden) {
    arr = arr.filter((e) => !e.hidden);
  }
  return sortEntries(arr, p.sortKey, p.sortOrder);
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
        return a.size - b.size || cmpName(a, b);
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

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test --run src/stores/panes.test.ts 2>&1 | tail -10`
Expected: PASS — 6 tests

- [ ] **Step 5: tsc + lint**

Run: `pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/stores/panes.ts src/stores/panes.test.ts
git commit -m "fe/store: PaneState sort/hidden/filter + selectDisplayedEntries

- sortKey (name/size/mtime/kind/ext) + sortOrder (asc/desc) + showHidden
  + filter + filterFocused 필드 추가
- setSort / toggleSortKey / toggleShowHidden / setFilter / setFilterFocused
  actions
- selectDisplayedEntries selector — raw → filter → hidden → sort 순.
  dirs-first 정렬 보존.
- setEntries 가 navigate (path 변경) 시 filter 자동 clear
- 6 vitest pass"
```

---

### Task 2: EntryList 컬럼 헤더 + sort 화살표

**Files:**
- Modify: `src/components/pane/EntryList.tsx`

- [ ] **Step 1: EntryList 수정 — 헤더 추가**

`src/components/pane/EntryList.tsx` 전체:

```tsx
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { Entry } from "@/types/bindings";
import type { SortKey, SortOrder } from "@/stores/panes";
import { EntryRow } from "./EntryRow";

interface EntryListProps {
  entries: Entry[];
  cursorIndex: number;
  selected: Set<string>;
  sortKey: SortKey;
  sortOrder: SortOrder;
  onCursorMove: (index: number) => void;
  onActivate: (entry: Entry, index: number) => void;
  onToggleSelect: (name: string) => void;
  onSortClick: (key: SortKey) => void;
}

const ROW_HEIGHT = 28;

/**
 * 가상 스크롤 파일 리스트 + 정렬 가능 컬럼 헤더.
 * 헤더 클릭 시 onSortClick — 같은 key 재클릭은 order toggle (store).
 */
export function EntryList({
  entries,
  cursorIndex,
  selected,
  sortKey,
  sortOrder,
  onCursorMove,
  onActivate,
  onToggleSelect: _onToggleSelect,
  onSortClick,
}: EntryListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  useEffect(() => {
    if (cursorIndex >= 0) {
      virtualizer.scrollToIndex(cursorIndex, { align: "auto" });
    }
  }, [cursorIndex, virtualizer]);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex h-6 shrink-0 items-center border-b border-border bg-subtle text-meta text-fg-muted">
        <ColumnHeader label="Name" col="name" current={sortKey} order={sortOrder} onClick={onSortClick} className="flex-1 px-2" />
        <ColumnHeader label="Size" col="size" current={sortKey} order={sortOrder} onClick={onSortClick} className="w-20 px-2 text-right" />
        <ColumnHeader label="Modified" col="mtime" current={sortKey} order={sortOrder} onClick={onSortClick} className="w-32 px-2 text-right" />
        <ColumnHeader label="Type" col="kind" current={sortKey} order={sortOrder} onClick={onSortClick} className="w-16 px-2" />
      </div>
      <div ref={parentRef} className="flex-1 min-h-0 overflow-auto">
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const entry = entries[vi.index];
            if (entry === undefined) return null;
            return (
              <div
                key={vi.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: `${vi.size}px`,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <EntryRow
                  entry={entry}
                  isCursor={cursorIndex === vi.index}
                  isSelected={selected.has(entry.name)}
                  onClick={() => onCursorMove(vi.index)}
                  onDoubleClick={() => onActivate(entry, vi.index)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ColumnHeader({
  label,
  col,
  current,
  order,
  onClick,
  className,
}: {
  label: string;
  col: SortKey;
  current: SortKey;
  order: SortOrder;
  onClick: (key: SortKey) => void;
  className: string;
}) {
  const active = col === current;
  return (
    <button
      type="button"
      onClick={() => onClick(col)}
      className={`flex h-6 items-center gap-1 hover:text-fg ${className} ${active ? "text-fg" : ""}`}
    >
      <span>{label}</span>
      {active && (order === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
    </button>
  );
}
```

- [ ] **Step 2: tsc 검증**

Run: `pnpm tsc --noEmit 2>&1 | tail -5`
Expected: 일부 에러 가능 — Pane.tsx 가 새 props 전달 안 함. Task 4 에서 fix.

- [ ] **Step 3: Commit (Pane.tsx 통합 전이라도 OK)**

```bash
git add src/components/pane/EntryList.tsx
git commit -m "fe/ui: EntryList 컬럼 헤더 + sort 화살표

- Name/Size/Modified/Type 4 컬럼 헤더 (button), 클릭 시 onSortClick
- 활성 컬럼은 Chevron Up/Down 으로 order 표시
- props: sortKey, sortOrder, onSortClick 추가 (Pane 통합은 Task 4)"
```

---

### Task 3: useGlobalShortcuts — Ctrl+H/R/1..5 추가

**Files:**
- Modify: `src/hooks/useGlobalShortcuts.ts`

- [ ] **Step 1: 시그니처 확장 + 키 핸들러 추가**

`src/hooks/useGlobalShortcuts.ts` 전체:

```ts
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUI } from "@/stores/ui";
import { usePanes, type SortKey } from "@/stores/panes";

/**
 * 글로벌 (패널 무관) 단축키.
 *
 * 기존: Ctrl+B (사이드바 토글), Ctrl+Q (종료)
 * 추가 (MVP-5):
 * - Ctrl+H: 활성 패널 hidden toggle
 * - Ctrl+R / F5: 활성 패널 새로고침 (onRefresh 콜백)
 * - Ctrl+1..5: 활성 패널 sort key (name/size/mtime/kind/ext) — 같은 key
 *   재클릭 시 order toggle
 *
 * 패널 키 (↑↓/Enter/...)는 useKeyboardNav 에서 처리.
 *
 * 입력 input/textarea 포커스 시 — Ctrl+H/R/1..5 무시 (input 의 자체 단축키
 * 또는 텍스트 입력 우선).
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
        // F5 = refresh (modifier 없이도 동작)
        if (e.key === "F5" && !isInput) {
          e.preventDefault();
          onRefresh(usePanes.getState().activePane);
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
        case "1":
        case "2":
        case "3":
        case "4":
        case "5": {
          if (isInput) break;
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

- [ ] **Step 2: App.tsx 호출처 수정**

`src/App.tsx` 의 `useGlobalShortcuts();` 한 줄 → `useGlobalShortcuts({ onRefresh });`

- [ ] **Step 3: tsc + lint**

Run: `pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useGlobalShortcuts.ts src/App.tsx
git commit -m "fe/hook: Ctrl+H/R/F5/1..5 단축키 추가 (MVP-5 A)

- Ctrl+H: 활성 패널 hidden toggle
- Ctrl+R / F5: 활성 패널 새로고침 (App.onRefresh 콜백)
- Ctrl+1..5: sort key name/size/mtime/kind/ext, 같은 key 재클릭 order toggle
- input/textarea 포커스 시 패널 단축키 무시 (텍스트 입력 우선)"
```

---

### Task 4: Pane 가 selectDisplayedEntries + EntryList 새 props 사용

**Files:**
- Modify: `src/components/pane/Pane.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Pane.tsx 수정**

```tsx
import { PathBar } from "./PathBar";
import { EntryList } from "./EntryList";
import { usePanes, selectDisplayedEntries, type PaneId } from "@/stores/panes";
import type { Entry } from "@/types/bindings";
import clsx from "clsx";

interface PaneProps {
  id: PaneId;
  onNavigate: (id: PaneId, path: string) => void;
  onActivate: (id: PaneId, entry: Entry) => void;
  onRefresh: (id: PaneId) => void;
}

export function Pane({ id, onNavigate, onActivate, onRefresh }: PaneProps) {
  const pane = usePanes((s) => s.panes[id]);
  const isActive = usePanes((s) => s.activePane === id);
  const setActivePane = usePanes((s) => s.setActivePane);
  const setCursor = usePanes((s) => s.setCursor);
  const toggleSelected = usePanes((s) => s.toggleSelected);
  const toggleSortKey = usePanes((s) => s.toggleSortKey);
  const displayed = usePanes((s) => selectDisplayedEntries(id, s));

  return (
    <div
      className={clsx(
        "flex flex-1 flex-col min-h-0 border border-border",
        isActive && "border-accent",
      )}
      onMouseDown={() => setActivePane(id)}
    >
      <PathBar
        location={pane.location}
        onUp={() => {
          const path = pane.location.path;
          if (path === "/" || path.length === 0) return;
          const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
          onNavigate(id, parent);
        }}
        onSegmentClick={(p) => onNavigate(id, p)}
        onRefresh={() => onRefresh(id)}
      />
      <EntryList
        entries={displayed}
        cursorIndex={pane.cursorIndex}
        selected={pane.selected}
        sortKey={pane.sortKey}
        sortOrder={pane.sortOrder}
        onCursorMove={(i) => setCursor(id, i)}
        onActivate={(entry) => onActivate(id, entry)}
        onToggleSelect={(name) => toggleSelected(id, name)}
        onSortClick={(k) => toggleSortKey(id, k)}
      />
    </div>
  );
}
```

- [ ] **Step 2: App.tsx 의 sortEntries 헬퍼 제거**

찾기: `App.tsx` 의 `sortEntries = useCallback((entries: Entry[]): Entry[] => { ... })` 정의 + `state.setEntries(id, location, sortEntries(entries))` 호출처 모두.

수정: `sortEntries` 함수 정의 제거. 모든 `sortEntries(entries)` → `entries` 로 (raw 그대로 setEntries — selector 가 정렬).

호출처 (3곳 추정):
- `navigate` 함수 안
- `onConnected` 안 (SSH 연결 후 setEntries)

- [ ] **Step 3: tsc + lint + 테스트**

Run: `pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3 && pnpm test --run 2>&1 | tail -5`
Expected: clean, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/components/pane/Pane.tsx src/App.tsx
git commit -m "fe/ui: Pane uses selectDisplayedEntries selector

- Pane → displayed = selectDisplayedEntries(id) — raw + filter + hidden + sort
- EntryList 에 sortKey/sortOrder/onSortClick 전달
- App.tsx 의 sortEntries 헬퍼 제거 (selector 가 처리)
- 모든 setEntries 가 raw entries 그대로 전달"
```

---

## Phase B — 빠른 필터 (Ctrl+F)

### Task 5: PaneFilterBar 컴포넌트

**Files:**
- Create: `src/components/pane/PaneFilterBar.tsx`

- [ ] **Step 1: PaneFilterBar 작성**

```tsx
import { useEffect, useRef } from "react";
import { Search, X } from "lucide-react";
import { usePanes, type PaneId } from "@/stores/panes";

/**
 * 패널 빠른 필터 input. PathBar 와 EntryList 사이.
 *
 * - filter 비어있고 unfocused: 컴포넌트 자체 렌더 X (공간 절약, parent 가 결정)
 * - autoFocus: filterFocused 상태 변경 감지하여 input.focus()
 * - ESC: filter clear + filterFocused=false
 * - Enter: filterFocused=false (필터 텍스트 유지) — keyboard nav 가
 *   첫 매칭 항목으로 이미 cursor 이동
 */
export function PaneFilterBar({ id }: { id: PaneId }) {
  const filter = usePanes((s) => s.panes[id].filter);
  const filterFocused = usePanes((s) => s.panes[id].filterFocused);
  const setFilter = usePanes((s) => s.setFilter);
  const setFilterFocused = usePanes((s) => s.setFilterFocused);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (filterFocused) inputRef.current?.focus();
  }, [filterFocused]);

  if (filter.length === 0 && !filterFocused) return null;

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-subtle px-2 text-base">
      <Search size={11} className="shrink-0 text-fg-muted" />
      <input
        ref={inputRef}
        type="text"
        value={filter}
        onChange={(e) => setFilter(id, e.target.value)}
        onFocus={() => setFilterFocused(id, true)}
        onBlur={() => setFilterFocused(id, false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setFilter(id, "");
            setFilterFocused(id, false);
          } else if (e.key === "Enter") {
            e.preventDefault();
            setFilterFocused(id, false);
          }
        }}
        placeholder="Filter…"
        className="flex-1 bg-transparent font-mono text-base focus:outline-none"
      />
      <button
        type="button"
        onClick={() => {
          setFilter(id, "");
          setFilterFocused(id, false);
        }}
        className="rounded p-0.5 text-fg-muted hover:bg-border"
        aria-label="Clear filter"
      >
        <X size={11} />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Pane.tsx 통합**

`src/components/pane/Pane.tsx` 수정 — PathBar 와 EntryList 사이에 PaneFilterBar:

```tsx
import { PathBar } from "./PathBar";
import { PaneFilterBar } from "./PaneFilterBar";
import { EntryList } from "./EntryList";
// ...
      <PathBar ... />
      <PaneFilterBar id={id} />
      <EntryList ... />
```

- [ ] **Step 3: useGlobalShortcuts 에 Ctrl+F 추가**

`src/hooks/useGlobalShortcuts.ts` 의 switch 안에 case 추가 (case "h" 다음):

```ts
case "f":
  if (!isInput) {
    e.preventDefault();
    usePanes.getState().setFilterFocused(usePanes.getState().activePane, true);
  }
  break;
```

- [ ] **Step 4: tsc + lint + test**

Run: `pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3 && pnpm test --run 2>&1 | tail -5`
Expected: clean, all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/components/pane/PaneFilterBar.tsx src/components/pane/Pane.tsx src/hooks/useGlobalShortcuts.ts
git commit -m "fe/ui: PaneFilterBar (Ctrl+F) — 활성 패널 빠른 필터

- PaneFilterBar: PathBar 와 EntryList 사이, filter 비어있고 unfocused 면
  렌더 X. 입력 시 selector 자동 재계산.
- ESC = clear + 포커스 해제, Enter = 포커스 해제 (필터 유지)
- Ctrl+F: 활성 패널의 filterFocused=true → input autoFocus
- input 포커스 시 다른 패널 단축키 (Ctrl+H/R/1..5) 무시"
```

---

## Phase C — 글로벌 검색 (Ctrl+Shift+F)

### Task 6: Backend core/search.rs — trait + LocalFilenameSearch + 단위 테스트

**Files:**
- Create: `src-tauri/src/core/search.rs`
- Modify: `src-tauri/src/core/mod.rs`

- [ ] **Step 1: core/mod.rs 확장**

`src-tauri/src/core/mod.rs` 에 추가 (alphabetic 위치):

```rust
pub mod search;
```

- [ ] **Step 2: search.rs 작성**

`src-tauri/src/core/search.rs`:

```rust
//! 파일명/내용 검색 backend.
//!
//! v1 (MVP-5): 파일명 substring 검색만.
//! - LocalFilenameSearch: `ignore::WalkBuilder` (.gitignore 자동 존중)
//! - SshFilenameSearch: russh exec 채널로 `find -iname` 실행 (Task 7)
//!
//! v2 후속: GrepSearch (ripgrep), result streaming (event 기반).

use crate::types::{DuetError, EntryKind, Location, SourceId};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SearchOpts {
    pub case_sensitive: bool,
    pub include_hidden: bool,
    pub max_results: usize,
}

impl Default for SearchOpts {
    fn default() -> Self {
        Self {
            case_sensitive: false,
            include_hidden: false,
            max_results: 500,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SearchHit {
    /// 항목의 부모 디렉토리 (클릭 시 navigate 대상).
    pub location: Location,
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified_ms: Option<i64>,
}

#[async_trait]
pub trait SearchBackend: Send + Sync {
    async fn search(
        &self,
        root: &Path,
        pattern: &str,
        opts: &SearchOpts,
        cancel: CancellationToken,
    ) -> Result<Vec<SearchHit>, DuetError>;
}

/// 로컬 파일시스템 검색 — `ignore::WalkBuilder` 사용.
pub struct LocalFilenameSearch;

#[async_trait]
impl SearchBackend for LocalFilenameSearch {
    async fn search(
        &self,
        root: &Path,
        pattern: &str,
        opts: &SearchOpts,
        cancel: CancellationToken,
    ) -> Result<Vec<SearchHit>, DuetError> {
        use ignore::WalkBuilder;
        let root = root.to_path_buf();
        let pattern = pattern.to_string();
        let opts = opts.clone();

        tokio::task::spawn_blocking(move || -> Result<Vec<SearchHit>, DuetError> {
            let walker = WalkBuilder::new(&root)
                .hidden(!opts.include_hidden)
                .git_ignore(true)
                .git_exclude(true)
                .build();
            let mut hits = Vec::new();
            for entry in walker {
                if cancel.is_cancelled() {
                    return Err(DuetError::Cancelled);
                }
                if hits.len() >= opts.max_results {
                    break;
                }
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue, // permission denied 등 skip
                };
                let path = entry.path();
                if path == root {
                    continue; // root 자신은 skip
                }
                let name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if !matches_substring(&name, &pattern, opts.case_sensitive) {
                    continue;
                }
                let parent = match path.parent() {
                    Some(p) => p.to_path_buf(),
                    None => continue,
                };
                let meta = entry.metadata().ok();
                let kind = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    EntryKind::Dir
                } else if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
                    EntryKind::Symlink
                } else if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    EntryKind::File
                } else {
                    EntryKind::Other
                };
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified_ms = meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64);
                hits.push(SearchHit {
                    location: Location {
                        source: SourceId::Local,
                        path: parent,
                    },
                    name,
                    kind,
                    size,
                    modified_ms,
                });
            }
            Ok(hits)
        })
        .await
        .map_err(|e| DuetError::Io(format!("search join: {e}")))?
    }
}

fn matches_substring(name: &str, pattern: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        name.contains(pattern)
    } else {
        name.to_lowercase().contains(&pattern.to_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;
    use tokio_util::sync::CancellationToken;

    fn write_file(dir: &Path, name: &str) {
        fs::write(dir.join(name), b"x").unwrap();
    }

    #[tokio::test]
    async fn local_filename_basic_match() {
        let dir = tempdir().unwrap();
        write_file(dir.path(), "alpha.txt");
        write_file(dir.path(), "beta.md");
        write_file(dir.path(), "gamma_alpha.rs");
        let s = LocalFilenameSearch;
        let hits = s
            .search(
                dir.path(),
                "alpha",
                &SearchOpts::default(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"alpha.txt"));
        assert!(names.contains(&"gamma_alpha.rs"));
        assert!(!names.contains(&"beta.md"));
    }

    #[tokio::test]
    async fn local_filename_case_insensitive_default() {
        let dir = tempdir().unwrap();
        write_file(dir.path(), "ALPHA.txt");
        let s = LocalFilenameSearch;
        let hits = s
            .search(
                dir.path(),
                "alpha",
                &SearchOpts::default(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[tokio::test]
    async fn local_filename_case_sensitive_opt() {
        let dir = tempdir().unwrap();
        write_file(dir.path(), "ALPHA.txt");
        write_file(dir.path(), "alpha.txt");
        let s = LocalFilenameSearch;
        let hits = s
            .search(
                dir.path(),
                "alpha",
                &SearchOpts {
                    case_sensitive: true,
                    ..SearchOpts::default()
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, vec!["alpha.txt"]);
    }

    #[tokio::test]
    async fn local_hidden_excluded_by_default() {
        let dir = tempdir().unwrap();
        write_file(dir.path(), ".hidden_alpha");
        write_file(dir.path(), "visible_alpha");
        let s = LocalFilenameSearch;
        let hits = s
            .search(
                dir.path(),
                "alpha",
                &SearchOpts::default(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, vec!["visible_alpha"]);
    }

    #[tokio::test]
    async fn local_hidden_included_with_opt() {
        let dir = tempdir().unwrap();
        write_file(dir.path(), ".hidden_alpha");
        write_file(dir.path(), "visible_alpha");
        let s = LocalFilenameSearch;
        let hits = s
            .search(
                dir.path(),
                "alpha",
                &SearchOpts {
                    include_hidden: true,
                    ..SearchOpts::default()
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[tokio::test]
    async fn local_max_results_caps() {
        let dir = tempdir().unwrap();
        for i in 0..20 {
            write_file(dir.path(), &format!("alpha_{i}"));
        }
        let s = LocalFilenameSearch;
        let hits = s
            .search(
                dir.path(),
                "alpha",
                &SearchOpts {
                    max_results: 5,
                    ..SearchOpts::default()
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(hits.len(), 5);
    }

    #[tokio::test]
    async fn local_cancel_returns_err() {
        let dir = tempdir().unwrap();
        for i in 0..1000 {
            write_file(dir.path(), &format!("alpha_{i}"));
        }
        let cancel = CancellationToken::new();
        cancel.cancel();
        let s = LocalFilenameSearch;
        let res = s
            .search(
                dir.path(),
                "alpha",
                &SearchOpts::default(),
                cancel,
            )
            .await;
        assert!(matches!(res, Err(DuetError::Cancelled)));
    }
}
```

- [ ] **Step 3: cargo check + test**

Run:
```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo check --lib --tests 2>&1 | tail -5
cargo test --lib core::search 2>&1 | tail -5
```
Expected: 7 unit tests pass

- [ ] **Step 4: clippy**

Run: `cargo clippy --lib --tests -- -D warnings 2>&1 | tail -5`
Expected: clean

- [ ] **Step 5: Commit**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/core/search.rs src-tauri/src/core/mod.rs
git commit -m "be/core: search trait + LocalFilenameSearch (ignore crate)

- SearchBackend async trait, SearchOpts (case_sensitive/include_hidden/
  max_results), SearchHit (location=parent, name, kind, size, modified_ms)
- LocalFilenameSearch: ignore::WalkBuilder, .gitignore 자동 존중,
  spawn_blocking 으로 async wrap. 항목 단위 cancel check.
- 7 unit tests: 기본 매칭, case sensitivity, hidden 옵션, max_results cap,
  cancel"
```

---

### Task 7: Backend SshFilenameSearch — `find` exec via russh

**Files:**
- Modify: `src-tauri/src/core/search.rs`

- [ ] **Step 1: SshFilenameSearch impl 추가**

`src-tauri/src/core/search.rs` 끝에 (tests 모듈 앞에) 추가:

```rust
/// SSH 호스트의 `find` 명령으로 파일명 검색.
/// pattern 은 shell-escape 후 `-iname '*<p>*'` 로 사용.
pub struct SshFilenameSearch {
    pub conn: std::sync::Arc<crate::services::connection_pool::ActiveConnection>,
}

#[async_trait]
impl SearchBackend for SshFilenameSearch {
    async fn search(
        &self,
        root: &Path,
        pattern: &str,
        opts: &SearchOpts,
        cancel: CancellationToken,
    ) -> Result<Vec<SearchHit>, DuetError> {
        use crate::core::copy_strategy::shell_escape_path;
        use crate::ssh::remote_exec::exec;

        let root_arg = shell_escape_path(root)?;
        let pat_escaped = pattern.replace('\\', "\\\\").replace('\'', "\\'");
        // case insensitive 면 -iname, sensitive 면 -name
        let name_flag = if opts.case_sensitive { "-name" } else { "-iname" };
        let hidden_clause = if opts.include_hidden {
            ""
        } else {
            r"-not -path '*/.*'"
        };
        let cmd = format!(
            "find {root_arg} {hidden_clause} \\( -type f -o -type d -o -type l \\) {name_flag} '*{pat_escaped}*' 2>/dev/null | head -n {max}",
            max = opts.max_results
        );

        let session_mutex = self
            .conn
            .session
            .as_ref()
            .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;
        if cancel.is_cancelled() {
            return Err(DuetError::Cancelled);
        }
        let result = {
            let handle = session_mutex.lock().await;
            exec(&handle, &cmd).await?
        };
        if cancel.is_cancelled() {
            return Err(DuetError::Cancelled);
        }
        let stdout = String::from_utf8_lossy(&result.stdout);
        let conn_id = self.conn.id.clone();
        let hits = parse_find_output(&stdout, &conn_id, self.conn.host_ip, &self.conn.user);
        Ok(hits)
    }
}

/// `find` stdout 라인을 SearchHit 으로. 절대경로 한 줄 = 한 항목.
/// metadata (size/mtime) 는 별도 stat 비용 비싸 placeholder (0/None).
pub fn parse_find_output(
    stdout: &str,
    conn_id: &crate::types::ConnectionId,
    host_ip: std::net::IpAddr,
    user: &str,
) -> Vec<SearchHit> {
    stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let path = PathBuf::from(line);
            let name = path.file_name().and_then(|n| n.to_str())?.to_string();
            let parent = path.parent()?.to_path_buf();
            Some(SearchHit {
                location: Location {
                    source: SourceId::Ssh {
                        connection_id: conn_id.clone(),
                        host_ip,
                        user: user.to_string(),
                    },
                    path: parent,
                },
                name,
                // find 는 type 정보 stdout 에 없음 — file 가정 (UI 가 클릭 후
                // navigate 시 backend metadata 가 진짜 kind 결정)
                kind: EntryKind::File,
                size: 0,
                modified_ms: None,
            })
        })
        .collect()
}
```

- [ ] **Step 2: parse_find_output 테스트 추가**

`src-tauri/src/core/search.rs` tests 모듈 안에 추가:

```rust
#[test]
fn parse_find_basic() {
    use std::net::Ipv4Addr;
    let conn_id = crate::types::ConnectionId("test".into());
    let ip = std::net::IpAddr::V4(Ipv4Addr::new(192, 168, 0, 1));
    let stdout = "/home/u/alpha.txt\n/home/u/sub/beta.md\n\n/home/u/gamma.rs\n";
    let hits = parse_find_output(stdout, &conn_id, ip, "u");
    assert_eq!(hits.len(), 3);
    assert_eq!(hits[0].name, "alpha.txt");
    assert_eq!(hits[0].location.path, std::path::PathBuf::from("/home/u"));
    assert_eq!(hits[1].name, "beta.md");
    assert_eq!(hits[1].location.path, std::path::PathBuf::from("/home/u/sub"));
}

#[test]
fn parse_find_skips_empty_lines() {
    use std::net::Ipv4Addr;
    let conn_id = crate::types::ConnectionId("t".into());
    let ip = std::net::IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
    let stdout = "\n\n\n";
    let hits = parse_find_output(stdout, &conn_id, ip, "x");
    assert_eq!(hits.len(), 0);
}
```

- [ ] **Step 3: cargo check + test + clippy**

Run:
```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo check --lib --tests 2>&1 | tail -5
cargo test --lib core::search 2>&1 | tail -5
cargo clippy --lib --tests -- -D warnings 2>&1 | tail -5
```
Expected: 9 tests pass (7 local + 2 parser), clippy clean

- [ ] **Step 4: Commit**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/core/search.rs
git commit -m "be/core: SshFilenameSearch — find exec via russh

- SshFilenameSearch: ConnectionPool ActiveConnection 받아 find 실행.
  shell_escape_path + 패턴 quote (\\, ' escape).
- find -iname '*<pat>*' (-name if case_sensitive), -not -path '*/.*'
  (hidden 제외 default), | head -n max_results
- parse_find_output: stdout 라인 → SearchHit. parent path 추출, kind 는
  File placeholder (UI 가 navigate 시 backend 가 진짜 kind 결정).
- size/mtime 은 0/None placeholder — find 호출 1회 비용 우선, stat 비용 회피.
- 2 추가 테스트 (parse 기본 + 빈줄 skip)"
```

---

### Task 8: Backend commands/search.rs — IPC + 활성 토큰 관리

**Files:**
- Create: `src-tauri/src/commands/search.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: commands/mod.rs 확장**

`src-tauri/src/commands/mod.rs` 에 `pub mod search;` 추가 (alphabetic).

- [ ] **Step 2: commands/search.rs 작성**

```rust
//! 글로벌 검색 IPC.
//!
//! 활성 검색은 한 번에 하나만. 새 검색 시작 시 이전 토큰 cancel.
//! `search_cancel` 도 같은 토큰 cancel.

use std::sync::Arc;

use crate::core::search::{LocalFilenameSearch, SearchBackend, SearchHit, SearchOpts, SshFilenameSearch};
use crate::services::connection_pool::ConnectionPool;
use crate::types::{DuetError, Location, SourceId};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// 활성 검색 토큰 — 새 검색 또는 cancel 시 이전 토큰 cancel.
#[derive(Default)]
pub struct ActiveSearch {
    token: Mutex<Option<CancellationToken>>,
}

impl ActiveSearch {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 이전 토큰 cancel + 새 토큰 발급. 반환된 토큰을 backend 에 전달.
    async fn rotate(&self) -> CancellationToken {
        let mut guard = self.token.lock().await;
        if let Some(prev) = guard.take() {
            prev.cancel();
        }
        let new = CancellationToken::new();
        *guard = Some(new.clone());
        new
    }

    async fn cancel_current(&self) {
        let mut guard = self.token.lock().await;
        if let Some(tok) = guard.take() {
            tok.cancel();
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn search_global(
    root: Location,
    pattern: String,
    opts: SearchOpts,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    active: tauri::State<'_, Arc<ActiveSearch>>,
) -> Result<Vec<SearchHit>, DuetError> {
    if pattern.trim().is_empty() {
        return Ok(vec![]);
    }
    let cancel = active.inner().rotate().await;
    match &root.source {
        SourceId::Local => {
            let backend = LocalFilenameSearch;
            backend.search(&root.path, &pattern, &opts, cancel).await
        }
        SourceId::Ssh { connection_id, .. } => {
            let conn = pool.inner().get(connection_id).await?;
            let backend = SshFilenameSearch { conn };
            backend.search(&root.path, &pattern, &opts, cancel).await
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn search_cancel(
    active: tauri::State<'_, Arc<ActiveSearch>>,
) -> Result<(), DuetError> {
    active.inner().cancel_current().await;
    Ok(())
}
```

- [ ] **Step 3: lib.rs 등록**

`src-tauri/src/lib.rs` 변경:

A. `collect_commands![]` 에 추가 (saved_hosts/secret_vault 와 settings 사이):

```rust
commands::search::search_global,
commands::search::search_cancel,
```

B. `run()` 의 setup 안에 ActiveSearch manage:

```rust
let active_search = commands::search::ActiveSearch::new();
app.manage(active_search);
```

(`task_queue` 옆에. setup 밖 .manage 도 가능 — 일관성 위해 setup.)

- [ ] **Step 4: cargo check + clippy**

Run:
```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo check --lib --tests --bins 2>&1 | tail -5
cargo clippy --lib --tests --bins -- -D warnings 2>&1 | tail -5
```
Expected: clean (no new tests added — IPC 는 smoke 에서)

- [ ] **Step 5: Commit**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/commands/search.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "be/cmd: search_global + search_cancel IPC

- ActiveSearch: Mutex<Option<CancellationToken>>. rotate() 가 이전 토큰
  cancel + 새 토큰 발급. 활성 검색 한 번에 하나.
- search_global(root: Location, pattern, opts): SourceId 분기 →
  LocalFilenameSearch 또는 SshFilenameSearch 실행. 빈 패턴은 즉시 [].
- search_cancel(): 활성 토큰 cancel.
- lib.rs: 2 commands 등록 + ActiveSearch State manage in setup"
```

---

### Task 9: Backend tests/mvp5_search_smoke.rs

**Files:**
- Create: `src-tauri/tests/mvp5_search_smoke.rs`

- [ ] **Step 1: smoke 작성**

```rust
//! MVP-5 search smoke — local 트리 walk + find 파서.

use duet_lib::core::search::{
    parse_find_output, LocalFilenameSearch, SearchBackend, SearchOpts,
};
use duet_lib::types::{ConnectionId, EntryKind, SourceId};
use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn smoke_local_finds_in_subdirs() {
    let dir = tempdir().unwrap();
    let sub = dir.path().join("subdir");
    fs::create_dir(&sub).unwrap();
    fs::write(dir.path().join("alpha.txt"), b"x").unwrap();
    fs::write(sub.join("alpha_inner.md"), b"x").unwrap();
    fs::write(dir.path().join("beta.txt"), b"x").unwrap();

    let backend = LocalFilenameSearch;
    let hits = backend
        .search(
            dir.path(),
            "alpha",
            &SearchOpts::default(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
    assert!(names.contains(&"alpha.txt"));
    assert!(names.contains(&"alpha_inner.md"));
    assert!(!names.contains(&"beta.txt"));
}

#[tokio::test]
async fn smoke_local_max_results_cap() {
    let dir = tempdir().unwrap();
    for i in 0..50 {
        fs::write(dir.path().join(format!("alpha_{i}")), b"x").unwrap();
    }
    let backend = LocalFilenameSearch;
    let hits = backend
        .search(
            dir.path(),
            "alpha",
            &SearchOpts {
                max_results: 10,
                ..SearchOpts::default()
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(hits.len(), 10);
}

#[test]
fn smoke_parse_find_output_ssh_shape() {
    let conn_id = ConnectionId("conn-1".into());
    let ip = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5));
    let stdout = "/var/log/syslog\n/var/log/auth.log\n";
    let hits = parse_find_output(&stdout, &conn_id, ip, "user1");
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].name, "syslog");
    assert_eq!(hits[0].location.path, PathBuf::from("/var/log"));
    match &hits[0].location.source {
        SourceId::Ssh {
            connection_id,
            host_ip,
            user,
        } => {
            assert_eq!(connection_id.0, "conn-1");
            assert_eq!(*host_ip, ip);
            assert_eq!(user, "user1");
        }
        _ => panic!("expected Ssh"),
    }
    assert_eq!(hits[0].kind, EntryKind::File);
}
```

- [ ] **Step 2: 테스트 실행**

Run:
```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo test --test mvp5_search_smoke 2>&1 | tail -5
```
Expected: 3 tests pass

- [ ] **Step 3: Commit**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/tests/mvp5_search_smoke.rs
git commit -m "test/smoke: MVP-5 search — local tree + find parser

- smoke_local_finds_in_subdirs: 서브디렉토리 재귀 매칭
- smoke_local_max_results_cap: max_results 제한 동작
- smoke_parse_find_output_ssh_shape: SSH find stdout → SearchHit 변환,
  SourceId::Ssh 형태 검증"
```

---

### Task 10: Frontend stores/search.ts + 단위 테스트

**Files:**
- Create: `src/stores/search.ts`
- Create: `src/stores/search.test.ts`

- [ ] **Step 1: search.test.ts 작성**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSearch } from "./search";

describe("search store", () => {
  beforeEach(() => {
    useSearch.setState({
      isOpen: false,
      rootPaneId: null,
      root: null,
      query: "",
      results: [],
      status: "idle",
      error: null,
    });
  });

  it("open sets isOpen + root", () => {
    useSearch.getState().open("left", { source: { kind: "local" }, path: "/" });
    expect(useSearch.getState().isOpen).toBe(true);
    expect(useSearch.getState().rootPaneId).toBe("left");
    expect(useSearch.getState().root?.path).toBe("/");
  });

  it("close resets state", () => {
    useSearch.getState().open("left", { source: { kind: "local" }, path: "/" });
    useSearch.getState().setQueryNow("foo");
    useSearch.getState().setResults([]);
    useSearch.getState().close();
    expect(useSearch.getState().isOpen).toBe(false);
    expect(useSearch.getState().query).toBe("");
    expect(useSearch.getState().results.length).toBe(0);
  });

  it("setStatus updates status", () => {
    useSearch.getState().setStatus("searching");
    expect(useSearch.getState().status).toBe("searching");
    useSearch.getState().setStatus("done");
    expect(useSearch.getState().status).toBe("done");
  });

  it("setError stores error message + status=error", () => {
    useSearch.getState().setError("network down");
    expect(useSearch.getState().error).toBe("network down");
    expect(useSearch.getState().status).toBe("error");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test --run src/stores/search.test.ts 2>&1 | tail -10`
Expected: FAIL — module not found

- [ ] **Step 3: search.ts 작성**

```ts
import { create } from "zustand";
import type { Location, SearchHit } from "@/types/bindings";
import type { PaneId } from "./panes";

export type SearchStatus = "idle" | "searching" | "done" | "error" | "cancelled";

interface SearchState {
  isOpen: boolean;
  rootPaneId: PaneId | null;
  root: Location | null;
  query: string;
  results: SearchHit[];
  status: SearchStatus;
  error: string | null;

  open: (paneId: PaneId, root: Location) => void;
  close: () => void;
  /** input 의 onChange 직접 호출 — 실제 IPC 발사는 useSearchEffect 가 debounce. */
  setQueryNow: (q: string) => void;
  setResults: (hits: SearchHit[]) => void;
  setStatus: (s: SearchStatus) => void;
  setError: (msg: string) => void;
}

export const useSearch = create<SearchState>((set) => ({
  isOpen: false,
  rootPaneId: null,
  root: null,
  query: "",
  results: [],
  status: "idle",
  error: null,

  open: (paneId, root) =>
    set({ isOpen: true, rootPaneId: paneId, root, query: "", results: [], status: "idle", error: null }),
  close: () =>
    set({ isOpen: false, rootPaneId: null, root: null, query: "", results: [], status: "idle", error: null }),
  setQueryNow: (q) => set({ query: q }),
  setResults: (hits) => set({ results: hits, status: "done", error: null }),
  setStatus: (s) => set({ status: s }),
  setError: (msg) => set({ error: msg, status: "error" }),
}));
```

- [ ] **Step 4: 테스트 통과 + tsc**

Run:
```bash
pnpm test --run src/stores/search.test.ts 2>&1 | tail -5
pnpm tsc --noEmit 2>&1 | tail -3
```
Expected: 4 tests pass, tsc clean

- [ ] **Step 5: Commit**

```bash
git add src/stores/search.ts src/stores/search.test.ts
git commit -m "fe/store: search store — open/close/results/status

- isOpen, rootPaneId, root: Location, query, results: SearchHit[],
  status (idle/searching/done/error/cancelled), error
- open(paneId, root) / close() / setQueryNow / setResults / setStatus / setError
- 실제 debounced IPC 호출은 SearchPanel 컴포넌트 useEffect 에서 (Task 11)
- 4 vitest pass"
```

---

### Task 11: SearchPanel 컴포넌트

**Files:**
- Create: `src/components/SearchPanel.tsx`

- [ ] **Step 1: SearchPanel 작성**

```tsx
import { useEffect, useRef } from "react";
import { Loader, Search, X } from "lucide-react";
import { commands } from "@/types/bindings";
import type { SearchHit } from "@/types/bindings";
import { useSearch } from "@/stores/search";

/**
 * 글로벌 검색 결과 패널. <header> 와 <main>{panes}</main> 사이.
 *
 * - 입력창 autoFocus, 200ms debounce 후 commands.searchGlobal 호출
 * - 결과 클릭 → onPickHit 콜백 (App 이 navigate + 패널 cursor 이동)
 * - ESC = close
 * - 패턴 < 2자: "최소 2자" 안내 (서버 부하 방지)
 */
export function SearchPanel({
  onPickHit,
}: {
  onPickHit: (hit: SearchHit) => void;
}) {
  const isOpen = useSearch((s) => s.isOpen);
  const root = useSearch((s) => s.root);
  const query = useSearch((s) => s.query);
  const results = useSearch((s) => s.results);
  const status = useSearch((s) => s.status);
  const error = useSearch((s) => s.error);
  const setQueryNow = useSearch((s) => s.setQueryNow);
  const setResults = useSearch((s) => s.setResults);
  const setStatus = useSearch((s) => s.setStatus);
  const setError = useSearch((s) => s.setError);
  const close = useSearch((s) => s.close);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // debounce 200ms — query 또는 root 변경 시 IPC.
  useEffect(() => {
    if (!isOpen || !root) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setStatus("idle");
      return;
    }
    setStatus("searching");
    const t = setTimeout(() => {
      void (async () => {
        const r = await commands.searchGlobal(root, trimmed, {
          case_sensitive: false,
          include_hidden: false,
          max_results: 500,
        });
        if (r.status === "ok") setResults(r.data);
        else setError(r.error.kind);
      })();
    }, 200);
    return () => clearTimeout(t);
  }, [isOpen, root, query, setResults, setStatus, setError]);

  if (!isOpen) return null;

  return (
    <div className="border-b border-border bg-subtle">
      <div className="flex h-8 items-center gap-2 px-3 text-base">
        <Search size={12} className="shrink-0 text-fg-muted" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQueryNow(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "Enter" && results[0]) {
              e.preventDefault();
              onPickHit(results[0]);
            }
          }}
          placeholder="Search filenames…"
          className="flex-1 bg-transparent font-mono focus:outline-none"
        />
        {status === "searching" && (
          <Loader size={12} className="shrink-0 animate-spin text-fg-muted" />
        )}
        <span className="shrink-0 text-meta text-fg-muted">
          {query.trim().length < 2 ? "min 2 chars" : `${results.length} hits`}
        </span>
        <button
          type="button"
          onClick={close}
          className="rounded p-0.5 text-fg-muted hover:bg-border"
          aria-label="Close search"
        >
          <X size={12} />
        </button>
      </div>
      {error && (
        <div className="border-t border-border px-3 py-1 text-meta text-danger">
          {error}
        </div>
      )}
      {results.length > 0 && (
        <div className="max-h-64 overflow-auto border-t border-border">
          {results.map((hit) => (
            <button
              key={`${hit.location.path}/${hit.name}`}
              type="button"
              onClick={() => onPickHit(hit)}
              className="flex w-full items-center gap-2 px-3 py-1 text-left text-base hover:bg-border"
            >
              <span className="font-mono">{hit.name}</span>
              <span className="ml-auto truncate text-meta text-fg-muted">
                {hit.location.path}
              </span>
            </button>
          ))}
          {results.length >= 500 && (
            <div className="px-3 py-1 text-meta text-fg-muted">
              showing 500 — refine query for more
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: tsc**

Run: `pnpm tsc --noEmit 2>&1 | tail -3`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/components/SearchPanel.tsx
git commit -m "fe/ui: SearchPanel — 글로벌 검색 입력 + 결과 리스트

- isOpen 시 렌더, 입력 autoFocus, 200ms debounce 후 commands.searchGlobal
- 패턴 < 2자: 'min 2 chars' (서버 부하 방지)
- 결과 클릭 → onPickHit(hit) 콜백 (App 이 navigate + cursor 이동 처리)
- ESC = close, Enter = 첫 결과 선택
- 500 cap 도달 시 'showing 500 — refine' 안내"
```

---

### Task 12: useGlobalShortcuts Ctrl+Shift+F + App 통합

**Files:**
- Modify: `src/hooks/useGlobalShortcuts.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: useGlobalShortcuts 에 Ctrl+Shift+F 추가**

`src/hooks/useGlobalShortcuts.ts` 수정 — switch 안에 case 추가 (case "f" 옆):

기존 case "f" 를 다음과 같이 변경:

```ts
case "f":
  if (isInput) break;
  e.preventDefault();
  if (e.shiftKey) {
    // Ctrl+Shift+F: 글로벌 검색 — 활성 패널의 location 을 root 로
    const active = usePanes.getState().activePane;
    const root = usePanes.getState().panes[active].location;
    useSearch.getState().open(active, root);
  } else {
    // Ctrl+F: 활성 패널 빠른 필터
    usePanes.getState().setFilterFocused(usePanes.getState().activePane, true);
  }
  break;
```

import 추가:
```ts
import { useSearch } from "@/stores/search";
```

- [ ] **Step 2: App.tsx 통합**

`src/App.tsx`:

A. import 추가:
```tsx
import { SearchPanel } from "@/components/SearchPanel";
import { useSearch } from "@/stores/search";
import type { SearchHit } from "@/types/bindings";
```

B. SearchPanel hit 클릭 핸들러:

```tsx
const onPickHit = useCallback(
  (hit: SearchHit) => {
    const rootPaneId = useSearch.getState().rootPaneId;
    if (!rootPaneId) return;
    void (async () => {
      // hit.location 으로 navigate (이미 SourceId 동일)
      await navigate(rootPaneId, hit.location.path);
      // navigate 이후 entries 가 set 됨 — cursor 를 hit.name 위치로
      const pane = usePanes.getState().panes[rootPaneId];
      const idx = pane.entries.findIndex((e) => e.name === hit.name);
      if (idx >= 0) usePanes.getState().setCursor(rootPaneId, idx);
      useSearch.getState().close();
    })();
  },
  [navigate],
);
```

C. SearchPanel 렌더 위치 — `<header>` 와 `<main>` 사이:

```tsx
<header>...</header>
<SearchPanel onPickHit={onPickHit} />
<main className="flex flex-1 min-h-0 gap-0">
```

- [ ] **Step 3: tsc + lint + 모든 테스트**

Run:
```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
pnpm tsc --noEmit 2>&1 | tail -3
pnpm lint 2>&1 | tail -3
pnpm test --run 2>&1 | tail -5
```
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useGlobalShortcuts.ts src/App.tsx
git commit -m "fe: Ctrl+Shift+F 글로벌 검색 + App SearchPanel 통합

- useGlobalShortcuts: Ctrl+Shift+F = useSearch.open(activePane, root),
  Ctrl+F = filter (분기 e.shiftKey)
- App.tsx: SearchPanel 렌더 (header 와 main 사이), onPickHit:
  navigate(rootPaneId, hit.location.path) + cursor 를 hit.name 위치로,
  search.close()"
```

---

## Phase D — 마무리

### Task 13: ROADMAP MVP-5 완료 표시 + final gates

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: 모든 게이트 실행**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo fmt --check 2>&1 | tail -3
cargo clippy --all-targets -- -D warnings 2>&1 | tail -3
cargo test --lib 2>&1 | tail -3
cargo test --tests 2>&1 | tail -10

cd /Users/ctmctm/Desktop/01_PROJECT/duet
pnpm tsc --noEmit 2>&1 | tail -3
pnpm lint 2>&1 | tail -3
pnpm test --run 2>&1 | tail -5
```
Expected: 전부 pass

- [ ] **Step 2: ROADMAP.md 갱신**

찾기:
```markdown
## MVP-5: 검색과 정렬

- [ ] 빠른 필터 (Ctrl+F, 현재 패널 내)
- [ ] 정렬 (이름/크기/날짜/타입), 컬럼 헤더 클릭
- [ ] 숨김 토글 (Ctrl+H)
- [ ] 새로고침 (Ctrl+R)
- [ ] 글로벌 검색 (Ctrl+Shift+F)
  - 로컬: `ignore` crate
  - 원격: SSH 통해 ripgrep 또는 find
```

대체:
```markdown
## MVP-5: 검색과 정렬

- [x] 빠른 필터 (Ctrl+F, 현재 패널 내) — substring case-insensitive
- [x] 정렬 (이름/크기/날짜/타입/확장자), 컬럼 헤더 클릭 / Ctrl+1..5
- [x] 숨김 토글 (Ctrl+H) — dotfiles 디폴트 숨김
- [x] 새로고침 (Ctrl+R / F5)
- [x] 글로벌 검색 (Ctrl+Shift+F) — **파일명 only** v1
  - 로컬: `ignore` crate (`.gitignore` 자동 존중)
  - 원격: SSH `find -iname` exec
  - 내용 검색 (grep) 은 후속 (SearchBackend trait 확장 가능)
```

찾기 (현재 단계):
```markdown
**MVP-5 시작 직전.** ...
```

대체:
```markdown
**MVP-6 시작 직전.** MVP-5 완료 — 정렬/숨김/필터/새로고침 + 글로벌 파일명 검색 (local: ignore, ssh: find).
```

- [ ] **Step 3: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: MVP-5 완료 표시"
```

---

## 자기 점검

**Spec 커버리지:**

| Spec section | Task |
|---|---|
| A. PaneState sort/hidden + selector | 1 |
| A. EntryList 컬럼 헤더 + 화살표 | 2 |
| A. Ctrl+H/R/F5/1..5 단축키 | 3 |
| A. Pane uses selector + App.sortEntries 제거 | 4 |
| B. PaneState filter/filterFocused (selector 도) | 1 (포함 — 같은 store) |
| B. PaneFilterBar + Ctrl+F + 자동 clear (navigate 시) | 1 (clear 는 setEntries 안), 5 |
| C. SearchBackend trait + LocalFilenameSearch | 6 |
| C. SshFilenameSearch + parse_find_output | 7 |
| C. search_global / search_cancel IPC + ActiveSearch | 8 |
| C. mvp5 search smoke | 9 |
| C. stores/search.ts | 10 |
| C. SearchPanel | 11 |
| C. Ctrl+Shift+F + App 통합 | 12 |
| 마무리 ROADMAP | 13 |

**Placeholder scan:** 없음. 모든 step 에 실제 코드 + 명령.

**Type consistency:**
- `SortKey` / `SortOrder`: panes.ts 에서 export, EntryList/useGlobalShortcuts/Pane 에서 import. 일치.
- `SearchOpts` / `SearchHit`: backend (search.rs) Type derive, frontend bindings.ts 에서 자동 import. 일치.
- `useSearch.open(paneId, root)`: search.ts 와 useGlobalShortcuts/App 사용처 일치.
- `selectDisplayedEntries(id, state)`: panes.ts export, Pane.tsx 사용 일치.

---

## 실행 핸드오프

Plan complete and saved to `docs/plans/2026-05-10-mvp5-search-and-sort.md`.

**두 가지 실행 옵션:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec → code quality), 빠른 iteration

**2. Inline Execution** — 이 세션에서 task batch 실행, checkpoint 마다 사용자 확인

어느 방식?
