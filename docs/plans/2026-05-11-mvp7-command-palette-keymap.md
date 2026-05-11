# MVP-7 Command Palette + Keymap + Aliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ctrl+P 커맨드 팔레트 (fuzzy 검색), keymap.toml 외부 편집 가능한 hot reload 키맵, 사용자 정의 navigation alias, 설정 GUI 섹션화.

**Architecture:** Command 객체를 단일 registry (`useCommands`) 로 통합. 모든 단축키 처리는 keymap (`stores/keymap`) lookup → command action 호출. 팔레트도 같은 registry 사용. keymap.toml 은 backend `notify` watcher 로 hot reload, `KeymapChangedEvent` 로 frontend 갱신. user aliases 는 SavedHostsStore 패턴 (RwLock + JSON file).

**Tech Stack:** zustand stores, Tauri specta IPC + events, `notify` crate (이미 deps), TOML (keymap), JSON (aliases).

**Spec:** `docs/specs/2026-05-11-mvp7-command-palette-keymap-design.md`

---

## File Structure

### Phase A — Registry + Palette + fuzzy

| File | Change |
|---|---|
| `src/lib/commands.ts` | Create — `Command` type, `buildBuiltins(deps)` |
| `src/lib/fuzzy.ts` | Create — `fuzzyScore(query, text): number \| null` |
| `src/lib/fuzzy.test.ts` | Create |
| `src/lib/keyEvent.ts` | Create — `formatKeyEvent(e: KeyboardEvent): string \| null` |
| `src/lib/keyEvent.test.ts` | Create |
| `src/stores/commands.ts` | Create — useCommands + useAllCommands |
| `src/stores/palette.ts` | Create — useUIPalette `{ isOpen, open, close }` |
| `src/components/CommandPalette.tsx` | Create |
| `src/App.tsx` | Modify — buildBuiltins + Palette 모달 + 임시 Ctrl+P 단축키 |
| `src/hooks/useGlobalShortcuts.ts` | Modify (임시) — Ctrl+P case 추가 (T14 에서 완전 리팩터) |

### Phase B — Dynamic Providers + User Aliases

| File | Change |
|---|---|
| `src-tauri/src/services/user_aliases.rs` | Create |
| `src-tauri/src/services/mod.rs` | Modify — `pub mod user_aliases;` |
| `src-tauri/src/commands/user_aliases.rs` | Create — 3 IPC |
| `src-tauri/src/commands/mod.rs` | Modify |
| `src-tauri/src/lib.rs` | Modify — 3 commands + manage |
| `src-tauri/tests/mvp7_user_aliases_smoke.rs` | Create |
| `src/stores/userAliases.ts` | Create |
| `src/lib/dynamicCommands.ts` | Create — useDynamicCommands hook |
| `src/App.tsx` | Modify — useDynamicCommands 호출 + onAliasExecute callback |

### Phase C — Keymap externalization + Hot reload

| File | Change |
|---|---|
| `src-tauri/src/services/keymap.rs` | Create — KeymapStore + TOML serde |
| `src-tauri/src/services/keymap_events.rs` | Create — KeymapChangedEvent |
| `src-tauri/src/services/mod.rs` | Modify |
| `src-tauri/src/services/keymap_watcher.rs` | Create — notify watcher 시작 |
| `src-tauri/src/commands/keymap.rs` | Create — 4 IPC |
| `src-tauri/src/commands/mod.rs` | Modify |
| `src-tauri/src/lib.rs` | Modify — 4 commands + 1 event + manage + setup watcher |
| `src-tauri/tests/mvp7_keymap_smoke.rs` | Create |
| `src/stores/keymap.ts` | Create — useKeymap + effectiveKey |
| `src/hooks/useKeymapEvents.ts` | Create — bootstrap + listen |
| `src/hooks/useGlobalShortcuts.ts` | Modify — 완전 리팩터 (keymap + commands lookup) |
| `src/App.tsx` | Modify — useKeymapEvents 호출 |

### Phase D — Settings GUI sections

| File | Change |
|---|---|
| `src/components/SettingsDialog.tsx` | Modify — sidebar + content layout |
| `src/components/settings/GeneralSection.tsx` | Create |
| `src/components/settings/KeymapSection.tsx` | Create |
| `src/components/settings/AliasesSection.tsx` | Create |
| `src-tauri/src/commands/system.rs` | Modify — `open_in_editor(path: PathBuf)` IPC 추가 |
| `src-tauri/src/lib.rs` | Modify — 1 command |

### Phase E — 마무리

| File | Change |
|---|---|
| `ROADMAP.md` | Modify — MVP-7 [x] |

---

## Phase A — Command Registry + Palette + fuzzy

### Task 1: lib/keyEvent.ts — formatKeyEvent + tests

**Files:**
- Create: `src/lib/keyEvent.ts`
- Create: `src/lib/keyEvent.test.ts`

키 입력 정규화. 모든 후속 task 의 기반.

- [ ] **Step 1: keyEvent.test.ts 작성**

```ts
import { describe, it, expect } from "vitest";
import { formatKeyEvent } from "./keyEvent";

function mkEvent(opts: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...opts,
  } as KeyboardEvent;
}

describe("formatKeyEvent", () => {
  it("plain letter", () => {
    expect(formatKeyEvent(mkEvent({ key: "a" }))).toBe("A");
  });

  it("Ctrl+T", () => {
    expect(formatKeyEvent(mkEvent({ key: "t", ctrlKey: true }))).toBe("Ctrl+T");
  });

  it("metaKey treated as Ctrl (cross-platform)", () => {
    expect(formatKeyEvent(mkEvent({ key: "t", metaKey: true }))).toBe("Ctrl+T");
  });

  it("Ctrl+Shift+F", () => {
    expect(formatKeyEvent(mkEvent({ key: "f", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+F");
  });

  it("Alt+ArrowLeft", () => {
    expect(formatKeyEvent(mkEvent({ key: "ArrowLeft", altKey: true }))).toBe("Alt+Left");
  });

  it("F5 no modifier", () => {
    expect(formatKeyEvent(mkEvent({ key: "F5" }))).toBe("F5");
  });

  it("Ctrl+,", () => {
    expect(formatKeyEvent(mkEvent({ key: ",", ctrlKey: true }))).toBe("Ctrl+,");
  });

  it("modifier-only returns null", () => {
    expect(formatKeyEvent(mkEvent({ key: "Control", ctrlKey: true }))).toBeNull();
    expect(formatKeyEvent(mkEvent({ key: "Shift", shiftKey: true }))).toBeNull();
  });

  it("Ctrl+Tab", () => {
    expect(formatKeyEvent(mkEvent({ key: "Tab", ctrlKey: true }))).toBe("Ctrl+Tab");
  });

  it("Ctrl+Shift+Tab", () => {
    expect(formatKeyEvent(mkEvent({ key: "Tab", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+Tab");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet && pnpm test --run src/lib/keyEvent.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 3: keyEvent.ts 구현**

```ts
/**
 * KeyboardEvent → 정규화 문자열 ("Ctrl+Shift+F" 등).
 *
 * - macOS metaKey 는 "Ctrl" 로 정규화 (cross-platform 통일).
 *   디스플레이는 별도 (settings GUI 가 ⌘ 표시 가능).
 * - 알파벳은 대문자.
 * - 화살표 키: ArrowLeft → Left, ArrowRight → Right, ...
 * - Modifier-only keypress (key === "Control" 등) 는 null 반환.
 */

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

export function formatKeyEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let key = e.key;
  if (key.startsWith("Arrow")) {
    key = key.slice("Arrow".length); // ArrowLeft → Left
  } else if (key.length === 1) {
    key = key.toUpperCase();
  }
  // Tab, F1..F12, Enter, Escape, Space 등은 그대로
  // ',' '.' '/' 등 특수문자도 그대로

  parts.push(key);
  return parts.join("+");
}
```

- [ ] **Step 4: 테스트 통과**

```bash
pnpm test --run src/lib/keyEvent.test.ts 2>&1 | tail -5
```
Expected: 10 pass.

- [ ] **Step 5: tsc + lint**

```bash
pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/keyEvent.ts src/lib/keyEvent.test.ts
git commit -m "fe/lib: formatKeyEvent — KeyboardEvent → 정규화 문자열

