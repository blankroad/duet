# MVP-5: 검색과 정렬 — 설계

> 듀얼패널 파일 매니저에서 항목 발견/정렬을 위한 5개 기능. 패널 표시 옵션
> (정렬, 숨김, 새로고침), 빠른 필터 (Ctrl+F), 글로벌 검색 (Ctrl+Shift+F).

**상태**: 설계 승인 (2026-05-10) → plan 작성 → 실행

## 목적 + 성공 기준

- **목적**: 큰 디렉토리에서 파일/폴더를 빠르게 좁혀 찾기. 일관된 정렬.
- **성공 기준**:
  1. 100개 항목 디렉토리에서 부분 문자열 입력 즉시 (< 16ms) 필터링
  2. 글로벌 검색이 평균적인 home 디렉토리 (10K 항목) 에서 < 2초 결과
  3. Ctrl+H/R/F/Shift+F/1..5 단축키 모두 작동
  4. 정렬 상태가 패널 전환 / 새로고침 시 유지

## 비목적 (이번 MVP X)

- 글로벌 검색 **내용** 검색 (grep). 파일명만. (후속에서 trait 구현체 추가)
- fuzzy match (fzf 식). substring 만.
- glob 패턴 (`*.ts`). substring 만.
- 검색 결과 streaming. 동기 RPC 한 방.
- 정렬 영속성 (재시작 후 복원). 세션 내 패널당.
- 컬럼 너비 조정 / 컬럼 보이기 숨기기.
- 위치별 정렬 기억 (e.g., home 은 이름순, /var/log 는 mtime).

## 범위 분할

3개 작업 단위 (한 spec, 한 plan, 그러나 task 묶음 분리 가능):

- **A. 패널 표시 옵션** — 정렬 + 숨김 + 새로고침 단축키
- **B. 빠른 필터** — Ctrl+F + PaneFilterBar
- **C. 글로벌 검색** — Ctrl+Shift+F + 백엔드 search trait + SearchPanel

---

## A. 패널 표시 옵션

### State

`src/stores/panes.ts` `PaneState` 추가:

```ts
type SortKey = "name" | "size" | "mtime" | "kind" | "ext";
type SortOrder = "asc" | "desc";

interface PaneState {
  // 기존: location, entries, cursorIndex, ...
  sortKey: SortKey;       // default "name"
  sortOrder: SortOrder;   // default "asc"
  showHidden: boolean;    // default false
}
```

`entries` 는 백엔드 raw 순서 그대로 보존. `displayedEntries` 는 selector 에서
계산:

```
raw → filter (B 가 추가) → hidden (showHidden=false 면 entry.hidden 제거)
    → sort → displayedEntries
```

selector: `selectDisplayedEntries(paneId)` — `useMemo` / zustand selector
combine.

### 정렬 로직 이동

현재 `App.tsx::sortEntries` (dir 먼저 + 이름순) → `stores/panes.ts` selector
로 이동. App 은 raw 만 `setEntries`. 항상 dir-first + sortKey 적용.

### 단축키

| 키 | 동작 |
|---|---|
| Ctrl+H | 활성 패널 `showHidden` toggle |
| Ctrl+R / F5 | 활성 패널 `onRefresh` (이미 callback 존재) |
| Ctrl+1 | 활성 패널 sortKey="name" |
| Ctrl+2 | sortKey="size" |
| Ctrl+3 | sortKey="mtime" |
| Ctrl+4 | sortKey="kind" |
| Ctrl+5 | sortKey="ext" |

같은 key 다시 누르면 sortOrder toggle (asc ↔ desc).

### 컬럼 헤더 클릭

`EntryList` 컬럼 헤더 (Name / Size / Modified / Type) 클릭:
- 같은 key: order toggle
- 다른 key: 새 key + asc

화살표 아이콘 (▲ / ▼) 으로 현재 sortKey + order 시각 표시.

### 입력 차단

input/textarea 포커스 시 `Ctrl+H` 등 패널 단축키 무시 — `e.target.tagName`
체크.

---

## B. 빠른 필터 (Ctrl+F)

### State

`PaneState` 추가:

```ts
interface PaneState {
  // ...
  filter: string;         // default ""
  filterFocused: boolean; // input focus 상태
}
```

### Selector 순서

raw → **filter (filter !== "" 면 substring case-insensitive)** → hidden → sort

### UI: PaneFilterBar

위치: `PathBar` 와 `EntryList` 사이, 한 줄.

```
┌──────────────────────────────┐
│ 🔍 [filter…]              ✕  │  ← filter 비어있고 unfocused 면 숨김
└──────────────────────────────┘
```

- filter 비어있고 unfocused: 컴포넌트 자체 렌더 X (공간 절약)
- 표시 조건: `filter.length > 0 || filterFocused`

### 키 동작

| 컨텍스트 | 키 | 동작 |
|---|---|---|
| 패널 포커스 | Ctrl+F | `filterFocused = true` + input autoFocus |
| filter input 포커스 | ESC | filter clear + filterFocused=false + 패널 포커스 복귀 |
| filter input 포커스 | Enter | 첫 매칭 항목으로 cursorIndex 이동 + filterFocused=false (필터는 유지) |
| filter input 포커스 | ↑↓ | 패널 cursor 이동 (input 떠나지 않음) |

