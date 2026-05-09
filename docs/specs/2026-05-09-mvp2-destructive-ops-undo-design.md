# MVP-2 Design: 파괴적 작업 + Undo 안전망

**Status:** Approved (브레인스토밍 합의 완료, plan 작성 단계)
**Date:** 2026-05-09
**Scope:** ROADMAP MVP-2 12 항목 전부

## Goal

안전하게 복사·이동·삭제할 수 있다. 영구 삭제 사고가 구조적으로 불가능.

## 완료 조건

- 파일/디렉토리: 복사(F5), 이동(F6), 이름변경(F2), 새 폴더(F7), 휴지통(Delete), 영구삭제(Shift+Delete) 가능
- 영구삭제는 설정 OFF 가 디폴트, ON 이어도 단어 타이핑 확인 필수 (CLAUDE.md §3)
- 모든 파괴적 작업은 Journal 에 기록되고 Ctrl+Z 로 N 단계 되돌릴 수 있음 (영구삭제 제외 — Irreversible)
- 충돌(target 존재) 시 자동 backup (`name.bak.<UTC timestamp>`) 후 덮어쓰기 — 작업 흐름 끊지 않음
- 같은 SSH 호스트 안 SSH↔SSH 복사는 명시적 `NotSupported("MVP-3")` (조용한 relay 절대 금지 — CLAUDE.md DON'T)
- LocalFs / SshFs 새 메서드 단위 테스트 통과
- Settings/Journal/Trash 모듈 단위 테스트 통과

## Key decisions (brainstorming)

| # | 질문 | 결정 |
|---|---|---|
| 1 | 같은 호스트 SSH↔SSH 복사 | **Block** with explicit `NotSupported("MVP-3")` 에러. 조용한 relay 안 함 |
| 2 | 충돌 정책 | **자동 backup** — `name.bak.<UTC YYYYMMDD-HHMMSS>` 로 mv 후 덮어쓰기. UndoAction 에 backup 경로 기록 |
| 3 | Undo 범위 | **스택** — N 단계 walk. journal.jsonl 세션 간 영속, 시작 시 tail 100 로드 |
| 4 | 설정/journal 경로 | **`dirs::config_dir()/duet/`** — Mac/Linux/Windows 모두 OS 관습 |

---

## Architecture overview

### 새 백엔드 모듈

- `services/settings.rs` — `<config_dir>/duet/settings.toml` 영속 설정. MVP-2 키: `permanent_delete_enabled: bool` (default false). Future: theme, keymap overrides 등.
- `services/journal.rs` — `<config_dir>/duet/journal.jsonl` append-only 로그 + `VecDeque` 메모리 캐시. 세션 시작 시 tail 100 줄 로드.
- `services/trash.rs` — 로컬 `trash` crate 위임 / 원격 `~/.duet-trash/<batch-id>/<original-absolute-path>/` mv. 한 op = 한 batch dir (timestamp + ULID 로 unique).
- `core/ops.rs` — `Op` trait + 5개 구현 (`Delete`, `Copy`, `Move`, `Rename`, `Mkdir`). `plan()` + `execute()` 두 단계.

### `FileSystem` trait 확장

LocalFs + SshFs 구현 추가:

```rust
async fn metadata(&self, path: &Path) -> Result<EntryMeta, DuetError>;
async fn rename(&self, from: &Path, to: &Path) -> Result<(), DuetError>;
async fn mkdir(&self, path: &Path) -> Result<(), DuetError>;
async fn trash(&self, path: &Path) -> Result<TrashLocation, DuetError>;  // 원격은 batch dir 반환
async fn remove(&self, path: &Path) -> Result<(), DuetError>;             // 영구
async fn copy_relay(
    src_fs: &dyn FileSystem,
    src: &Path,
    dst: &Path,
) -> Result<(), DuetError>;  // 본인 PC 통한 stream copy. local↔ssh 양방향.
```

같은 호스트 SSH↔SSH copy 는 `core::ops::CopyOp::plan()` 에서 `src_fs.source_id().ssh_host_ip() == dst_fs.source_id().ssh_host_ip()` 검사 — 일치 시 `DuetError::NotSupported("same-host SSH copy: MVP-3")`.

### 새 IPC commands

`commands/fs_ops.rs` (신설):
- `fs_delete_plan` / `fs_delete_execute`
- `fs_copy_plan` / `fs_copy_execute`
- `fs_move_plan` / `fs_move_execute`
- `fs_rename` / `fs_mkdir` (단순 — plan 불필요)
- `undo_last` / `undo_history`
- `settings_get` / `settings_set`

새 이벤트:
- `journal-changed` — Journal push 시 emit, 프론트 store 가 listen → Ctrl+Z UI 갱신

### 새 에러 variant

`types::error::DuetError`:
- `NotSupported(String)` — same-host SSH copy 같은 미지원 케이스
- `NotPermitted` (이미 있음) — settings 가 OFF 인데 영구삭제 시도 등에 재사용

---

## Op trait + data flow

```rust
// core/ops.rs

#[async_trait]
pub trait Op {
    type Plan: Serialize + DeserializeOwned + Type;
    type Outcome: Serialize + Type;

    async fn plan(&self, ctx: &OpCtx) -> Result<Self::Plan, DuetError>;
    async fn execute(&self, plan: Self::Plan, ctx: &OpCtx) -> Result<Self::Outcome, DuetError>;
}

pub struct OpCtx {
    pub pool: Arc<ConnectionPool>,
    pub journal: Arc<Journal>,
    pub settings: Arc<Settings>,
}
```

### 두-단계 IPC (plan / execute)

UI 흐름 (delete 예시):
1. 사용자가 Delete 키 / 메뉴 클릭
2. 프론트 → `fs_delete_plan(targets, mode)` → `DeletePlan { mode, targets, total_size_bytes, total_count }` 받음
3. 프론트가 confirm dialog 표시 — Trash 면 파란 Delete, Permanent 면 빨간 + "delete" 타이핑 강제
4. 사용자 OK → `fs_delete_execute(plan)`
5. 백엔드: mode == Permanent 면 `settings.permanent_delete_enabled` 재검증 → false 면 `NotPermitted`. (defense-in-depth — 프론트 우회 차단)
6. 백엔드: 실행 + `Journal::push(entry)` + `JournalId` 반환
7. 프론트: 영향받은 패널 자동 refresh (fs-changed-event 또는 직접 호출)

### Confirmed 토큰 (deviation from ARCHITECTURE.md)

ARCHITECTURE.md `Confirmed(())` private 토큰 패턴은 IPC round-trip 이 끼면 의미가 흐려져 **MVP-2 에서 채택 안 함**. 두 가지 보호로 대체:
- `_plan` / `_execute` 두 단계 IPC — 사용자 확인 단계 강제
- `_execute` 가 백엔드에서 mode/settings 재검증 (defense-in-depth)

추후 ARCHITECTURE.md 동기화 (또는 Confirmed 패턴이 internal core 레이어에서 유효하게 살아남는다면 유지).

---

## Journal + Undo

### Format (`<config_dir>/duet/journal.jsonl`, append-only)

```rust
#[derive(Serialize, Deserialize, Type)]
pub struct JournalEntry {
    pub id: JournalId,                  // ULID — 시간순 정렬 가능
    pub timestamp: DateTime<Utc>,
    pub op: OpKind,                     // 표시용 요약 (e.g. "Trash 3 items from /home/x/")
    pub undo: UndoAction,
    pub undone: bool,                   // true 면 redo 대상 (MVP-2 는 표시만, redo 미구현)
}

#[derive(Serialize, Deserialize, Type)]
#[serde(tag = "kind")]
pub enum UndoAction {
    RestoreFromTrash {
        items: Vec<TrashItem>,          // {trash_path, original_path}
        source: SourceId,
    },
    UndoCopy {
        copied: Vec<PathBuf>,           // 새로 만든 파일들
        backups_to_restore: Vec<BackupRestore>,  // .bak.<ts> 가 있던 충돌건 — 원래 자리로 mv
        target_source: SourceId,
    },
    UndoMove {
        moved: Vec<MoveItem>,           // {src_original, dst_now} — dst → src 로 mv
        src_source: SourceId,
        dst_source: SourceId,
    },
    UndoRename { source: SourceId, current: PathBuf, original: PathBuf },
    UndoMkdir { source: SourceId, path: PathBuf },  // rmdir (안비었으면 skip)
    Irreversible,                       // 영구삭제
}
```

### 스택 동작

- `Journal::push(entry)` — 메모리 캐시 push + jsonl append (fsync)
- `Journal::pop_undoable()` — 가장 최근 `undone == false` entry 반환 + `undone = true` 표시
- `undone` 갱신은 jsonl 끝에 update 레코드 append (compact 는 후속)
- `commands::undo_last()` — pop_undoable() → UndoAction 종류별 디스패치 → `UndoResult` emit + journal-changed event
- 세션 시작 시 jsonl tail 100 줄 로드 → 메모리 스택 복원

### Undo 한계 (UI 토스트로 명시)

- `Irreversible`: "Cannot undo permanent delete" — 사용자 시도 시 즉시 거부
- `UndoMkdir` 가 dir not empty: "Directory not empty — undo skipped" (사용자가 그 사이에 채웠다는 뜻)
- `UndoCopy/UndoMove` 가 dst 가 사라졌으면: "Item no longer exists — undo skipped"
- 조회 시점에 SSH 연결이 끊어져 있으면: "Cannot reach <alias> — undo skipped"

---

## Conflict policy + Trash 명세

### Auto-backup on conflict (copy / move)

- src `A.txt` → dst 에 `A.txt` 이미 존재
- 단계: `mv dst/A.txt → dst/A.txt.bak.<UTC YYYYMMDD-HHMMSS>` → `copy src/A.txt → dst/A.txt`
- 디렉토리도 동일 (`Photos/` → `Photos.bak.<ts>/`)
- timestamp 충돌 시 (1초 내 두 번 같은 timestamp 생성): suffix `.bak.<ts>.<n>` (n=2,3,...)
- backup 경로는 `JournalEntry.undo.UndoCopy.backups_to_restore` 에 기록 — undo 시 자동 복원

### Trash 디렉토리

**로컬:**
- `trash` crate 위임 — OS 기본 휴지통
- 복원 정보 (원본 절대경로) 는 OS 가 관리 — JournalEntry 에는 `trash::TrashItem` id 만 저장
- (트레이드오프) crate 가 OS-specific 복원 API 제공 — undo 시 `trash::os_limited::restore_all(&[item])`

**원격 (SSH):**
- 경로: `~/.duet-trash/<batch-id>/<original-absolute-path>/`
- batch-id = `<UTC YYYYMMDD-HHMMSS>-<ULID>` — 한 delete op 가 한 batch dir 사용
- 원본 절대경로를 디렉토리 구조로 보존 → 같은 op 안에 같은 이름 다른 디렉토리 항목들 충돌 안 함, undo path 명확
- 예: `/home/u/foo.txt` 삭제 → `~/.duet-trash/20260509-123456-01H.../home/u/foo.txt`
- mv 실패 시: 작업 중단 + UI alert. **`rm` 폴백 절대 금지** (CLAUDE.md §3)
- `~/.duet-trash` 자동 정리는 MVP-2 범위 외 — 사용자가 수동

---

## Frontend: UI + 키바인딩

### 키바인딩 (활성 패널 기준)

| Key | Action | Dialog |
|---|---|---|
| `F2` | rename | RenameDialog (단일 입력) |
| `F5` | copy 선택 → 반대 패널 현재 dir | ConfirmDialog (대상 미리보기 + 충돌 리스트) |
| `F6` | move 선택 → 반대 패널 현재 dir | ConfirmDialog |
| `F7` | new folder (활성 패널 현재 dir 안) | MkdirDialog (단일 입력) |
| `Delete` | 선택 → trash | ConfirmDialog (파란 Delete) |
| `Shift+Delete` | 선택 → 영구삭제 | DangerConfirmDialog ("delete" 타이핑) |
| `Ctrl+Z` | undo last | Toast (결과 메시지) |

선택 모델: `panes.selected` (Space 토글 set) 가 비어있지 않으면 그 set, 비어있으면 cursor 위 단일 항목.

`Ctrl+C/X/V` clipboard model 은 MVP-2 범위 외 — F-key 우선.

### 새 컴포넌트

- `components/dialogs/RenameDialog.tsx` — 단일 입력 (DESIGN §1)
- `components/dialogs/MkdirDialog.tsx` — 단일 입력
- `components/dialogs/ConfirmDialog.tsx` — 일반 확인 (DESIGN §2). copy/move/trash 공용
- `components/dialogs/DangerConfirmDialog.tsx` — 단어 타이핑 (DESIGN §3)
- `components/dialogs/ProgressModal.tsx` — copy/move 진행 중 스피너 (% 는 MVP-4)
- `components/SettingsDialog.tsx` — `permanent_delete_enabled` 토글
- `components/Toast.tsx` — undo 결과 / 일반 알림 (MVP-2 는 1개만, queue 는 MVP-4)

### UI 배치

- StatusBar 우측에 gear 아이콘 → SettingsDialog
- ConnectionDialog 처럼 App.tsx 가 dialog state hoist (다이얼로그 종류 늘어나서 prop drilling 피하기)

### Stores

- `stores/ui-dialogs.ts` (신설) — discriminated union `{ kind: "rename" | "mkdir" | "confirm" | "danger-confirm" | "progress" | "settings" | null, payload?: ... }`
- `stores/journal.ts` (신설) — Journal 미러 (Ctrl+Z 가능 여부 등 UI 즉시 반응; 백엔드가 source of truth)

### Hooks

- `hooks/useJournalEvents.ts` — `journal-changed` listen → `journal` store 갱신
- `hooks/useDestructiveKeys.ts` — F2/F5/F6/F7/Delete/Shift+Delete/Ctrl+Z 처리. useGlobalShortcuts 와 분리 (도메인 별)

---

## IPC surface 상세

```rust
// commands/fs_ops.rs

fs_delete_plan(targets: Vec<EntryRef>, mode: DeleteMode) -> DeletePlan
fs_delete_execute(plan: DeletePlan) -> JournalId

fs_copy_plan(src: Vec<EntryRef>, dst: Location) -> CopyPlan
fs_copy_execute(plan: CopyPlan) -> JournalId

fs_move_plan(src: Vec<EntryRef>, dst: Location) -> MovePlan
fs_move_execute(plan: MovePlan) -> JournalId

fs_rename(target: EntryRef, new_name: String) -> JournalId
fs_mkdir(parent: Location, name: String) -> JournalId

undo_last() -> UndoResult
undo_history(limit: u32) -> Vec<JournalEntry>

settings_get() -> Settings
settings_set(patch: SettingsPatch) -> ()
```

### DTOs

```rust
#[derive(Serialize, Deserialize, Type)]
struct DeletePlan {
    mode: DeleteMode,
    targets: Vec<EntryRef>,
    total_size_bytes: u64,
    total_count: u32,
}

#[derive(Serialize, Deserialize, Type)]
struct CopyPlan {
    src_fs: SourceId,
    dst: Location,
    items: Vec<EntryRef>,
    conflicts: Vec<Conflict>,
    total_size_bytes: u64,
}

#[derive(Serialize, Deserialize, Type)]
struct MovePlan {
    src_fs: SourceId,
    dst: Location,
    items: Vec<EntryRef>,
    conflicts: Vec<Conflict>,
    is_same_fs: bool,                   // true 면 rename, false 면 copy + trash
    total_size_bytes: u64,
}

#[derive(Serialize, Deserialize, Type)]
struct Conflict {
    name: String,
    dst_path: String,
    will_become_backup: String,         // .bak.<ts> 결과 미리보기
}

#[derive(Serialize, Deserialize, Type)]
struct UndoResult {
    kind: String,                       // "ok" | "skipped" | "irreversible" | "error"
    message: Option<String>,
    refreshed_locations: Vec<Location>, // 프론트 가 이 패널들 refresh
}

#[derive(Serialize, Deserialize, Type)]
struct Settings {
    permanent_delete_enabled: bool,
}

#[derive(Serialize, Deserialize, Type)]
struct SettingsPatch {
    permanent_delete_enabled: Option<bool>,
}
```

---

## Test strategy

### Backend (TDD — 테스트 먼저)

- `fs/local.rs` 새 메서드: TempDir 기반 단위 테스트
  - rename: dir/file 양쪽
  - mkdir: 이미 있으면 에러, parent 없으면 에러
  - trash: cfg(test) 분기 또는 mock — 실제 OS 휴지통은 안 건드림
  - remove: 파일/빈디렉토리/non-empty 에러
  - copy_relay (LocalFs↔LocalFs 만 단위 테스트, ssh 는 후속)
- `fs/ssh.rs` 새 메서드: 컴파일 + 시그니처 sanity 만 (실제 SFTP 는 docker 후속)
- `core/ops.rs`:
  - DeletePlan total_size 계산
  - CopyPlan/MovePlan conflict 감지
  - same-host SSH copy block (SourceId 비교 로직)
- `services/settings.rs`: tempfile 기반 TOML round-trip + default 값
- `services/journal.rs`: tempfile 기반 jsonl append/load tail/스택 동작
- `services/trash.rs`: batch dir 명명 (timestamp + ULID), 원격 trash path 계산

### Frontend

- `stores/ui-dialogs.test.ts`: open/close 동작
- `stores/journal.test.ts`: 이벤트 → 캐시 갱신
- 다이얼로그 컴포넌트: 핵심 인터랙션 1개씩 (RTL spot-check)
  - DangerConfirmDialog: "delete" 입력 전엔 버튼 disabled
  - ConfirmDialog: 충돌 리스트 표시

---

## Phase 분할 (각 = 한 세션 단위 권장)

- **Phase A — Foundation**
  - `services/settings.rs` + `commands::settings_get/set` + SettingsDialog
  - `services/journal.rs` + 단위 테스트
  - 새 에러 variant `NotSupported`
- **Phase B — FileSystem 확장**
  - LocalFs 새 메서드 (rename/mkdir/trash/remove/copy_relay) + 테스트
  - SshFs 새 메서드 (sftp.rename/mkdir/원격 trash dir mv/remove)
  - `services/trash.rs` (원격 batch dir 명명)
- **Phase C — Op layer + IPC commands**
  - `core/ops.rs` (5 op + plan)
  - `commands/fs_ops.rs` (10 commands) + lib.rs 등록
  - same-host SSH copy block 검증
- **Phase D — Undo**
  - UndoAction 디스패처 (5 variants)
  - `undo_last` command + `journal-changed` 이벤트
- **Phase E — Frontend**
  - 6개 다이얼로그 컴포넌트
  - `useDestructiveKeys` 키바인딩
  - `ui-dialogs` / `journal` store + `useJournalEvents`
  - App.tsx 통합 + Toast
- **Phase F — 마무리**
  - 수동 검증 (`pnpm tauri dev`)
  - cargo fmt/clippy/test, pnpm tsc/lint/test
  - ROADMAP MVP-2 [x]

범위: 12 항목 모두 단일 plan 안. plan 파일 1개 (MVP-1 과 같은 구조). 세션 분할은 Phase 단위.

---

## Open items / deferred

- **MVP-3**: 같은 호스트 SSH↔SSH cp/rsync exec 최적화. MVP-2 는 명시적 block.
- **MVP-4**: TaskQueue + 진행률 % + 취소. MVP-2 는 모달 spinner 만.
- **MVP-7+**: Drag-drop 복사/이동, Ctrl+C/X/V clipboard model, redo (Ctrl+Shift+Z), `~/.duet-trash` 자동 정리.

---

## CLAUDE.md 규약 준수 체크

- §1 IPC 경계: 모든 새 op 는 Tauri command 통해서만. 프론트는 fs API 직접 호출 안 함. ✅
- §2 백엔드 레이어 단방향: `commands → services → core → fs → platform`. core/ops 가 fs/services 사용; commands 가 core/ops 호출. ✅
- §3 영구삭제 디폴트 OFF + 단어 타이핑: `Settings.permanent_delete_enabled` default false + DangerConfirmDialog. ✅
- §4 모든 파괴적 작업 undo 가능: 영구삭제 제외, 나머지는 UndoAction. ✅
- §5 SSH 자격증명 노출 금지: MVP-2 는 자격증명 다루지 않음 — 무관.
- §6 의존성 추가 명시 승인: `trash` (이미 있음), `ulid` (필요 시 사용자 승인), `tempfile` dev (이미 있음). 사용자 승인 후 추가.
- §7 Path 직접 조작 금지: 모든 경로는 `Path`/`PathBuf`. SSH path 는 String 노출 (POSIX 가정) — fs/ssh.rs 만.
- §8 unsafe 금지: 새 코드 unsafe 없음.
- §9 시스템 SSH 호출 금지: russh-sftp 만 사용. 같은-host cp exec 은 MVP-3.

## 의존성 추가 예정

- `ulid` (~50KB) — JournalId / trash batch-id 용. `uuid` 대신 ulid 가 시간순 정렬 가능해서 jsonl tail 에 유리. plan 단계에서 사용자 재확인.

---

## Spec self-review

- [x] Placeholder scan: TBD/TODO 없음
- [x] Internal consistency: Phase A-F 가 design 의 모듈/컴포넌트와 1:1
- [x] Scope check: 단일 plan 으로 처리 가능 (Phase 단위로 세션 분할 권장)
- [x] Ambiguity check: 충돌 정책, undo 범위, 같은-host 정책 등 모두 명시적 결정