- macOS metaKey 를 Ctrl 로 정규화 (cross-platform 통일)
- ArrowLeft/Right 등 → Left/Right
- 알파벳 대문자, 특수문자 그대로
- modifier-only keypress 는 null
- 10 vitest pass"
```

---

### Task 2: lib/fuzzy.ts — fuzzyScore + tests

**Files:**
- Create: `src/lib/fuzzy.ts`
- Create: `src/lib/fuzzy.test.ts`

- [ ] **Step 1: fuzzy.test.ts 작성**

```ts
import { describe, it, expect } from "vitest";
import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("empty query matches all (score 0)", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("subsequence match returns positive score", () => {
    expect(fuzzyScore("ot", "openTab")).toBeGreaterThan(0);
  });

  it("non-subsequence returns null", () => {
    expect(fuzzyScore("xyz", "openTab")).toBeNull();
  });

  it("case insensitive", () => {
    expect(fuzzyScore("OT", "openTab")).toBeGreaterThan(0);
    expect(fuzzyScore("ot", "OPENTAB")).toBeGreaterThan(0);
  });

  it("contiguous match scores higher than scattered", () => {
    const contiguous = fuzzyScore("open", "open tab")!;
    const scattered = fuzzyScore("open", "outside p eraser n")!;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("word-boundary match scores higher", () => {
    const boundary = fuzzyScore("nt", "newTab")!;
    const middle = fuzzyScore("nt", "consonant")!;
    expect(boundary).toBeGreaterThan(middle);
  });

  it("perfect prefix scores high", () => {
    const prefix = fuzzyScore("new", "newTab")!;
    const middle = fuzzyScore("new", "renew")!;
    expect(prefix).toBeGreaterThan(middle);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
pnpm test --run src/lib/fuzzy.test.ts 2>&1 | tail -5
```
Expected: FAIL.

- [ ] **Step 3: fuzzy.ts 구현**

```ts
/**
 * 단순 fuzzy match. subsequence + scoring.
 *
 * - 빈 query: score 0 (모든 항목 통과)
 * - subsequence 안 맞으면 null
 * - bonus: 첫 char 가 word boundary (대문자, 공백/구두점 직후, position 0)
 * - bonus: 연속 매칭 (run length 가 클수록)
 *
 * commands 수가 적어서 (~50) perf 무시.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  let score = 0;
  let qi = 0;
  let prevMatched = false;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      // base point per match
      score += 1;
      // contiguous bonus
      if (prevMatched) score += 2;
      // word boundary bonus
      if (i === 0 || isBoundary(text, i)) score += 3;
      qi++;
      prevMatched = true;
    } else {
      prevMatched = false;
    }
  }
  if (qi < q.length) return null;
  // small penalty for length (prefer shorter texts when scores tie)
  return score - text.length * 0.01;
}

function isBoundary(text: string, i: number): boolean {
  // current char is uppercase letter (camelCase boundary) — text not lowered
  const ch = text[i]!;
  if (ch >= "A" && ch <= "Z") return true;
  // previous char is non-alphanum
  if (i > 0) {
    const prev = text[i - 1]!;
    if (!/[a-zA-Z0-9]/.test(prev)) return true;
  }
  return false;
}
```

- [ ] **Step 4: 테스트 통과**

```bash
pnpm test --run src/lib/fuzzy.test.ts 2>&1 | tail -5
```
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fuzzy.ts src/lib/fuzzy.test.ts
git commit -m "fe/lib: fuzzyScore — subsequence + scoring

- 빈 query: 모든 항목 통과 (score 0)
- subsequence 미매치: null
- bonus: 연속 매칭 + word boundary (camelCase / 구두점 후 / position 0)
- length penalty: 짧은 text 우선
- 7 vitest pass"
```

---

### Task 3: stores/commands.ts + stores/palette.ts + lib/commands.ts

**Files:**
- Create: `src/stores/commands.ts`
- Create: `src/stores/palette.ts`
- Create: `src/lib/commands.ts`

이 task 는 빌드만. 실제 commands action 은 App 에서 wire (T5).

- [ ] **Step 1: stores/palette.ts**

```ts
import { create } from "zustand";

interface State {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const usePalette = create<State>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
```

- [ ] **Step 2: lib/commands.ts**

```ts
export type CommandCategory =
  | "Tab"
  | "Navigation"
  | "View"
  | "Sort"
  | "Filter"
  | "Search"
  | "Connection"
  | "Settings"
  | "User";

export interface Command {
  id: string;
  label: string;
  category: CommandCategory;
  defaultKey?: string;
  action: () => void;
  /** input/textarea 안에서도 핸들러 동작? 디폴트 false. */
  allowInInput?: boolean;
}

/** App 가 호출 시 모든 callback 주입. */
export interface BuiltinDeps {
  // tab
  openTab: () => void;
  closeActiveTab: () => void;
  nextTab: () => void;
  prevTab: () => void;
  // navigation
  back: () => void;
  forward: () => void;
  // view
  refresh: () => void;
  toggleHidden: () => void;
  toggleSidebar: () => void;
  // sort (5)
  sortByName: () => void;
  sortBySize: () => void;
  sortByMtime: () => void;
  sortByKind: () => void;
  sortByExt: () => void;
  // filter / search
  focusFilter: () => void;
  openSearch: () => void;
  // settings / palette
  openSettings: () => void;
  openPalette: () => void;
  // close (Ctrl+Q on non-mac)
  quit: () => void;
}

export function buildBuiltins(deps: BuiltinDeps): Command[] {
  return [
    { id: "tab.new", label: "New tab", category: "Tab", defaultKey: "Ctrl+T", action: deps.openTab },
    { id: "tab.close", label: "Close tab", category: "Tab", defaultKey: "Ctrl+W", action: deps.closeActiveTab },
    { id: "tab.next", label: "Next tab", category: "Tab", defaultKey: "Ctrl+Tab", action: deps.nextTab },
    { id: "tab.prev", label: "Previous tab", category: "Tab", defaultKey: "Ctrl+Shift+Tab", action: deps.prevTab },
    { id: "nav.back", label: "Go back", category: "Navigation", defaultKey: "Alt+Left", action: deps.back },
    { id: "nav.forward", label: "Go forward", category: "Navigation", defaultKey: "Alt+Right", action: deps.forward },
    { id: "view.refresh", label: "Refresh", category: "View", defaultKey: "Ctrl+R", action: deps.refresh },
    { id: "view.refreshF5", label: "Refresh (F5)", category: "View", defaultKey: "F5", action: deps.refresh },
    { id: "view.toggleHidden", label: "Toggle hidden files", category: "View", defaultKey: "Ctrl+H", action: deps.toggleHidden },
    { id: "view.toggleSidebar", label: "Toggle sidebar", category: "View", defaultKey: "Ctrl+B", action: deps.toggleSidebar },
    { id: "sort.byName", label: "Sort by name", category: "Sort", defaultKey: "Ctrl+Shift+1", action: deps.sortByName },
    { id: "sort.bySize", label: "Sort by size", category: "Sort", defaultKey: "Ctrl+Shift+2", action: deps.sortBySize },
    { id: "sort.byMtime", label: "Sort by modified", category: "Sort", defaultKey: "Ctrl+Shift+3", action: deps.sortByMtime },
    { id: "sort.byKind", label: "Sort by kind", category: "Sort", defaultKey: "Ctrl+Shift+4", action: deps.sortByKind },
    { id: "sort.byExt", label: "Sort by extension", category: "Sort", defaultKey: "Ctrl+Shift+5", action: deps.sortByExt },
    { id: "filter.focus", label: "Focus filter", category: "Filter", defaultKey: "Ctrl+F", action: deps.focusFilter },
    { id: "search.global", label: "Global search", category: "Search", defaultKey: "Ctrl+Shift+F", action: deps.openSearch },
    { id: "settings.open", label: "Open settings", category: "Settings", defaultKey: "Ctrl+,", action: deps.openSettings },
    { id: "palette.open", label: "Command palette", category: "Settings", defaultKey: "Ctrl+P", action: deps.openPalette },
    { id: "app.quit", label: "Quit", category: "Settings", defaultKey: "Ctrl+Q", action: deps.quit },
  ];
}
```

- [ ] **Step 3: stores/commands.ts**

```ts
import { create } from "zustand";
import type { Command } from "@/lib/commands";

interface State {
  builtins: Command[];
  dynamic: Command[];
  setBuiltins: (cs: Command[]) => void;
  setDynamic: (cs: Command[]) => void;
}

export const useCommands = create<State>((set) => ({
  builtins: [],
  dynamic: [],
  setBuiltins: (cs) => set({ builtins: cs }),
  setDynamic: (cs) => set({ dynamic: cs }),
}));

export function useAllCommands(): Command[] {
  return useCommands((s) => [...s.builtins, ...s.dynamic]);
}
```

- [ ] **Step 4: tsc + lint**

```bash
pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/commands.ts src/stores/commands.ts src/stores/palette.ts
git commit -m "fe/store: Command registry (useCommands) + buildBuiltins + usePalette

- Command { id, label, category, defaultKey?, action, allowInInput? }
- BuiltinDeps: 모든 callback 모음. App 이 wire (T5).
- buildBuiltins(deps): 20 built-in commands (tab/nav/view/sort/filter/
  search/settings/palette/quit)
- useCommands.setBuiltins/setDynamic + useAllCommands selector
- usePalette: { isOpen, open, close }"
```

---

### Task 4: CommandPalette 컴포넌트

**Files:**
- Create: `src/components/CommandPalette.tsx`

- [ ] **Step 1: CommandPalette.tsx 작성**

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import { usePalette } from "@/stores/palette";
import { useAllCommands } from "@/stores/commands";
import { fuzzyScore } from "@/lib/fuzzy";
import type { Command } from "@/lib/commands";

/**
 * Ctrl+P 커맨드 팔레트. fuzzy 매칭 + Enter 실행.
 */
export function CommandPalette() {
  const isOpen = usePalette((s) => s.isOpen);
  const close = usePalette((s) => s.close);
  const all = useAllCommands();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setCursor(0);
      // autoFocus via ref (Radix 가 모달 마운트 직후)
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  const ranked = useMemo(() => {
    const scored = all
      .map((c) => ({ cmd: c, score: fuzzyScore(query, c.label) }))
      .filter((x): x is { cmd: Command; score: number } => x.score !== null);
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.cmd);
  }, [all, query]);

  // cursor clamp on results change
  useEffect(() => {
    if (cursor >= ranked.length) setCursor(0);
  }, [ranked.length, cursor]);

  if (!isOpen) return null;

  const execute = (cmd: Command) => {
    close();
    cmd.action();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/4 z-50 w-full max-w-xl -translate-x-1/2 rounded-md border border-border bg-base shadow-lg focus:outline-none">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search size={14} className="text-fg-muted shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => Math.min(ranked.length - 1, c + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => Math.max(0, c - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const cmd = ranked[cursor];
                  if (cmd) execute(cmd);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                }
              }}
              placeholder="Type a command…"
              className="flex-1 bg-transparent font-mono text-base focus:outline-none"
            />
          </div>
          <div className="max-h-80 overflow-auto py-1">
            {ranked.length === 0 ? (
              <div className="px-3 py-2 text-meta text-fg-muted">No results</div>
            ) : (
              ranked.map((cmd, i) => (
                <button
                  key={cmd.id}
                  type="button"
                  onClick={() => execute(cmd)}
                  onMouseEnter={() => setCursor(i)}
                  className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-base ${
                    i === cursor ? "bg-active text-fg" : "hover:bg-border"
                  }`}
                >
                  <span className="flex-1 truncate">{cmd.label}</span>
                  <span className="shrink-0 text-meta text-fg-muted">{cmd.category}</span>
                  {cmd.defaultKey && (
                    <span className="shrink-0 rounded bg-subtle px-1.5 py-0.5 text-meta text-fg-muted">
                      {cmd.defaultKey}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
          <Dialog.Description className="sr-only">Command palette</Dialog.Description>
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 2: tsc + lint**

```bash
pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/CommandPalette.tsx
git commit -m "fe/ui: CommandPalette — Radix Dialog, fuzzy 매칭, ↑↓/Enter/ESC

- 입력 autoFocus, fuzzyScore desc 정렬, score=null 제외
- 결과 행: label / category / defaultKey 3 컬럼
- ↑↓ cursor, Enter 실행 + close, ESC close"
```

---

### Task 5: App.tsx — buildBuiltins + Palette 마운트 + Ctrl+P 임시 wire

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/hooks/useGlobalShortcuts.ts`

이 task 는 임시. T14 에서 useGlobalShortcuts 완전 리팩터됨.

- [ ] **Step 1: useGlobalShortcuts 에 Ctrl+P 임시 추가**

`src/hooks/useGlobalShortcuts.ts` 의 case 추가 (case "h" 옆 또는 적절한 위치):

```ts
case "p":
  if (!isInput) {
    e.preventDefault();
    usePalette.getState().open();
  }
  break;
```

import 추가:
```ts
import { usePalette } from "@/stores/palette";
```

- [ ] **Step 2: App.tsx 변경**

A. import 추가:
```tsx
import { CommandPalette } from "@/components/CommandPalette";
import { useCommands } from "@/stores/commands";
import { usePalette } from "@/stores/palette";
import { buildBuiltins } from "@/lib/commands";
import { useUI } from "@/stores/ui";
```

B. App 함수 안에 builtins 등록 (모든 callback 정의 직후):

```tsx
// useGlobalShortcuts 옆에 추가
const setBuiltins = useCommands((s) => s.setBuiltins);
const openPalette = usePalette((s) => s.open);
const toggleSidebar = useUI((s) => s.toggleSidebar);

useEffect(() => {
  const builtins = buildBuiltins({
    openTab: () => usePanes.getState().openTab(usePanes.getState().activePane),
    closeActiveTab: () => {
      const id = usePanes.getState().activePane;
      const p = usePanes.getState().panes[id];
      usePanes.getState().closeTab(id, p.activeTabIndex);
    },
    nextTab: () => {
      const id = usePanes.getState().activePane;
      const p = usePanes.getState().panes[id];
      usePanes.getState().selectTab(id, (p.activeTabIndex + 1) % p.tabs.length);
    },
    prevTab: () => {
      const id = usePanes.getState().activePane;
      const p = usePanes.getState().panes[id];
      usePanes.getState().selectTab(id, (p.activeTabIndex - 1 + p.tabs.length) % p.tabs.length);
    },
    back: () => onBack(usePanes.getState().activePane),
    forward: () => onForward(usePanes.getState().activePane),
    refresh: () => onRefresh(usePanes.getState().activePane),
    toggleHidden: () => usePanes.getState().toggleShowHidden(usePanes.getState().activePane),
    toggleSidebar: () => toggleSidebar(),
    sortByName: () => usePanes.getState().toggleSortKey(usePanes.getState().activePane, "name"),
    sortBySize: () => usePanes.getState().toggleSortKey(usePanes.getState().activePane, "size"),
    sortByMtime: () => usePanes.getState().toggleSortKey(usePanes.getState().activePane, "mtime"),
    sortByKind: () => usePanes.getState().toggleSortKey(usePanes.getState().activePane, "kind"),
    sortByExt: () => usePanes.getState().toggleSortKey(usePanes.getState().activePane, "ext"),
    focusFilter: () => usePanes.getState().setFilterFocused(usePanes.getState().activePane, true),
    openSearch: () => {
      const id = usePanes.getState().activePane;
      const tab = activeTab(usePanes.getState(), id);
      useSearch.getState().open(id, tab.location);
    },
    openSettings: () => openDialog({ kind: "settings" }),
    openPalette: () => openPalette(),
    quit: () => {
      // mac 은 OS 가 처리, 다른 OS 는 close window
      const isMac = navigator.userAgent.includes("Mac");
      if (!isMac) {
        void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
          void getCurrentWindow().close();
        });
      }
    },
  });
  setBuiltins(builtins);
}, [setBuiltins, openPalette, toggleSidebar, onBack, onForward, onRefresh, openDialog]);
```

C. JSX 마지막에 `<CommandPalette />` 추가 (Toast 옆):

```tsx
<Toast />
<CommandPalette />
```

- [ ] **Step 3: tsc + lint + test**

```bash
pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3 && pnpm test --run 2>&1 | tail -5
```
Expected: clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useGlobalShortcuts.ts src/App.tsx
git commit -m "fe: Command palette wired — buildBuiltins in App, Ctrl+P 임시 단축키

- App: useEffect 에서 buildBuiltins(deps) → useCommands.setBuiltins.
  20 built-in commands 의 action 모두 wire.
- useGlobalShortcuts: 임시 case 'p' 로 palette open. T14 에서 완전 리팩터.
- CommandPalette 컴포넌트 마운트 (App JSX 끝)"
```

---

## Phase B — Dynamic Providers + User Aliases

### Task 6: Backend services/user_aliases.rs + smoke

**Files:**
- Create: `src-tauri/src/services/user_aliases.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Create: `src-tauri/tests/mvp7_user_aliases_smoke.rs`

- [ ] **Step 1: services/mod.rs 추가**

`pub mod user_aliases;` 적절한 alphabetic 위치 (마지막).

- [ ] **Step 2: services/user_aliases.rs**

```rust
//! 사용자 정의 navigation alias. `<config_dir>/duet/user-aliases.json`.
//!
//! AliasKind: Navigate { location } | Connect { saved_host_alias }.
//! 실제 실행은 frontend 가 alias.kind 분기.

use crate::services::settings::duet_config_dir;
use crate::types::{DuetError, Location};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UserAlias {
    pub id: String,
    pub name: String,
    pub kind: AliasKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AliasKind {
    Navigate { location: Location },
    Connect { saved_host_alias: String },
}

pub struct UserAliasesStore {
    path: PathBuf,
    inner: RwLock<Vec<UserAlias>>,
}

impl UserAliasesStore {
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("user-aliases.json");
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
                serde_json::from_str::<Vec<UserAlias>>(&text)
                    .map_err(|e| DuetError::Io(format!("user-aliases parse: {e}")))?
            }
        } else {
            Vec::new()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(items),
        }))
    }

    pub async fn list(&self) -> Vec<UserAlias> {
        self.inner.read().await.clone()
    }

    pub async fn add(&self, name: String, kind: AliasKind) -> Result<Vec<UserAlias>, DuetError> {
        if name.trim().is_empty() {
            return Err(DuetError::Io("alias name required".into()));
        }
        let item = UserAlias {
            id: uuid::Uuid::now_v7().to_string(),
            name,
            kind,
        };
        let mut v = self.inner.write().await;
        v.push(item);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    pub async fn remove(&self, id: &str) -> Result<Vec<UserAlias>, DuetError> {
        let mut v = self.inner.write().await;
        v.retain(|a| a.id != id);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    async fn write_to_disk(&self, items: &[UserAlias]) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = serde_json::to_string_pretty(items)
            .map_err(|e| DuetError::Io(format!("user-aliases serialize: {e}")))?;
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

    #[tokio::test]
    async fn add_navigate_then_remove() {
        let dir = tempdir().unwrap();
        let s = UserAliasesStore::load_from(&dir.path().join("a.json")).await.unwrap();
        let after = s
            .add(
                "go-tmp".into(),
                AliasKind::Navigate {
                    location: Location {
                        source: SourceId::Local,
                        path: PathBuf::from("/tmp"),
                    },
                },
            )
            .await
            .unwrap();
        assert_eq!(after.len(), 1);
        let id = after[0].id.clone();
        s.remove(&id).await.unwrap();
        assert!(s.list().await.is_empty());
    }

    #[tokio::test]
    async fn add_connect_alias_serializes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.json");
        let s = UserAliasesStore::load_from(&path).await.unwrap();
        s.add(
            "prod".into(),
            AliasKind::Connect { saved_host_alias: "prod-server".into() },
        )
        .await
        .unwrap();
        // reload
        let s2 = UserAliasesStore::load_from(&path).await.unwrap();
        let list = s2.list().await;
        assert_eq!(list.len(), 1);
        match &list[0].kind {
            AliasKind::Connect { saved_host_alias } => {
                assert_eq!(saved_host_alias, "prod-server");
            }
            _ => panic!("expected Connect"),
        }
    }

    #[tokio::test]
    async fn empty_name_rejected() {
        let dir = tempdir().unwrap();
        let s = UserAliasesStore::load_from(&dir.path().join("a.json")).await.unwrap();
        let res = s
            .add(
                "  ".into(),
                AliasKind::Navigate {
                    location: Location { source: SourceId::Local, path: PathBuf::from("/x") },
                },
            )
            .await;
        assert!(res.is_err());
    }
}
```

- [ ] **Step 3: tests/mvp7_user_aliases_smoke.rs**

```rust
//! MVP-7 user aliases smoke — Navigate + Connect lifecycle.