### 자동 clear

다음 시점에 filter 자동 clear:
- 패널이 다른 디렉토리로 navigate (의도된 새 컨텍스트)
- Tab 으로 패널 전환 (현재 활성 패널만 filter 유지)

navigate 시 clear 로직: `pane.location.path` 변경 감지 → filter="" + filterFocused=false.

---

## C. 글로벌 검색 (Ctrl+Shift+F)

### Backend

`src-tauri/src/core/search.rs` (new):

```rust
#[async_trait]
pub trait SearchBackend: Send + Sync {
    async fn search(
        &self,
        root: &Path,
        pattern: &str,
        opts: SearchOpts,
        cancel: CancellationToken,
    ) -> Result<Vec<SearchHit>, DuetError>;
}

pub struct SearchOpts {
    pub case_sensitive: bool,    // default false
    pub include_hidden: bool,    // default false
    pub max_results: usize,      // default 500
}

pub struct SearchHit {
    pub location: Location,      // 부모 디렉토리 (클릭 시 navigate 대상)
    pub name: String,            // 항목 이름
    pub kind: EntryKind,
    pub size: u64,
    pub modified_ms: Option<i64>,
}
```

#### LocalFilenameSearch

`ignore::WalkBuilder` 사용 (`.gitignore` 자동 존중). dep 이미 있음.

```rust
pub struct LocalFilenameSearch;
impl SearchBackend for LocalFilenameSearch {
    async fn search(...) -> Result<Vec<SearchHit>, DuetError> {
        tokio::task::spawn_blocking(move || {
            let walker = WalkBuilder::new(root)
                .hidden(!opts.include_hidden)
                .build();
            let mut hits = Vec::new();
            for entry in walker {
                if cancel.is_cancelled() { return Err(DuetError::Cancelled); }
                if hits.len() >= opts.max_results { break; }
                let entry = entry?;
                let name = entry.file_name().to_string_lossy();
                if matches(pattern, &name, opts.case_sensitive) {
                    hits.push(make_hit(entry));
                }
            }
            Ok(hits)
        }).await?
    }
}
```

#### SshFilenameSearch

`russh` exec 채널로 `find` 실행. 패턴 quoting 안전 (shell escape).

```bash
find <root> \( -type f -o -type d \) \
  [-not -path '*/.*']         # include_hidden=false
  -iname '*<pattern>*'        # case_sensitive=false
  2>/dev/null | head -<max_results>
```

stdout 파싱 → 각 line = 절대경로 → SearchHit 변환. metadata 는 별도 stat
호출 비용 비싸므로 size/mtime 은 `0` / `None` 채움 (UI 에서 placeholder).

후속 v2: `find -printf '%p\t%s\t%T@\n'` 로 한 번에 받기 — 호환성 검토 필요.

### IPC

```rust
#[tauri::command]
async fn search_global(
    root: Location,
    pattern: String,
    opts: SearchOpts,
    pool: State<Arc<ConnectionPool>>,
) -> Result<Vec<SearchHit>, DuetError>;

#[tauri::command]
async fn search_cancel() -> Result<(), DuetError>;
```

backend 가 활성 검색 토큰 1개 보유 (`Mutex<Option<CancellationToken>>`).
새 검색 시작 시 이전 토큰 cancel. `search_cancel` 도 같은 토큰 cancel.

### Frontend

#### State

`src/stores/search.ts` (new):

```ts
type SearchStatus = "idle" | "searching" | "done" | "error" | "cancelled";

interface SearchState {
  isOpen: boolean;
  rootPaneId: PaneId | null;   // 결과 클릭 시 navigate 대상
  root: Location | null;
  query: string;
  results: SearchHit[];
  status: SearchStatus;
  error: string | null;
  open: (paneId: PaneId, root: Location) => void;
  close: () => void;
  setQuery: (q: string) => void;  // 자동 debounce 200ms 후 IPC
}
```

`SearchOpts` / `SearchHit` 는 backend 와 동일 shape — specta `Type` derive
로 frontend 에서 import.

#### UI: SearchPanel

위치: `<header>` 와 `<main>{panes}</main>` 사이 가로 띠.

```
┌──────────────────────────────────────────────┐
│ 🔍 [pattern…]   ☐ Hidden  500 hits  ✕        │  ← input + 옵션 + close
├──────────────────────────────────────────────┤
│ 📂 src/components/Sidebar.tsx                │
│ 📂 src/stores/panes.ts                       │  ← 결과 리스트
│ ... (max 500)                                │
│ + 12 more — refine query                     │  ← 캡 도달 시
└──────────────────────────────────────────────┘
```

- 입력창 autoFocus, ESC = close.
- 패턴 < 2자: 결과 0 + 안내 ("최소 2자")
- debounce 200ms (사용자 입력 끝난 후 IPC).
- 결과 클릭 → originating 패널을 hit.location 으로 navigate + cursor 를
  hit.name 위치로 → SearchPanel close.
