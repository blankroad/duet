# MVP-7: 커맨드 팔레트 + 설정 + 키맵 핫 리로드 + 사용자 명령 — 설계

> 모든 명령을 한 곳에서 실행하는 팔레트 (Ctrl+P), 외부 편집 가능한 keymap.toml
> 핫 리로드, 설정 GUI 섹션화 (General + Keymap editor + Aliases), 사용자
> 정의 navigation alias.

**상태**: 설계 승인 (2026-05-11) → plan → 실행

## 목적 + 성공 기준

- **목적**: 키 외우기 부담 줄이기, 키 재정의 가능, 자주 가는 곳을 alias 로
- **성공 기준**:
  1. Ctrl+P → 모든 built-in/saved-host/bookmark/favorite/alias fuzzy 검색 + Enter 실행
  2. keymap.toml 외부 편집 → 재시작 없이 즉시 반영
  3. Settings GUI 에서 키 재정의 (row Edit + 키 입력)
  4. user alias (navigate / connect) 추가/삭제 → 팔레트 즉시 표시

## 비목적

- shell exec alias (script 실행) — 후속 (장기 (Maybe))
- 다중 keymap profile (vim/emacs 모드) — 후속
- 팔레트 history (최근 사용 우선) — 후속
- in-GUI 단축키 충돌 자동 해결 — UI 경고만, 사용자 수동 정리
- Theme / Default sort 설정 — 후속 (이번 MVP 비용 회피)

## 작업 단위

4 phases (한 spec, 한 plan):
- **A. Command Registry + Palette UI** — registry, fuzzy match, Ctrl+P 모달
- **B. Dynamic providers + User aliases** — 4 store subscribe, alias storage
- **C. Keymap externalization + Hot reload** — TOML, file watcher, useGlobalShortcuts 리팩터
- **D. Settings GUI 섹션화** — General + Keymap editor + Aliases editor

---

## A. Command Registry + Palette

### Command 정의

`src/lib/commands.ts` (new):

```ts
export type CommandCategory =
  | "Tab" | "Navigation" | "View" | "Sort" | "Filter"
  | "Search" | "Connection" | "Settings" | "User";

export interface Command {
  id: string;              // "tab.new", "pane.refresh", ...
  label: string;           // "New tab"
  category: CommandCategory;
  defaultKey?: string;     // "Ctrl+T" — 디폴트 binding (display + keymap fallback)
  action: () => void;
}

export function buildBuiltins(deps: BuiltinDeps): Command[] {
  return [
    { id: "tab.new", label: "New tab", category: "Tab", defaultKey: "Ctrl+T",
      action: () => deps.openActiveTab() },
    // ... 기존 모든 단축키 매핑
  ];
}
```

`BuiltinDeps`: navigate / onRefresh / onBack / onForward / openSettings / openPalette / closeActiveTab / 등 callback 모음.

### Registry store

`src/stores/commands.ts` (new):

```ts
interface CommandsState {
  builtins: Command[];
  dynamic: Command[];
  setBuiltins: (cs: Command[]) => void;
  setDynamic: (cs: Command[]) => void;
}

export const useCommands = create<CommandsState>(...);
export function useAllCommands(): Command[] {
  return useCommands(s => [...s.builtins, ...s.dynamic]);
}
```

### Fuzzy match

`src/lib/fuzzy.ts` (new) — subsequence + scoring (~50 줄):

```ts
export function fuzzyScore(query: string, text: string): number | null;
// null = 매치 안 됨. 양수 = 매치, 클수록 좋은 매치.
```

알고리즘:
- query 의 char 가 모두 text 안 subsequence 면 매치
- bonus: word boundary (camelCase 시작, '.'/' '/'_' 직후, capital)
- bonus: 연속 매칭
- 빈 query → score=0 (모든 항목 표시)

### Palette UI

`src/components/CommandPalette.tsx` (new):

- Modal (Radix Dialog), Ctrl+P 토글 (built-in command "palette.open" 가 ui store toggle)
- 입력 autoFocus, ↑↓ cursor, Enter 실행, ESC close
- 결과 행: `<icon> <label> <category> <key>` (4 컬럼)
- 빈 query: 모든 commands (defaultKey 있는 것 우선, 그다음 alphabetic)
- 입력 후: fuzzyScore desc 정렬, score=null 제외
- 키 충돌은 표시 안 함 (Settings GUI 에서)

Palette 자체 state — `src/stores/palette.ts` (단순 boolean):
```ts
interface PaletteState { isOpen: boolean; open: () => void; close: () => void; }
```