use duet_lib::services::user_aliases::{AliasKind, UserAliasesStore};
use duet_lib::types::{Location, SourceId};
use std::path::PathBuf;
use tempfile::tempdir;

#[tokio::test]
async fn smoke_lifecycle() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("ua.json");
    let s = UserAliasesStore::load_from(&path).await.unwrap();
    assert!(s.list().await.is_empty());

    s.add(
        "tmp".into(),
        AliasKind::Navigate {
            location: Location { source: SourceId::Local, path: PathBuf::from("/tmp") },
        },
    )
    .await
    .unwrap();
    s.add(
        "prod".into(),
        AliasKind::Connect { saved_host_alias: "prod".into() },
    )
    .await
    .unwrap();
    assert_eq!(s.list().await.len(), 2);

    let s2 = UserAliasesStore::load_from(&path).await.unwrap();
    let list = s2.list().await;
    assert_eq!(list.len(), 2);
    let id = list[0].id.clone();
    s2.remove(&id).await.unwrap();
    assert_eq!(s2.list().await.len(), 1);
}
```

- [ ] **Step 4: cargo test + clippy**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo test --lib services::user_aliases 2>&1 | tail -3
cargo test --test mvp7_user_aliases_smoke 2>&1 | tail -3
cargo clippy --lib --tests -- -D warnings 2>&1 | tail -3
```
Expected: 3 unit + 1 smoke pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/services/user_aliases.rs src-tauri/src/services/mod.rs src-tauri/tests/mvp7_user_aliases_smoke.rs
git commit -m "be/svc: UserAliasesStore — Navigate/Connect aliases (uuid v7)