- 진행 중 spinner. cancel 가능.

### 키 동작

| 키 | 동작 |
|---|---|
| Ctrl+Shift+F (활성 패널 포커스) | SearchPanel open, root = 활성 패널 location |
| ESC (SearchPanel input) | close |
| Enter (input) | 첫 결과로 navigate (가장 위 hit) |
| ↑↓ (input) | 결과 리스트 cursor 이동 |

---

## Layer / 파일 변경

### 신규

- `src-tauri/src/core/search.rs` — SearchBackend trait + 2 impls + SearchOpts/SearchHit
- `src-tauri/src/commands/search.rs` — `search_global` / `search_cancel`
- `src-tauri/tests/mvp5_search_smoke.rs` — local + ssh-mock smoke
- `src/stores/search.ts` — 검색 상태
- `src/components/pane/PaneFilterBar.tsx` — 필터 input 컴포넌트
- `src/components/SearchPanel.tsx` — 결과 패널

### 수정

- `src-tauri/src/lib.rs` — 2 commands 등록
- `src/stores/panes.ts` — sortKey/sortOrder/showHidden/filter/filterFocused +
  selector
- `src/components/pane/Pane.tsx` — PaneFilterBar 삽입, 정렬 selector 사용
- `src/components/pane/EntryList.tsx` — 헤더 클릭 sort + 화살표 아이콘
- `src/hooks/useGlobalShortcuts.ts` — Ctrl+H/R/F/Shift+F/1..5 추가
- `src/App.tsx` — SearchPanel 렌더, sortEntries 제거 (selector 로 이동)
- `ROADMAP.md` — MVP-5 [x] 표시

---

## 데이터 흐름

### 필터

```
User Ctrl+F (active pane focused)
  → store.setFilterFocused(activePaneId, true)
  → PaneFilterBar mount with autoFocus
User types
  → store.setFilter(activePaneId, str)
  → selector recompute displayedEntries
  → EntryList re-render
User ESC
  → store.setFilter(activePaneId, "")
  → store.setFilterFocused(activePaneId, false)
  → 패널 포커스 복귀
```

### 글로벌 검색

```
User Ctrl+Shift+F (active pane focused)
  → search.open(activePaneId, activePane.location)
  → SearchPanel mount with autoFocus
User types pattern (debounced 200ms)
  → search.setQuery(pattern)
  → commands.searchGlobal(root, pattern, opts)
  → backend: cancel previous + new token + walk
  → search.status = "searching" → "done" with results
User clicks hit
  → navigate(rootPaneId, hit.location)
  → store.setCursor(rootPaneId, name=hit.name)
  → search.close()
```

---

## 에러 / 엣지

- 빈 패턴: IPC 안 보냄, 결과 [].
- 패턴 1자: 안내 "최소 2자". (서버 부하 방지)
- 검색 도중 새 검색: 이전 cancel.
- SSH find 미지원 호스트 (희귀): `Err(NotSupported)` → toast.
- max_results 초과: 잘림 + "+ N more — refine" 표시.
- root 가 권한 없는 디렉토리: SSH 의 경우 `find` stderr 무시 (`2>/dev/null`).
  로컬은 `ignore` walker 가 자동 skip.

---

## 테스트

### Backend

- `core::search::LocalFilenameSearch` 단위 (tempdir 트리):
  - 기본 substring 매칭
  - case insensitivity
  - hidden 옵션
  - max_results cap
  - cancel 즉시 반응
- `tests/mvp5_search_smoke.rs`:
  - 로컬 트리 build (1000 항목) → 검색 → hits 검증
  - SSH backend 는 mock 어려움 — `find` stdout 파서만 단위 테스트

### Frontend

- `stores/panes.test.ts`:
  - selector: filter+hidden+sort 조합 로직
  - sortKey toggle order
- `stores/search.test.ts`:
  - debounce 동작 (vi.useFakeTimers)
  - results setter
- 컴포넌트 스냅샷 (PaneFilterBar, SearchPanel) — 가벼움

---

## 위험 / 미해결

- **SSH `find` 호환성**: macOS / Linux / FreeBSD / busybox 차이. `-iname`
  은 GNU/BSD 양쪽 지원. `-not -path` 도 표준. v1 은 안전한 옵션만 사용.
- **문자 세트**: 결과 stdout 이 UTF-8 가정. 비-UTF8 파일명은 lossy 변환
  (`String::from_utf8_lossy`).
- **단축키 충돌**: Ctrl+1..5 는 MVP-6 탭과 충돌 예정. 가이드: 탭 도입
  시 sort 를 `Ctrl+Shift+1..5` 로 이전.
- **선택 보존**: filter 적용 시 cursor 가 가시 항목에 없으면 자동으로
  첫 매칭으로 이동.

---

## 후속 (다음 MVP 또는 v2)

- 내용 검색 (grep) — `GrepSearch` trait impl, ripgrep 호출
- 결과 streaming (event 기반) — 큰 트리에서 1초 cap 제거
- 정렬 영속성 (settings.toml)
- fuzzy / glob 매칭
- 검색 히스토리