---

## B. Dynamic Providers + User Aliases

### Dynamic providers

`src/lib/dynamicCommands.ts` (new) — 4 store subscribe + Command[] build:

```ts
export function useDynamicCommands(deps: DynamicDeps) {
  const savedHosts = useSavedHosts((s) => s.hosts);
  const bookmarks = useBookmarks((s) => s.items);
  const hostFavorites = useHostFavorites((s) => s.items);
  const userAliases = useUserAliases((s) => s.items);
  const setDynamic = useCommands((s) => s.setDynamic);

  useEffect(() => {
    const cmds: Command[] = [
      ...savedHosts.map((h) => ({ id: `host.connect:${h.alias}`, label: `Connect: ${h.alias}`, category: "Connection", action: () => deps.onSavedActivate(h) })),
      ...bookmarks.map((b) => ({ id: `bookmark.open:${b.id}`, label: `Bookmark: ${b.name}`, category: "Navigation", action: () => deps.onBookmarkActivate(b.location) })),
      ...hostFavorites.map((f) => ({ id: `favorite.open:${f.id}`, label: `${f.host_alias} → ${f.name}`, category: "Connection", action: () => deps.onFavoriteActivate(f) })),
      ...userAliases.map((a) => ({ id: `alias:${a.id}`, label: a.name, category: "User", action: () => deps.onAliasExecute(a) })),
    ];
    setDynamic(cmds);
  }, [savedHosts, bookmarks, hostFavorites, userAliases, setDynamic, deps]);
}
```

App 에서 호출: `useDynamicCommands({ onSavedActivate, onBookmarkActivate, onFavoriteActivate, onAliasExecute })`.

### User aliases

#### Backend