- AliasKind: Navigate { location } | Connect { saved_host_alias }, snake_case 직렬화
- list / add / remove. add 새 uuid 발급, name 비어있으면 Err.
- 3 unit + 1 smoke 테스트"
```

---

### Task 7: Backend commands/user_aliases.rs + lib.rs

**Files:**
- Create: `src-tauri/src/commands/user_aliases.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: commands/mod.rs**

`pub mod user_aliases;` 추가 (alphabetic 마지막).

- [ ] **Step 2: commands/user_aliases.rs**

```rust
//! User aliases IPC — list / add / remove.

use std::sync::Arc;

use crate::services::user_aliases::{AliasKind, UserAlias, UserAliasesStore};
use crate::types::DuetError;

#[tauri::command]
#[specta::specta]
pub async fn user_aliases_list(
    store: tauri::State<'_, Arc<UserAliasesStore>>,
) -> Result<Vec<UserAlias>, DuetError> {
    Ok(store.inner().list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn user_aliases_add(
    name: String,
    kind: AliasKind,
    store: tauri::State<'_, Arc<UserAliasesStore>>,
) -> Result<Vec<UserAlias>, DuetError> {
    store.inner().add(name, kind).await
}

#[tauri::command]
#[specta::specta]
pub async fn user_aliases_remove(
    id: String,
    store: tauri::State<'_, Arc<UserAliasesStore>>,
) -> Result<Vec<UserAlias>, DuetError> {
    store.inner().remove(&id).await
}
```

- [ ] **Step 3: lib.rs**

A. `collect_commands![]` 에 3 추가:

```rust
commands::user_aliases::user_aliases_list,
commands::user_aliases::user_aliases_add,
commands::user_aliases::user_aliases_remove,
```

B. `run()` 에 store 로드:

```rust
let user_aliases = tauri::async_runtime::block_on(async {
    services::user_aliases::UserAliasesStore::load_default().await
})
.expect("user aliases load");
```

C. `.manage(user_aliases)` 추가.

- [ ] **Step 4: cargo check + clippy**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo check --lib --tests --bins 2>&1 | tail -3
cargo clippy --lib --tests --bins -- -D warnings 2>&1 | tail -3
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/commands/user_aliases.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "be/cmd: user_aliases IPC — list / add / remove + lib.rs manage"
```

---

### Task 8: Frontend stores/userAliases.ts + lib/dynamicCommands.ts + App wire

**Files:**
- Create: `src/stores/userAliases.ts`
- Create: `src/lib/dynamicCommands.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: stores/userAliases.ts**

```ts
import { create } from "zustand";
import { commands } from "@/types/bindings";
import type { AliasKind, UserAlias } from "@/types/bindings";

interface State {
  items: UserAlias[];
  setAll: (items: UserAlias[]) => void;
}

export const useUserAliases = create<State>((set) => ({
  items: [],
  setAll: (items) => set({ items }),
}));

export async function bootstrapUserAliases(): Promise<void> {
  const r = await commands.userAliasesList();
  if (r.status === "ok") useUserAliases.getState().setAll(r.data);
}

export async function addUserAlias(name: string, kind: AliasKind): Promise<boolean> {
  const r = await commands.userAliasesAdd(name, kind);
  if (r.status === "ok") {
    useUserAliases.getState().setAll(r.data);
    return true;
  }
  return false;
}

export async function removeUserAlias(id: string): Promise<void> {
  const r = await commands.userAliasesRemove(id);
  if (r.status === "ok") useUserAliases.getState().setAll(r.data);
}
```

- [ ] **Step 2: lib/dynamicCommands.ts**

```ts
import { useEffect } from "react";
import { useCommands } from "@/stores/commands";
import { useSavedHosts } from "@/stores/savedHosts";
import { useBookmarks } from "@/stores/bookmarks";
import { useHostFavorites } from "@/stores/hostFavorites";
import { useUserAliases } from "@/stores/userAliases";
import type { Command } from "@/lib/commands";
import type { Location, SavedHost, HostFavorite, UserAlias } from "@/types/bindings";

export interface DynamicDeps {
  onSavedActivate: (host: SavedHost) => void;
  onBookmarkActivate: (location: Location) => void;
  onFavoriteActivate: (favorite: HostFavorite) => void;
  onAliasExecute: (alias: UserAlias) => void;
}

/**
 * 4 store subscribe → useCommands.setDynamic.
 * App 가 마운트 시 한 번만 호출.
 */
export function useDynamicCommands(deps: DynamicDeps) {
  const savedHosts = useSavedHosts((s) => s.hosts);
  const bookmarks = useBookmarks((s) => s.items);
  const hostFavorites = useHostFavorites((s) => s.items);
  const userAliases = useUserAliases((s) => s.items);
  const setDynamic = useCommands((s) => s.setDynamic);

  useEffect(() => {
    const cmds: Command[] = [
      ...savedHosts.map((h) => ({
        id: `host.connect:${h.alias}`,
        label: `Connect: ${h.alias}`,
        category: "Connection" as const,
        action: () => deps.onSavedActivate(h),
      })),
      ...bookmarks.map((b) => ({
        id: `bookmark.open:${b.id}`,
        label: `Bookmark: ${b.name}`,
        category: "Navigation" as const,
        action: () => deps.onBookmarkActivate(b.location),
      })),
      ...hostFavorites.map((f) => ({
        id: `favorite.open:${f.id}`,
        label: `${f.host_alias} → ${f.name}`,
        category: "Connection" as const,
        action: () => deps.onFavoriteActivate(f),
      })),
      ...userAliases.map((a) => ({
        id: `alias:${a.id}`,
        label: a.name,
        category: "User" as const,
        action: () => deps.onAliasExecute(a),
      })),
    ];
    setDynamic(cmds);
  }, [savedHosts, bookmarks, hostFavorites, userAliases, setDynamic, deps]);
}
```

- [ ] **Step 3: App.tsx 통합**

A. import 추가:
```tsx
import { bootstrapUserAliases } from "@/stores/userAliases";
import { useDynamicCommands } from "@/lib/dynamicCommands";
import type { UserAlias } from "@/types/bindings";
```

B. bootstrap useEffect 에 추가:
```tsx
void bootstrapUserAliases();
```

C. onAliasExecute callback:
```tsx
const onAliasExecute = useCallback(
  (alias: UserAlias) => {
    if (alias.kind.kind === "navigate") {
      const id = usePanes.getState().activePane;
      void navigateTo(id, alias.kind.location);
    } else if (alias.kind.kind === "connect") {
      const targetAlias = alias.kind.saved_host_alias;
      const conns = Object.values(useConnections.getState().active);
      const conn = conns.find((c) => c.alias === targetAlias);
      if (!conn) {
        showToast(`Connect to ${targetAlias} first (use saved hosts dialog)`);
        return;
      }
      // 이미 연결된 경우: home 으로 navigate (saved host home)
      // 단순히 toast 만 — host 이미 연결됨 알림
      showToast(`${targetAlias} is connected`);
    }
  },
  [navigateTo, showToast],
);
```

D. useDynamicCommands 호출:
```tsx
useDynamicCommands({
  onSavedActivate,
  onBookmarkActivate,
  onFavoriteActivate,
  onAliasExecute,
});
```

- [ ] **Step 4: tsc + lint + test**

```bash
pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3 && pnpm test --run 2>&1 | tail -5
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/stores/userAliases.ts src/lib/dynamicCommands.ts src/App.tsx
git commit -m "fe: UserAliases store + dynamicCommands hook + App wire

- stores/userAliases.ts: bootstrap/add/remove
- lib/dynamicCommands.ts: 4 store subscribe → useCommands.setDynamic
  (savedHosts/bookmarks/favorites/userAliases 변경 시 dynamic 재계산)
- App: bootstrapUserAliases + useDynamicCommands + onAliasExecute
  (Navigate → navigateTo, Connect → toast)"
```

---

## Phase C — Keymap externalization + Hot reload

### Task 9: Backend services/keymap.rs + smoke

**Files:**
- Create: `src-tauri/src/services/keymap.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Create: `src-tauri/tests/mvp7_keymap_smoke.rs`

- [ ] **Step 1: services/mod.rs**

`pub mod keymap;` 추가 (alphabetic — between `journal_events` and `progress_events` 적절히).

- [ ] **Step 2: services/keymap.rs**

```rust
//! 키 → command id 매핑. `<config_dir>/duet/keymap.toml`.
//!
//! TOML 형식:
//! ```toml
//! [bindings]
//! "Ctrl+T" = "tab.new"
//! "Ctrl+W" = "tab.close"
//! ```
//!
//! 빈 파일 / 파일 없음 = bindings 비어있음 (frontend 가 command.defaultKey 사용).

use crate::services::settings::duet_config_dir;
use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct KeymapBinding {
    pub key: String,
    pub command_id: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct KeymapToml {
    #[serde(default)]
    bindings: BTreeMap<String, String>,
}

pub struct KeymapStore {
    path: PathBuf,
    inner: RwLock<Vec<KeymapBinding>>,
}

impl KeymapStore {
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("keymap.toml");
        Self::load_from(&path).await
    }

    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let bindings = read_file(path).await?;
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(bindings),
        }))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn list(&self) -> Vec<KeymapBinding> {
        self.inner.read().await.clone()
    }

    /// 외부 source (file watcher) 가 호출 — bindings 통째로 교체 + emit 안 함 (caller 결정).
    pub async fn replace(&self, bindings: Vec<KeymapBinding>) {
        let mut v = self.inner.write().await;
        *v = bindings;
    }

    pub async fn set(&self, key: String, command_id: String) -> Result<Vec<KeymapBinding>, DuetError> {
        if key.trim().is_empty() {
            return Err(DuetError::Io("key required".into()));
        }
        let mut v = self.inner.write().await;
        // 같은 key 있으면 교체
        if let Some(existing) = v.iter_mut().find(|b| b.key == key) {
            existing.command_id = command_id;
        } else {
            v.push(KeymapBinding { key, command_id });
        }
        let snap = v.clone();
        write_file(&self.path, &snap).await?;
        Ok(snap)
    }

    pub async fn unset(&self, key: &str) -> Result<Vec<KeymapBinding>, DuetError> {
        let mut v = self.inner.write().await;
        v.retain(|b| b.key != key);
        let snap = v.clone();
        write_file(&self.path, &snap).await?;
        Ok(snap)
    }

    pub async fn reset(&self) -> Result<Vec<KeymapBinding>, DuetError> {
        let mut v = self.inner.write().await;
        v.clear();
        write_file(&self.path, &[]).await?;
        Ok(Vec::new())
    }
}

pub async fn read_file(path: &Path) -> Result<Vec<KeymapBinding>, DuetError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = tokio::fs::read_to_string(path).await.map_err(DuetError::from)?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed: KeymapToml = toml::from_str(&text)
        .map_err(|e| DuetError::Io(format!("keymap parse: {e}")))?;
    Ok(parsed
        .bindings
        .into_iter()
        .map(|(key, command_id)| KeymapBinding { key, command_id })
        .collect())
}

async fn write_file(path: &Path, items: &[KeymapBinding]) -> Result<(), DuetError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(DuetError::from)?;
    }
    let mut bindings = BTreeMap::new();
    for b in items {
        bindings.insert(b.key.clone(), b.command_id.clone());
    }
    let toml_doc = KeymapToml { bindings };
    let text = toml::to_string_pretty(&toml_doc)
        .map_err(|e| DuetError::Io(format!("keymap serialize: {e}")))?;
    tokio::fs::write(path, text).await.map_err(DuetError::from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn empty_file_returns_empty() {
        let dir = tempdir().unwrap();
        let s = KeymapStore::load_from(&dir.path().join("k.toml")).await.unwrap();
        assert!(s.list().await.is_empty());
    }

    #[tokio::test]
    async fn set_and_unset() {
        let dir = tempdir().unwrap();
        let s = KeymapStore::load_from(&dir.path().join("k.toml")).await.unwrap();
        s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        s.set("Ctrl+W".into(), "tab.close".into()).await.unwrap();
        assert_eq!(s.list().await.len(), 2);
        s.unset("Ctrl+T").await.unwrap();
        assert_eq!(s.list().await.len(), 1);
    }

    #[tokio::test]
    async fn set_same_key_replaces() {
        let dir = tempdir().unwrap();
        let s = KeymapStore::load_from(&dir.path().join("k.toml")).await.unwrap();
        s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        s.set("Ctrl+T".into(), "tab.close".into()).await.unwrap();
        let list = s.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].command_id, "tab.close");
    }

    #[tokio::test]
    async fn reset_clears_all() {
        let dir = tempdir().unwrap();
        let s = KeymapStore::load_from(&dir.path().join("k.toml")).await.unwrap();
        s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        s.reset().await.unwrap();
        assert!(s.list().await.is_empty());
    }

    #[tokio::test]
    async fn roundtrip_persists() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("k.toml");
        let s = KeymapStore::load_from(&path).await.unwrap();
        s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        let s2 = KeymapStore::load_from(&path).await.unwrap();
        let list = s2.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].key, "Ctrl+T");
        assert_eq!(list[0].command_id, "tab.new");
    }
}
```

- [ ] **Step 3: tests/mvp7_keymap_smoke.rs**

```rust
//! MVP-7 keymap smoke — TOML roundtrip, set/unset, reset.

use duet_lib::services::keymap::{read_file, KeymapStore};
use tempfile::tempdir;

#[tokio::test]
async fn smoke_lifecycle() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("keymap.toml");
    let s = KeymapStore::load_from(&path).await.unwrap();
    assert!(s.list().await.is_empty());

    s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
    s.set("Ctrl+W".into(), "tab.close".into()).await.unwrap();
    s.set("Alt+Left".into(), "nav.back".into()).await.unwrap();
    assert_eq!(s.list().await.len(), 3);

    // 외부 read (다른 process simulation)
    let bindings = read_file(&path).await.unwrap();
    assert_eq!(bindings.len(), 3);

    s.unset("Ctrl+W").await.unwrap();
    assert_eq!(s.list().await.len(), 2);

    s.reset().await.unwrap();
    assert!(s.list().await.is_empty());
    let bindings = read_file(&path).await.unwrap();
    assert_eq!(bindings.len(), 0);
}
```

- [ ] **Step 4: cargo test + clippy**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo test --lib services::keymap 2>&1 | tail -3
cargo test --test mvp7_keymap_smoke 2>&1 | tail -3
cargo clippy --lib --tests -- -D warnings 2>&1 | tail -3
```
Expected: 5 unit + 1 smoke pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/services/keymap.rs src-tauri/src/services/mod.rs src-tauri/tests/mvp7_keymap_smoke.rs
git commit -m "be/svc: KeymapStore — TOML keymap.toml + list/set/unset/reset

- KeymapBinding { key, command_id }
- TOML 형식: [bindings] 테이블 = key → command_id (BTreeMap)
- set / unset / reset 모두 파일 동기화. 빈 파일 = 빈 list.
- read_file public — file watcher (T11) 와 공유.
- replace public — file watcher 가 store 갱신 시 사용.
- 5 unit + 1 smoke 테스트"
```

---

### Task 10: Backend services/keymap_events.rs + commands/keymap.rs + lib.rs (no watcher 아직)

**Files:**
- Create: `src-tauri/src/services/keymap_events.rs`
- Create: `src-tauri/src/commands/keymap.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: services/keymap_events.rs**

```rust
//! Keymap 변경 이벤트 — 파일 watcher 가 변경 감지 시 emit.

use crate::services::keymap::KeymapBinding;
use serde::Serialize;
use specta::Type;
use tauri_specta::Event;

#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct KeymapChangedEvent {
    pub bindings: Vec<KeymapBinding>,
}
```

- [ ] **Step 2: services/mod.rs**

`pub mod keymap_events;` 추가 (alphabetic).