`src-tauri/src/services/user_aliases.rs` (new):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UserAlias {
    pub id: String,
    pub name: String,           // 팔레트 표시명
    pub kind: AliasKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AliasKind {
    Navigate { location: Location },
    Connect { saved_host_alias: String },
}

pub struct UserAliasesStore { /* SavedHostsStore 패턴 */ }
// API: list / add / remove
```

저장: `<config_dir>/duet/user-aliases.json`.

#### IPC

- `user_aliases_list() -> Vec<UserAlias>`
- `user_aliases_add(name, kind) -> Vec<UserAlias>`
- `user_aliases_remove(id) -> Vec<UserAlias>`

#### Frontend

`src/stores/userAliases.ts` — bookmarks store 동형.

#### Alias 실행

`onAliasExecute(alias)` (App.tsx):
- `Navigate`: `navigateTo(activePane, alias.kind.location)`
- `Connect`: 활성 connection 검색 → 없으면 toast "Connect to <alias> first"; 있으면 navigate to home (또는 그냥 활성 표시)

---

## C. Keymap Externalization + Hot Reload

### TOML 형식

`<config_dir>/duet/keymap.toml`:

```toml
# 키 → command id. 빈 파일 / 파일 없음 = 모두 default key 사용.
# 같은 command 에 multiple key bind 가능 (vim 모드 위해 후속).

[bindings]
"Ctrl+T" = "tab.new"
"Ctrl+W" = "tab.close"
"Alt+Left" = "nav.back"
# ...
```

### Backend

`src-tauri/src/services/keymap.rs` (new):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct KeymapBinding {
    pub key: String,
    pub command_id: String,
}

pub struct KeymapStore {
    path: PathBuf,
    inner: RwLock<Vec<KeymapBinding>>,
}

// API: list / set (key, command_id) / unset (key) / reset (clear all)
// TOML 형식: [bindings] 테이블의 키 = command_id
```

### File watcher (hot reload)

backend `run()` setup 에서 `notify::Watcher` 로 keymap.toml watch:

```rust
// pseudo
let watcher = notify::recommended_watcher(move |res| {
    if let Ok(event) = res {
        if event.kind.is_modify() {
            // re-read + parse + diff + emit if changed
            let new = read_keymap_file().await?;
            if new != current { store.replace(new); emit KeymapChangedEvent; }
        }
    }
});
watcher.watch(&keymap_path, RecursiveMode::NonRecursive);
```

`KeymapChangedEvent { bindings: Vec<KeymapBinding> }` — typed event (specta).

**무한 루프 방지**: GUI 에서 `keymap_set` 호출 → 파일 쓰기 → watcher 감지 → 같은 내용 — store 와 동일하면 emit 안 함.

### IPC

- `keymap_list() -> Vec<KeymapBinding>`
- `keymap_set(key, command_id) -> Vec<KeymapBinding>`
- `keymap_unset(key) -> Vec<KeymapBinding>`
- `keymap_reset() -> Vec<KeymapBinding>`
- Event: `KeymapChangedEvent { bindings }`

### Frontend keymap store

`src/stores/keymap.ts`:

```ts
interface State {
  bindings: KeymapBinding[];
  setAll: (b: KeymapBinding[]) => void;
}

export const useKeymap = create<State>(...);

export function effectiveKey(commandId: string, bindings: KeymapBinding[], defaultKey?: string): string | undefined {
  const override = bindings.find((b) => b.command_id === commandId);
  return override?.key ?? defaultKey;
}
```

### useKeymapEvents hook

`src/hooks/useKeymapEvents.ts`:
- 마운트 시 `keymap_list` → `useKeymap.setAll`
- `KeymapChangedEvent` 구독 → `useKeymap.setAll`

### useGlobalShortcuts 리팩터

기존 hardcoded switch 제거. 새 패턴:

```ts
export function useGlobalShortcuts() {
  const bindings = useKeymap((s) => s.bindings);
  const commands = useAllCommands();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isInput = tag === "input" || tag === "textarea";

      const keystr = formatKeyEvent(e);   // "Ctrl+Shift+F" 정규화
      if (!keystr) return;

      // override 우선
      const binding = bindings.find((b) => b.key === keystr);
      let commandId = binding?.command_id;

      if (!commandId) {
        // defaultKey 매칭
        const cmd = commands.find((c) => c.defaultKey === keystr);
        commandId = cmd?.id;
      }

      if (!commandId) return;

      const cmd = commands.find((c) => c.id === commandId);
      if (!cmd) return;

      // input 차단 정책: 일부 commands 는 input 안에서도 허용 (filter.focus 등)
      // metadata: command.allowInInput?: boolean. 디폴트 false.
      if (isInput && !cmd.allowInInput) return;

      e.preventDefault();
      cmd.action();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bindings, commands]);
}
```

`formatKeyEvent` (`src/lib/keyEvent.ts`): KeyboardEvent → 표준 문자열. macOS 의 metaKey 는 "Cmd" 가 아닌 "Ctrl" 로 정규화 (cross-platform 통일 — 디스플레이만 ⌘ 표시).

### Command meta 확장

`Command.allowInInput?: boolean`. 디폴트 false. filter input 에 들어간 상태에서도 동작해야 하는 command (예: ESC 가 모든 곳에서 작동) 만 true. 기존 isInput 차단 로직 통합.

---

## D. Settings GUI 섹션화

### Layout 변경

기존 SettingsDialog 가 좌측 사이드바 + 우측 content 로:

```
┌────────────────────────────────────┐
│ Settings                       ✕   │
├──────────┬─────────────────────────┤
│ General  │  [section content]      │
│ Keymap   │                         │
│ Aliases  │                         │
└──────────┴─────────────────────────┘
```

좌측 sidebar: 클릭 시 우측 content 변경. activeSection state.

### General section

기존 + 추가:
- **Permanent delete enabled** (기존)
- **Open keymap.toml in external editor** (button) — backend `open_in_editor(path)` IPC 가 OS default 로 열기

### Keymap section

모든 command list (built-in + dynamic). 각 row:

```
┌─────────────────────────────────────────────────────────┐
│ Command            Cat   Key            Actions         │
├─────────────────────────────────────────────────────────┤
│ New tab            Tab   Ctrl+T         [Edit]          │
│ Sort by name       Sort  Ctrl+Shift+1   [Edit] [Reset]  │
│ Bookmark: Project  Nav   (none)         [Edit]          │
│ ...                                                     │
└─────────────────────────────────────────────────────────┘
```

- **Edit** 클릭 → row inline input "Press a key combination..." 표시. 다음 keydown 캡쳐 → formatKeyEvent → keymap_set IPC.
- **Reset** 클릭 (binding 있을 때만) → keymap_unset.
- 충돌 표시: 같은 key 가 여러 command 에 bound 시 ⚠ 아이콘.

### Aliases section

User alias 관리:

```
┌──────────────────────────────────────────────┐
│ Name           Kind        Target            │
├──────────────────────────────────────────────┤
│ go-work        Navigate    /Users/me/work    │  [X]
│ prod-server    Connect     prod              │  [X]
│ [+ Add alias]                                │
└──────────────────────────────────────────────┘
```

Add: simple form (name + kind selector + target input). target 의 형태:
- Navigate: location (currently active tab 의 location 디폴트)
- Connect: saved_host_alias (saved hosts 에서 dropdown)

---

## 통합 / 충돌

### 기존 코드 영향

- **useGlobalShortcuts** 완전 리팩터. opts (onRefresh/onBack/onForward) 제거. command builders 의 deps 가 그 기능 소화.
- **App.tsx** — buildBuiltins 에 모든 callback 주입. useGlobalShortcuts 호출 인자 단순화.
- **useKeyboardNav** — 그대로 유지 (contextual pane nav 는 commands 와 별개).

### 호환성

keymap.toml 비어있거나 없으면 모든 command 가 defaultKey (이전 hardcoded 단축키와 동일) 사용. 사용자 무행동 시 변화 없음.

### 빈 state

- 첫 실행: keymap.toml 없음 → 모든 default 적용
- 첫 실행: user-aliases.json 없음 → 빈 list
- 모든 command 는 defaultKey 가 없어도 OK (palette 에서만 접근 가능)

---

## 데이터 흐름

### Palette 실행

```
사용자 Ctrl+P
  → useGlobalShortcuts: keymap lookup → "palette.open" command
  → command.action() = usePalette.getState().open()
  → CommandPalette 컴포넌트 mount, autoFocus
  → 사용자 입력 "ot"
  → useAllCommands().filter+score → ranking
  → 사용자 ↓ → Enter
  → command.action() 실행 (예: openTab)
  → palette.close()
```

### Keymap 외부 편집

```
사용자가 keymap.toml 직접 편집 + save
  → notify watcher → modify event
  → backend: re-read + parse + diff
  → 변경있음 → store 갱신 + KeymapChangedEvent emit
  → frontend useKeymapEvents → useKeymap.setAll
  → useGlobalShortcuts 가 새 bindings 로 re-bind handler
  → Settings GUI 열려있으면 row 자동 갱신
```

### Settings GUI 키 재지정

```
사용자 KeymapSection → row "New tab" → [Edit]
  → row 가 input 모드, "Press a key..."
  → 사용자 Ctrl+Shift+N 누름
  → formatKeyEvent → "Ctrl+Shift+N"
  → commands.keymapSet("Ctrl+Shift+N", "tab.new")
  → backend: bindings 갱신 + 파일 쓰기
  → 파일 변경 → watcher 감지하지만 store 와 동일 → emit 안 함
  → 호출 IPC 의 반환값으로 store 갱신 (이미 OK)
  → 즉시 활성
```

---

## 에러 / 엣지

- **keymap.toml parse 실패**: tracing::warn + store 그대로 (stale OK).
- **keymap.toml 가 unknown command_id 참조**: useGlobalShortcuts 가 commands.find → undefined → no-op. 무해.
- **Hot reload 무한 루프**: store 와 동일 내용 비교 → emit 안 함.
- **palette 에서 alias 실행 실패** (Connect alias, saved host 가 disconnected): toast "Connect to <alias> first".
- **충돌 키**: 같은 key 가 여러 binding → 마지막 wins (Vec 순서). GUI 에서 ⚠ 표시.
- **input 안 단축키**: command.allowInInput 으로 관리. 미설정 = 차단.

---

## 테스트

### Backend

- `services::keymap`: list/set/unset/reset roundtrip + TOML parse/write
- `services::user_aliases`: list/add/remove + AliasKind serde (snake_case)
- `tests/mvp7_keymap_smoke.rs`: TOML 직접 편집 → reload (file watcher 단위 검증은 어려움 — 후속)
- `tests/mvp7_user_aliases_smoke.rs`: 라이프사이클

### Frontend

- `lib/fuzzy.test.ts`: 기본 매칭 / scoring / null 반환 / word boundary bonus
- `lib/keyEvent.test.ts`: KeyboardEvent → 정규화 (Ctrl+Shift+F 등)
- `stores/commands.test.ts`: builtins/dynamic 분리, useAllCommands
- `stores/keymap.test.ts`: setAll + effectiveKey
- `stores/userAliases.test.ts`: bootstrap/add/remove
- 컴포넌트 스냅샷 가벼움 (CommandPalette, KeymapSection)

---

## 후속

- shell exec alias (장기 Maybe 의 일부)
- 다중 keymap profile (vim/emacs 모드)
- 팔레트 history (최근 사용 우선)
- 키 충돌 자동 해결 / 제안
- Theme / Default sort / 기타 settings 항목
- alias 의 Navigate target 을 path string 외에 saved_host+path 조합으로 확장