- [ ] **Step 3: commands/keymap.rs**

```rust
//! Keymap IPC — list / set / unset / reset.

use std::sync::Arc;

use crate::services::keymap::{KeymapBinding, KeymapStore};
use crate::types::DuetError;

#[tauri::command]
#[specta::specta]
pub async fn keymap_list(
    store: tauri::State<'_, Arc<KeymapStore>>,
) -> Result<Vec<KeymapBinding>, DuetError> {
    Ok(store.inner().list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn keymap_set(
    key: String,
    command_id: String,
    store: tauri::State<'_, Arc<KeymapStore>>,
) -> Result<Vec<KeymapBinding>, DuetError> {
    store.inner().set(key, command_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn keymap_unset(
    key: String,
    store: tauri::State<'_, Arc<KeymapStore>>,
) -> Result<Vec<KeymapBinding>, DuetError> {
    store.inner().unset(&key).await
}

#[tauri::command]
#[specta::specta]
pub async fn keymap_reset(
    store: tauri::State<'_, Arc<KeymapStore>>,
) -> Result<Vec<KeymapBinding>, DuetError> {
    store.inner().reset().await
}
```

- [ ] **Step 4: commands/mod.rs**

`pub mod keymap;` 추가.

- [ ] **Step 5: lib.rs**

A. `collect_commands![]` 에 4 추가:
```rust
commands::keymap::keymap_list,
commands::keymap::keymap_set,
commands::keymap::keymap_unset,
commands::keymap::keymap_reset,
```

B. `collect_events![]` 에 추가:
```rust
services::keymap_events::KeymapChangedEvent,
```

C. `run()` 에서 store 로드:
```rust
let keymap = tauri::async_runtime::block_on(async {
    services::keymap::KeymapStore::load_default().await
})
.expect("keymap load");
```

D. `.manage(keymap)` 추가.

- [ ] **Step 6: cargo check + clippy**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo check --lib --tests --bins 2>&1 | tail -3
cargo clippy --lib --tests --bins -- -D warnings 2>&1 | tail -3
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/services/keymap_events.rs src-tauri/src/commands/keymap.rs src-tauri/src/services/mod.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "be/cmd + event: keymap IPC (4) + KeymapChangedEvent

- IPC: keymap_list / keymap_set / keymap_unset / keymap_reset
- Event: KeymapChangedEvent { bindings } — 파일 watcher 가 emit (T11)
- lib.rs: 4 commands + 1 event 등록 + KeymapStore manage"
```

---

### Task 11: Backend file watcher (notify) + setup hook

**Files:**
- Create: `src-tauri/src/services/keymap_watcher.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: services/keymap_watcher.rs**

```rust
//! Keymap.toml 파일 watcher — 변경 시 store 갱신 + KeymapChangedEvent emit.
//!
//! `notify` crate 사용. 무한 루프 방지: 새 bindings 가 store 와 동일하면 emit X.

use crate::services::keymap::{read_file, KeymapStore};
use crate::services::keymap_events::KeymapChangedEvent;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_specta::Event as _;

/// notify watcher 인스턴스 보관용 — drop 되면 watcher 종료.
pub struct KeymapWatcher {
    _inner: RecommendedWatcher,
}

/// keymap.toml 파일 watcher 시작. 변경 감지 → re-read → store 갱신 → emit.
pub fn start(
    app: AppHandle,
    store: Arc<KeymapStore>,
) -> Result<KeymapWatcher, String> {
    let path: PathBuf = store.path().to_path_buf();
    let dir = path
        .parent()
        .ok_or_else(|| "keymap path has no parent".to_string())?
        .to_path_buf();
    let target_filename = path
        .file_name()
        .ok_or_else(|| "keymap path has no file_name".to_string())?
        .to_owned();

    // notify watch 가 디렉토리 단위 — 같은 디렉토리 다른 파일 이벤트는 filter
    let app_for_cb = app.clone();
    let store_for_cb = store.clone();
    let path_for_cb = path.clone();
    let target_for_cb = target_filename.clone();
    let last_emitted = Arc::new(Mutex::new(Vec::new()));
    let last_for_cb = last_emitted.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else { return };
            let modified = matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_)
            );
            if !modified {
                return;
            }
            // 이벤트의 paths 안에 keymap.toml 가 있는지
            let touches_keymap = event
                .paths
                .iter()
                .any(|p| p.file_name() == Some(&target_for_cb));
            if !touches_keymap {
                return;
            }

            // re-read + diff + emit
            let store = store_for_cb.clone();
            let app = app_for_cb.clone();
            let path = path_for_cb.clone();
            let last = last_for_cb.clone();
            tauri::async_runtime::spawn(async move {
                let new_bindings = match read_file(&path).await {
                    Ok(b) => b,
                    Err(e) => {
                        tracing::warn!("keymap re-read failed: {e}");
                        return;
                    }
                };
                let mut last_guard = last.lock().expect("poisoned");
                if *last_guard == new_bindings {
                    return; // no-change, skip emit
                }
                *last_guard = new_bindings.clone();
                drop(last_guard);
                store.replace(new_bindings.clone()).await;
                let _ = KeymapChangedEvent { bindings: new_bindings }.emit(&app);
            });
        },
        Config::default(),
    )
    .map_err(|e| format!("notify watcher init: {e}"))?;

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("notify watch start: {e}"))?;

    Ok(KeymapWatcher { _inner: watcher })
}
```

- [ ] **Step 2: services/mod.rs**

`pub mod keymap_watcher;` 추가.

- [ ] **Step 3: lib.rs setup 에 watcher 시작**

`run()` 의 `.setup(...)` 안에 (다른 watcher/queue 옆) 추가:

```rust
// keymap.toml file watcher (hot reload)
match services::keymap_watcher::start(app.handle().clone(), keymap_for_setup.clone()) {
    Ok(w) => app.manage(w),
    Err(e) => tracing::warn!("keymap watcher: {e}"),
}
```

`keymap_for_setup` 가 setup move 안에서 access 되어야 함 — `let keymap_for_setup = keymap.clone();` 미리 (setup 클로저 밖). KeymapStore 는 Arc<Self> 라 clone 가능.

설정 (단순화 — keymap clone 추가):

```rust
let keymap = tauri::async_runtime::block_on(async {
    services::keymap::KeymapStore::load_default().await
})
.expect("keymap load");

// setup move 안에서 사용할 clone
let keymap_for_setup = keymap.clone();
// ...
.setup(move |app| {
    // ... 기존 ...
    match services::keymap_watcher::start(app.handle().clone(), keymap_for_setup.clone()) {
        Ok(w) => app.manage(w),
        Err(e) => tracing::warn!("keymap watcher: {e}"),
    }
    Ok(())
})
```

- [ ] **Step 4: cargo check + clippy**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo check --lib --tests --bins 2>&1 | tail -5
cargo clippy --lib --tests --bins -- -D warnings 2>&1 | tail -5
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/services/keymap_watcher.rs src-tauri/src/services/mod.rs src-tauri/src/lib.rs
git commit -m "be/svc: keymap_watcher — notify 기반 hot reload + emit

- RecommendedWatcher 가 keymap.toml 의 디렉토리 watch (NonRecursive)
- Modify/Create 이벤트 + 파일 이름 일치 시 → re-read → store.replace +
  KeymapChangedEvent emit
- 무한 루프 방지: 마지막 emit 한 bindings 와 새것 비교, 동일 시 skip
- lib.rs setup 에서 시작, watcher 인스턴스 manage (drop 시 종료)"
```

---

### Task 12: Frontend stores/keymap.ts + useKeymapEvents hook

**Files:**
- Create: `src/stores/keymap.ts`
- Create: `src/hooks/useKeymapEvents.ts`

- [ ] **Step 1: stores/keymap.ts**

```ts
import { create } from "zustand";
import { commands } from "@/types/bindings";
import type { KeymapBinding } from "@/types/bindings";

interface State {
  bindings: KeymapBinding[];
  setAll: (b: KeymapBinding[]) => void;
}

export const useKeymap = create<State>((set) => ({
  bindings: [],
  setAll: (bindings) => set({ bindings }),
}));

/** override (있으면) 또는 defaultKey */
export function effectiveKey(commandId: string, bindings: KeymapBinding[], defaultKey?: string): string | undefined {
  const override = bindings.find((b) => b.command_id === commandId);
  return override?.key ?? defaultKey;
}

export async function bootstrapKeymap(): Promise<void> {
  const r = await commands.keymapList();
  if (r.status === "ok") useKeymap.getState().setAll(r.data);
}

export async function setKeymap(key: string, command_id: string): Promise<boolean> {
  const r = await commands.keymapSet(key, command_id);
  if (r.status === "ok") {
    useKeymap.getState().setAll(r.data);
    return true;
  }
  return false;
}

export async function unsetKeymap(key: string): Promise<void> {
  const r = await commands.keymapUnset(key);
  if (r.status === "ok") useKeymap.getState().setAll(r.data);
}

export async function resetKeymap(): Promise<void> {
  const r = await commands.keymapReset();
  if (r.status === "ok") useKeymap.getState().setAll(r.data);
}
```

- [ ] **Step 2: hooks/useKeymapEvents.ts**

```ts
import { useEffect } from "react";
import { events } from "@/types/bindings";
import { useKeymap, bootstrapKeymap } from "@/stores/keymap";

/**
 * 마운트 시 keymap_list IPC + KeymapChangedEvent 구독.
 */
export function useKeymapEvents() {
  const setAll = useKeymap((s) => s.setAll);
  useEffect(() => {
    void bootstrapKeymap();
    const unlistenP = events.keymapChangedEvent.listen(({ payload }) => {
      setAll(payload.bindings);
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [setAll]);
}
```

- [ ] **Step 3: tsc + lint**

```bash
pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/stores/keymap.ts src/hooks/useKeymapEvents.ts
git commit -m "fe: keymap store + useKeymapEvents (bootstrap + KeymapChangedEvent)

- stores/keymap.ts: bindings + setAll + effectiveKey helper +
  bootstrap/set/unset/reset IPC wrappers
- useKeymapEvents: mount 시 bootstrap + listen, payload → store"
```

---

### Task 13: useGlobalShortcuts 완전 리팩터 (keymap + commands lookup)

**Files:**
- Modify: `src/hooks/useGlobalShortcuts.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: useGlobalShortcuts.ts 전체 교체**

```ts
import { useEffect } from "react";
import { useKeymap } from "@/stores/keymap";
import { useAllCommands } from "@/stores/commands";
import { formatKeyEvent } from "@/lib/keyEvent";

/**
 * 단축키 처리 — keymap binding 우선, 없으면 command.defaultKey 매칭.
 *
 * 모든 command action 은 store 등록된 것 그대로 호출. 이전 hardcoded
 * switch 제거.
 *
 * input/textarea 차단: command.allowInInput 으로 옵트인.
 */
export function useGlobalShortcuts() {
  const bindings = useKeymap((s) => s.bindings);
  const commands = useAllCommands();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isInput = tag === "input" || tag === "textarea";

      const keystr = formatKeyEvent(e);
      if (!keystr) return;

      // override 우선
      const binding = bindings.find((b) => b.key === keystr);
      let commandId = binding?.command_id;

      if (!commandId) {
        const cmd = commands.find((c) => c.defaultKey === keystr);
        commandId = cmd?.id;
      }

      if (!commandId) return;

      const cmd = commands.find((c) => c.id === commandId);
      if (!cmd) return;

      if (isInput && !cmd.allowInInput) return;

      e.preventDefault();
      cmd.action();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bindings, commands]);
}
```

- [ ] **Step 2: App.tsx 변경**

A. `useGlobalShortcuts({ onRefresh, onBack, onForward })` → `useGlobalShortcuts()` (시그니처 변경)

B. `useKeymapEvents()` 호출 추가 (다른 events hook 옆):
```tsx
import { useKeymapEvents } from "@/hooks/useKeymapEvents";
// ...
useKeymapEvents();
```

C. **임시 wired Ctrl+P 제거** — 이전 T5 에서 추가한 case "p" 는 이제 buildBuiltins 의 palette.open command 로 대체. useGlobalShortcuts 는 hardcoded switch 가 없음.

(`useGlobalShortcuts.ts` 안 case "p" 가 더 이상 없어야 — 위 Step 1 의 새 implementation 에 switch 자체가 없음. 자동 해결.)

- [ ] **Step 3: tsc + lint + test**

```bash
pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3 && pnpm test --run 2>&1 | tail -5
```
Expected: clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useGlobalShortcuts.ts src/App.tsx
git commit -m "fe/hook: useGlobalShortcuts 완전 리팩터 — keymap + commands lookup

- 이전 hardcoded switch 모두 제거
- formatKeyEvent → keymap override 우선, 없으면 command.defaultKey 매칭
- command.action() 호출. input 차단은 allowInInput 옵트인
- App: useKeymapEvents() 호출, useGlobalShortcuts() 시그니처 단순화"
```

---

## Phase D — Settings GUI sections

### Task 14: SettingsDialog 리팩터 (sidebar + content layout)

**Files:**
- Modify: `src/components/SettingsDialog.tsx`
- Create: `src/components/settings/GeneralSection.tsx`

- [ ] **Step 1: GeneralSection.tsx**

```tsx
import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { commands } from "@/types/bindings";
import type { Settings } from "@/types/bindings";

export function GeneralSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    commands.settingsGet().then((r) => {
      if (cancelled) return;
      if (r.status === "ok") setSettings(r.data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const togglePermanent = async () => {
    if (!settings) return;
    const next = !settings.permanent_delete_enabled;
    const r = await commands.settingsSet({ permanent_delete_enabled: next });
    if (r.status === "ok") setSettings(r.data);
  };

  if (loading || !settings) return <div className="text-base text-fg-muted">Loading…</div>;

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={settings.permanent_delete_enabled}
          onChange={togglePermanent}
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="text-base">
            Permanent delete (Shift+Delete) 활성화
          </div>
          <div className="text-meta text-fg-muted">
            CLAUDE.md §3 — 디폴트 OFF. 활성화해도 단어 타이핑 추가 확인 필요.
          </div>
          {settings.permanent_delete_enabled && (
            <div className="mt-1 flex items-center gap-1 text-meta text-danger">
              <AlertTriangle size={11} /> 영구 삭제 위험.
            </div>
          )}
        </div>
      </label>
    </div>
  );
}
```

- [ ] **Step 2: SettingsDialog.tsx 전체 교체**

```tsx
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { GeneralSection } from "./settings/GeneralSection";
// KeymapSection / AliasesSection 은 Task 15 / 16 에서 추가 import

type SectionId = "general" | "keymap" | "aliases";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "keymap", label: "Keymap" },
  { id: "aliases", label: "Aliases" },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("general");

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[32rem] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-base shadow-lg focus:outline-none">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <Dialog.Title className="text-title font-medium">Settings</Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>
          <div className="flex flex-1 min-h-0">
            <aside className="w-32 shrink-0 border-r border-border bg-subtle p-2">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSection(s.id)}
                  className={`w-full rounded px-2 py-1 text-left text-base ${
                    section === s.id ? "bg-active text-fg" : "text-fg-muted hover:bg-border"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </aside>
            <main className="flex-1 overflow-auto p-4">
              {section === "general" && <GeneralSection />}
              {section === "keymap" && <div className="text-fg-muted">Keymap section (T15)</div>}
              {section === "aliases" && <div className="text-fg-muted">Aliases section (T16)</div>}
            </main>
          </div>
          <Dialog.Description className="sr-only">Application settings</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 3: tsc + lint**

```bash
pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/SettingsDialog.tsx src/components/settings/GeneralSection.tsx
git commit -m "fe/ui: SettingsDialog 리팩터 — sidebar + content layout

- 좌측 sidebar (General/Keymap/Aliases), 우측 content panel
- General: 기존 permanent_delete 토글
- Keymap/Aliases section 은 placeholder (T15/T16 에서 채움)"
```

---

### Task 15: KeymapSection — 모든 command list, Edit/Reset

**Files:**
- Create: `src/components/settings/KeymapSection.tsx`
- Modify: `src/components/SettingsDialog.tsx`

- [ ] **Step 1: KeymapSection.tsx**

```tsx
import { useEffect, useRef, useState } from "react";
import { useAllCommands } from "@/stores/commands";
import { useKeymap, effectiveKey, setKeymap, unsetKeymap } from "@/stores/keymap";
import { formatKeyEvent } from "@/lib/keyEvent";
import { AlertTriangle } from "lucide-react";

export function KeymapSection() {
  const all = useAllCommands();
  const bindings = useKeymap((s) => s.bindings);
  const [editing, setEditing] = useState<string | null>(null); // command id

  // 충돌 감지: key → count
  const keyCount: Record<string, number> = {};
  for (const c of all) {
    const key = effectiveKey(c.id, bindings, c.defaultKey);
    if (key) keyCount[key] = (keyCount[key] ?? 0) + 1;
  }

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[1fr_5rem_8rem_5rem] gap-2 border-b border-border px-2 py-1 text-meta text-fg-muted">
        <div>Command</div>
        <div>Category</div>
        <div>Key</div>
        <div>Actions</div>
      </div>
      {all.map((cmd) => {
        const bound = bindings.find((b) => b.command_id === cmd.id);
        const key = bound?.key ?? cmd.defaultKey;
        const conflict = key && keyCount[key]! > 1;
        return (
          <div
            key={cmd.id}
            className="grid grid-cols-[1fr_5rem_8rem_5rem] items-center gap-2 px-2 py-0.5 text-base hover:bg-subtle"
          >
            <div className="truncate" title={cmd.id}>{cmd.label}</div>
            <div className="text-meta text-fg-muted">{cmd.category}</div>
            <div>
              {editing === cmd.id ? (
                <KeyCaptureInput
                  onCancel={() => setEditing(null)}
                  onCapture={async (newKey) => {
                    await setKeymap(newKey, cmd.id);
                    setEditing(null);
                  }}
                />
              ) : (
                <span className="flex items-center gap-1 font-mono text-meta">
                  {key ?? <span className="text-fg-muted">(none)</span>}
                  {conflict && <AlertTriangle size={11} className="text-danger" />}
                </span>
              )}
            </div>
            <div className="flex gap-1 text-meta">
              <button
                type="button"
                onClick={() => setEditing(cmd.id)}
                className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-border hover:text-fg"
              >
                Edit
              </button>
              {bound && (
                <button
                  type="button"
                  onClick={() => void unsetKeymap(bound.key)}
                  className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-border hover:text-fg"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KeyCaptureInput({
  onCancel,
  onCapture,
}: {
  onCancel: () => void;
  onCapture: (key: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      readOnly
      value=""
      placeholder="Press key…"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
          return;
        }
        const ks = formatKeyEvent(e.nativeEvent);
        if (ks) {
          e.preventDefault();
          onCapture(ks);
        }
      }}
      onBlur={onCancel}
      className="w-full rounded border border-accent bg-subtle px-2 py-0.5 font-mono text-meta focus:outline-none"
    />
  );
}
```

- [ ] **Step 2: SettingsDialog.tsx 갱신**

```tsx
import { KeymapSection } from "./settings/KeymapSection";
// ...
{section === "keymap" && <KeymapSection />}
```

- [ ] **Step 3: tsc + lint**

```bash
pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/KeymapSection.tsx src/components/SettingsDialog.tsx
git commit -m "fe/ui: KeymapSection — command list + Edit/Reset, 충돌 감지 UI

- 4 컬럼: Command / Category / Key / Actions
- Edit 클릭 → KeyCaptureInput (input 포커스 → keydown → formatKeyEvent →
  setKeymap IPC). ESC 취소.
- Reset 버튼: bound 인 경우 unsetKeymap. (none) 상태도 표시.
- 충돌 감지: 같은 key 가 2+ command 에 bound 시 ⚠ 아이콘
- SettingsDialog: keymap section 활성화"
```

---

### Task 16: AliasesSection — add/remove + SettingsDialog wire

**Files:**
- Create: `src/components/settings/AliasesSection.tsx`
- Modify: `src/components/SettingsDialog.tsx`

- [ ] **Step 1: AliasesSection.tsx**

```tsx
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useUserAliases, addUserAlias, removeUserAlias } from "@/stores/userAliases";
import { useSavedHosts } from "@/stores/savedHosts";
import { usePanes, activeTab } from "@/stores/panes";
import type { AliasKind } from "@/types/bindings";

export function AliasesSection() {
  const items = useUserAliases((s) => s.items);
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_5rem_1fr_2rem] gap-2 border-b border-border px-2 py-1 text-meta text-fg-muted">
        <div>Name</div>
        <div>Kind</div>
        <div>Target</div>
        <div></div>
      </div>
      {items.map((a) => (
        <div
          key={a.id}
          className="grid grid-cols-[1fr_5rem_1fr_2rem] items-center gap-2 px-2 py-0.5 text-base hover:bg-subtle"
        >
          <div className="truncate">{a.name}</div>
          <div className="text-meta text-fg-muted">{a.kind.kind}</div>
          <div className="truncate font-mono text-meta">
            {a.kind.kind === "navigate"
              ? `${a.kind.location.source.kind === "ssh" ? "ssh:" : ""}${a.kind.location.path}`
              : a.kind.saved_host_alias}
          </div>
          <button
            type="button"
            onClick={() => void removeUserAlias(a.id)}
            className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-danger"
            aria-label="Remove alias"
          >
            <X size={11} />
          </button>
        </div>
      ))}
      {adding ? (
        <AddForm onClose={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 rounded border border-dashed border-border px-2 py-1 text-meta text-fg-muted hover:bg-subtle"
        >
          <Plus size={11} /> Add alias
        </button>
      )}
    </div>
  );
}

function AddForm({ onClose }: { onClose: () => void }) {
  const savedHosts = useSavedHosts((s) => s.hosts);
  const [name, setName] = useState("");
  const [kindStr, setKindStr] = useState<"navigate" | "connect">("navigate");
  // navigate target = 활성 탭 location 디폴트
  const tab = usePanes((s) => activeTab(s, s.activePane));
  const [savedHost, setSavedHost] = useState<string>(savedHosts[0]?.alias ?? "");

  const submit = async () => {
    if (!name.trim()) return;
    let kind: AliasKind;
    if (kindStr === "navigate") {
      kind = { kind: "navigate", location: tab.location };
    } else {
      if (!savedHost) return;
      kind = { kind: "connect", saved_host_alias: savedHost };
    }
    await addUserAlias(name.trim(), kind);
    onClose();
  };

  return (
    <div className="rounded border border-accent bg-subtle p-2">
      <div className="grid grid-cols-[5rem_1fr] items-center gap-2 text-base">
        <label htmlFor="alias-name" className="text-fg-muted">Name</label>
        <input
          id="alias-name"
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-border bg-base px-2 py-1 font-mono"
        />
        <label htmlFor="alias-kind" className="text-fg-muted">Kind</label>
        <select
          id="alias-kind"
          value={kindStr}
          onChange={(e) => setKindStr(e.target.value as "navigate" | "connect")}
          className="rounded border border-border bg-base px-2 py-1"
        >
          <option value="navigate">Navigate (active tab location)</option>
          <option value="connect">Connect (saved host)</option>
        </select>
        {kindStr === "navigate" ? (
          <>
            <div className="text-fg-muted">Target</div>
            <div className="truncate font-mono text-meta text-fg-muted">{tab.location.path}</div>
          </>
        ) : (
          <>
            <label htmlFor="alias-host" className="text-fg-muted">Host</label>
            <select
              id="alias-host"
              value={savedHost}
              onChange={(e) => setSavedHost(e.target.value)}
              className="rounded border border-border bg-base px-2 py-1"
            >
              {savedHosts.length === 0 ? (
                <option value="">(no saved hosts)</option>
              ) : (
                savedHosts.map((h) => <option key={h.alias} value={h.alias}>{h.alias}</option>)
              )}
            </select>
          </>
        )}
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border px-3 py-1 text-base hover:bg-base"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          className="rounded bg-accent px-3 py-1 text-base text-white"
        >
          Add
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: SettingsDialog.tsx 갱신**

```tsx
import { AliasesSection } from "./settings/AliasesSection";
// ...
{section === "aliases" && <AliasesSection />}
```

- [ ] **Step 3: tsc + lint + test**

```bash
pnpm tsc --noEmit 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3 && pnpm test --run 2>&1 | tail -5
```
Expected: clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/AliasesSection.tsx src/components/SettingsDialog.tsx
git commit -m "fe/ui: AliasesSection — list + Add form (Navigate/Connect)

- 4 컬럼: Name / Kind / Target / Remove
- Add form: name + kind selector (Navigate=활성 탭 location 자동 / Connect=
  saved host dropdown)
- SettingsDialog: aliases section 활성화"
```

---

## Phase E — 마무리

### Task 17: ROADMAP MVP-7 + final gates

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
모두 pass 확인.

- [ ] **Step 2: ROADMAP.md**

찾기:
```markdown
## MVP-7: 커맨드 팔레트 + 설정

- [ ] Ctrl+P 커맨드 팔레트
- [ ] 설정 화면 (`Ctrl+,`)
- [ ] `keymap.toml` 핫 리로드
- [ ] 사용자 명령 (alias)
```

대체:
```markdown
## MVP-7: 커맨드 팔레트 + 설정

- [x] Ctrl+P 커맨드 팔레트 — fuzzy 매칭, built-in + saved hosts + bookmarks + favorites + user aliases
- [x] 설정 화면 (`Ctrl+,`) — sidebar/content 섹션화 (General + Keymap + Aliases)
- [x] `keymap.toml` 핫 리로드 — `notify` watcher + `KeymapChangedEvent`
- [x] 사용자 명령 (alias) — Navigate / Connect, user-aliases.json
```

찾기 (현재 단계):
```markdown
**MVP-7 시작 직전.** ...
```
또는 비슷.

대체:
```markdown
**모든 MVP 완료.** MVP-1~7 — duet 의 정식 기능 모두 구현. 이후 장기 (Maybe) 항목 또는 안정화/UX 개선.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
git add ROADMAP.md
git commit -m "docs: MVP-7 완료 표시 — 모든 정식 MVP 완료"
```

---

## 자기 점검

**Spec 커버리지:**

| Spec section | Task |
|---|---|
| A. Command + Registry + buildBuiltins | 3 |
| A. fuzzy.ts | 2 |
| A. keyEvent.ts | 1 |
| A. CommandPalette UI | 4 |
| A. App wire + 임시 Ctrl+P | 5 |
| B. UserAliasesStore + smoke | 6 |
| B. user_aliases IPC | 7 |
| B. stores/userAliases + dynamicCommands hook + App | 8 |
| C. KeymapStore + smoke | 9 |
| C. keymap_events + commands + lib.rs | 10 |
| C. file watcher | 11 |
| C. stores/keymap + useKeymapEvents | 12 |
| C. useGlobalShortcuts 리팩터 | 13 |
| D. SettingsDialog 리팩터 + General | 14 |
| D. KeymapSection | 15 |
| D. AliasesSection | 16 |
| 마무리 | 17 |

**Placeholder scan:** 없음.

**Type consistency:**
- `Command`, `BuiltinDeps`, `useAllCommands` — Task 3 정의, 다른 task 사용 일관
- `KeymapBinding`, `effectiveKey`, `useKeymap` — Task 9/12 정의
- `UserAlias`, `AliasKind` (snake_case) — Task 6/8 정의
- `formatKeyEvent` — Task 1 정의, useGlobalShortcuts (T13) + KeymapSection (T15) 사용

---

## 실행 핸드오프

Plan saved to `docs/plans/2026-05-11-mvp7-command-palette-keymap.md`. 17 tasks. Subagent-driven 또는 inline.
