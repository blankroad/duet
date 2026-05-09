# MVP-2 Implementation Plan: 파괴적 작업 + Undo 안전망

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 안전하게 복사·이동·삭제할 수 있고, 영구 삭제 사고 구조적 불가능, Ctrl+Z로 N단계 undo.

**Architecture:** ARCHITECTURE.md `Op` trait 패턴 기반. 새 백엔드 모듈 4개 (settings/journal/trash/ops) + FileSystem trait 확장 + 10개 IPC command + 6개 frontend dialog. 자동 backup (`.bak.<ts>`) 으로 충돌 무중단. 같은 호스트 SSH↔SSH copy는 `NotSupported("MVP-3")` block.

**Tech Stack:** Rust (tauri 2.1, russh-sftp 2.0, trash 5, notify 7 — 이미 deps), `uuid v7` (시간순 ULID 대체 — uuid 새 feature), `tempfile` (이미 dev-dep). Frontend (zustand 5, @radix-ui/react-dialog 1.1 — 이미 있음).

**Spec reference:** `docs/specs/2026-05-09-mvp2-destructive-ops-undo-design.md`

**현재 상태 (MVP-1 거의 완료):**
- ✅ FileSystem trait + LocalFs + SshFs (list 만)
- ✅ ConnectionPool, ssh config, connect 인증, ProxyJump, fs:changed, connection:state, supervisor
- ✅ commands: list_directory, home_directory, ssh_config_hosts, connection_*, pane_watch_set
- ✅ Frontend: 듀얼 패널, ConnectionDialog, Sidebar 호스트, useTauri/useFsChangedEvents/useConnectionEvents
- ⚠ 비밀번호 secure prompt (Task 7b) 미구현

**완료 조건 (ROADMAP MVP-2 일치):**
- 파일 복사(F5)/이동(F6)/이름변경(F2)/새폴더(F7)/휴지통(Delete)/영구삭제(Shift+Delete)
- 영구삭제 디폴트 OFF + 단어 타이핑 ("delete")
- 모든 파괴적 작업 Journal 기록 + Ctrl+Z N단계 undo (영구삭제 제외)
- 충돌 시 자동 backup (`name.bak.<UTC ts>`)
- 같은-호스트 SSH↔SSH copy block (`NotSupported("MVP-3")`)
- 백엔드 fs/core/services 단위 테스트 통과

---

## 작업 흐름 가이드

각 Task = 독립 커밋. **TDD**: 백엔드 fs/core/services 레이어는 테스트 먼저. 프론트는 store/util 만 테스트.

**커밋 메시지 scope:**
- `be/svc` services (settings, journal, trash)
- `be/fs` LocalFs/SshFs 확장
- `be/core` core/ops
- `be/cmd` commands/fs_ops
- `be/types` 에러 variant
- `fe/store` ui-dialogs, journal store
- `fe/hook` useDestructiveKeys, useJournalEvents
- `fe/ui` dialog components, Toast, SettingsDialog
- `docs` ROADMAP, ARCHITECTURE 동기화

**의존성 추가 예정 (CLAUDE.md §6 — 사용자 승인 필요):**
- `uuid` 의 `"v7"` feature 추가 (이미 v4 사용 중) — JournalId 시간순 정렬용. 새 crate 아님.
- 그 외 추가 없음.

---

## Phase A: Foundation (Settings + Journal 인프라)

### Task 1: NotSupported 에러 variant 추가

**Files:**
- Modify: `src-tauri/src/types/error.rs`

- [ ] **Step 1: 새 variant 추가**

`src-tauri/src/types/error.rs` 의 `DuetError` enum 에 추가:

```rust
#[error("not supported: {0}")]
NotSupported(String),
```

위치: `Cancelled` 와 `Io` 사이 (알파벳 순 아니라 의미별 그룹).

- [ ] **Step 2: bindings 재생성 + 컴파일 확인**

```bash
cd src-tauri && cargo run --bin export_bindings
cargo check --lib --tests
```

`src/types/bindings.ts` 의 `DuetError` union 에 `{ kind: "NotSupported"; message: string }` 추가됐는지 확인.

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/types/error.rs src/types/bindings.ts
git commit -m "be/types: NotSupported 에러 variant — same-host SSH copy 등 미지원 케이스용"
```

---

### Task 2: services/settings.rs

**Files:**
- Create: `src-tauri/src/services/settings.rs`
- Modify: `src-tauri/src/services/mod.rs`

**Why:** `permanent_delete_enabled` 같은 영속 설정 필요. `dirs::config_dir()/duet/settings.toml` 에 TOML 으로.

- [ ] **Step 1: services/mod.rs 등록**

```rust
pub mod settings;
```

- [ ] **Step 2: settings.rs 작성 (테스트 먼저)**

```rust
//! 영속 설정. `<config_dir>/duet/settings.toml`.
//!
//! 필드 추가 시 `Default` impl + TOML 호환성 (없는 키는 default).

use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct Settings {
    /// 영구 삭제 (Shift+Delete) 메뉴 활성화. CLAUDE.md §3 — 디폴트 false.
    #[serde(default)]
    pub permanent_delete_enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Type, Default)]
pub struct SettingsPatch {
    pub permanent_delete_enabled: Option<bool>,
}

/// In-memory cache + on-disk TOML. 동시 접근은 RwLock.
pub struct SettingsStore {
    path: PathBuf,
    inner: RwLock<Settings>,
}

impl SettingsStore {
    /// `<config_dir>/duet/settings.toml` 위치에 store 초기화 — 파일 없으면 default.
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("settings.toml");
        Self::load_from(&path).await
    }

    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let settings = if path.exists() {
            let text = tokio::fs::read_to_string(path).await.map_err(DuetError::from)?;
            toml::from_str::<Settings>(&text)
                .map_err(|e| DuetError::Io(format!("settings parse: {e}")))?
        } else {
            Settings::default()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(settings),
        }))
    }

    pub async fn get(&self) -> Settings {
        self.inner.read().await.clone()
    }

    pub async fn apply(&self, patch: SettingsPatch) -> Result<Settings, DuetError> {
        let mut s = self.inner.write().await;
        if let Some(v) = patch.permanent_delete_enabled {
            s.permanent_delete_enabled = v;
        }
        let snapshot = s.clone();
        // 디스크 동기화 — write lock 잡은 채로 (race 방지)
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(DuetError::from)?;
        }
        let text = toml::to_string_pretty(&snapshot)
            .map_err(|e| DuetError::Io(format!("settings serialize: {e}")))?;
        tokio::fs::write(&self.path, text).await.map_err(DuetError::from)?;
        Ok(snapshot)
    }
}

/// `<config_dir>/duet` — 모든 영속 데이터 (settings, journal, trash 메타) 의 루트.
pub fn duet_config_dir() -> Result<PathBuf, DuetError> {
    dirs::config_dir()
        .map(|d| d.join("duet"))
        .ok_or_else(|| DuetError::Io("config dir not available".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn missing_file_uses_default() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.toml");
        let store = SettingsStore::load_from(&path).await.unwrap();
        assert!(!store.get().await.permanent_delete_enabled);
    }

    #[tokio::test]
    async fn round_trip_patch() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.toml");
        let store = SettingsStore::load_from(&path).await.unwrap();

        let updated = store
            .apply(SettingsPatch { permanent_delete_enabled: Some(true) })
            .await
            .unwrap();
        assert!(updated.permanent_delete_enabled);

        // 새 store 로 다시 읽어서 영속 확인
        let store2 = SettingsStore::load_from(&path).await.unwrap();
        assert!(store2.get().await.permanent_delete_enabled);
    }

    #[tokio::test]
    async fn unknown_keys_in_toml_dont_fail() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.toml");
        tokio::fs::write(&path, "permanent_delete_enabled = false\nfuture_key = 42\n")
            .await
            .unwrap();
        // serde(default) 라 unknown 은 무시되어야 함 — but toml strict by default.
        // 만약 실패하면 #[serde(deny_unknown_fields)] 안 쓰는 게 default 이므로 OK.
        let store = SettingsStore::load_from(&path).await.unwrap();
        assert!(!store.get().await.permanent_delete_enabled);
    }
}
```

- [ ] **Step 3: 테스트 실행**

```bash
cd src-tauri && cargo test --lib services::settings
```

기대: 3 passed.

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/services/
git commit -m "be/svc: SettingsStore — TOML 영속 설정 (config_dir/duet/settings.toml)

- permanent_delete_enabled (default false) — CLAUDE.md §3
- duet_config_dir() helper (journal/trash 도 같은 루트 사용)
- 3 tests: default, round-trip, unknown-keys-tolerant"
```

---

### Task 3: services/journal.rs

**Files:**
- Create: `src-tauri/src/services/journal.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/Cargo.toml` (uuid v7 feature)

**Why:** 모든 파괴적 작업 기록 + undo 정보. jsonl append-only + 메모리 캐시.

- [ ] **Step 1: Cargo.toml uuid feature 추가**

```toml
uuid = { version = "1", features = ["v4", "v7", "serde"] }
```

- [ ] **Step 2: services/mod.rs 등록**

```rust
pub mod journal;
```

- [ ] **Step 3: journal.rs 작성**

```rust
//! 파괴적 작업 로그 + undo 데이터.
//!
//! `<config_dir>/duet/journal.jsonl` append-only. 세션 시작 시 tail N 로드해
//! 메모리 캐시 (VecDeque) 복원. push/pop 은 메모리 우선 + 디스크 동기.

use crate::services::settings::duet_config_dir;
use crate::types::{DuetError, Location, SourceId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use uuid::Uuid;

const TAIL_LOAD_LIMIT: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct JournalId(pub Uuid);

impl JournalId {
    pub fn new() -> Self {
        // uuid v7 — 시간순 정렬 가능 (ULID 와 같은 특성)
        Self(Uuid::now_v7())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct JournalEntry {
    pub id: JournalId,
    pub timestamp: DateTime<Utc>,
    pub op: OpKind,
    pub undo: UndoAction,
    pub undone: bool,
}

/// 표시용 op 요약.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpKind {
    Trash { count: u32, location: Location },
    PermanentDelete { count: u32, location: Location },
    Copy { count: u32, src: Location, dst: Location },
    Move { count: u32, src: Location, dst: Location },
    Rename { from: PathBuf, to: PathBuf, source: SourceId },
    Mkdir { path: PathBuf, source: SourceId },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UndoAction {
    RestoreFromTrash {
        source: SourceId,
        items: Vec<TrashItem>,
    },
    UndoCopy {
        target_source: SourceId,
        copied: Vec<PathBuf>,
        backups_to_restore: Vec<BackupRestore>,
    },
    UndoMove {
        src_source: SourceId,
        dst_source: SourceId,
        moved: Vec<MoveItem>,
        backups_to_restore: Vec<BackupRestore>,
    },
    UndoRename {
        source: SourceId,
        current: PathBuf,
        original: PathBuf,
    },
    UndoMkdir {
        source: SourceId,
        path: PathBuf,
    },
    Irreversible,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TrashItem {
    /// 로컬 trash crate 의 native id 또는 원격 batch dir 안의 path.
    pub trash_path: String,
    pub original_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BackupRestore {
    pub backup_path: PathBuf,
    pub original_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MoveItem {
    pub src_original: PathBuf,
    pub dst_now: PathBuf,
}

/// jsonl 한 줄. push 새 entry 또는 기존 entry undone 토글.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
enum JsonlRecord {
    Push(JournalEntry),
    MarkUndone { id: JournalId },
}

pub struct Journal {
    path: PathBuf,
    inner: Mutex<VecDeque<JournalEntry>>,
}

impl Journal {
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("journal.jsonl");
        Self::load_from(&path).await
    }

    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let entries = if path.exists() {
            read_tail(path, TAIL_LOAD_LIMIT).await?
        } else {
            VecDeque::new()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: Mutex::new(entries),
        }))
    }

    /// 새 entry 추가 — 메모리 + 디스크.
    pub async fn push(&self, op: OpKind, undo: UndoAction) -> Result<JournalEntry, DuetError> {
        let entry = JournalEntry {
            id: JournalId::new(),
            timestamp: Utc::now(),
            op,
            undo,
            undone: false,
        };
        self.append(JsonlRecord::Push(entry.clone())).await?;
        let mut lock = self.inner.lock().await;
        lock.push_back(entry.clone());
        if lock.len() > TAIL_LOAD_LIMIT {
            lock.pop_front();
        }
        Ok(entry)
    }

    /// 가장 최근 undone == false entry 를 반환하고 undone = true 표시.
    /// `None` 이면 undo 할 게 없음.
    pub async fn pop_undoable(&self) -> Result<Option<JournalEntry>, DuetError> {
        let mut lock = self.inner.lock().await;
        let target_idx = lock.iter().rposition(|e| !e.undone);
        let Some(idx) = target_idx else { return Ok(None) };
        let mut entry = lock[idx].clone();
        entry.undone = true;
        lock[idx].undone = true;
        drop(lock);
        self.append(JsonlRecord::MarkUndone { id: entry.id }).await?;
        Ok(Some(entry))
    }

    pub async fn history(&self, limit: usize) -> Vec<JournalEntry> {
        let lock = self.inner.lock().await;
        lock.iter().rev().take(limit).cloned().collect()
    }

    async fn append(&self, record: JsonlRecord) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(DuetError::from)?;
        }
        let line = serde_json::to_string(&record)
            .map_err(|e| DuetError::Io(format!("journal serialize: {e}")))?;
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await
            .map_err(DuetError::from)?;
        file.write_all(line.as_bytes()).await.map_err(DuetError::from)?;
        file.write_all(b"\n").await.map_err(DuetError::from)?;
        file.flush().await.map_err(DuetError::from)?;
        Ok(())
    }
}

/// jsonl 파일을 처음부터 읽어 push/markundone 을 replay 후 마지막 limit 개 반환.
async fn read_tail(path: &Path, limit: usize) -> Result<VecDeque<JournalEntry>, DuetError> {
    let text = tokio::fs::read_to_string(path).await.map_err(DuetError::from)?;
    let mut entries: Vec<JournalEntry> = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let rec: JsonlRecord = serde_json::from_str(line).map_err(|e| {
            DuetError::Io(format!("journal line {} parse: {e}", i + 1))
        })?;
        match rec {
            JsonlRecord::Push(e) => entries.push(e),
            JsonlRecord::MarkUndone { id } => {
                if let Some(found) = entries.iter_mut().find(|e| e.id == id) {
                    found.undone = true;
                }
            }
        }
    }
    let start = entries.len().saturating_sub(limit);
    Ok(entries.drain(start..).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn mk_undo() -> UndoAction {
        UndoAction::Irreversible
    }
    fn mk_op() -> OpKind {
        OpKind::PermanentDelete {
            count: 1,
            location: Location { source: SourceId::Local, path: PathBuf::from("/tmp") },
        }
    }

    #[tokio::test]
    async fn push_and_history() {
        let dir = tempdir().unwrap();
        let j = Journal::load_from(&dir.path().join("j.jsonl")).await.unwrap();
        j.push(mk_op(), mk_undo()).await.unwrap();
        j.push(mk_op(), mk_undo()).await.unwrap();
        let h = j.history(10).await;
        assert_eq!(h.len(), 2);
    }

    #[tokio::test]
    async fn pop_undoable_walks_stack() {
        let dir = tempdir().unwrap();
        let j = Journal::load_from(&dir.path().join("j.jsonl")).await.unwrap();
        let a = j.push(mk_op(), mk_undo()).await.unwrap();
        let b = j.push(mk_op(), mk_undo()).await.unwrap();
        // 가장 최근 = b
        let popped = j.pop_undoable().await.unwrap().unwrap();
        assert_eq!(popped.id, b.id);
        // 다음 = a
        let popped2 = j.pop_undoable().await.unwrap().unwrap();
        assert_eq!(popped2.id, a.id);
        // 더 없음
        assert!(j.pop_undoable().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn persists_across_load() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("j.jsonl");
        {
            let j = Journal::load_from(&path).await.unwrap();
            j.push(mk_op(), mk_undo()).await.unwrap();
            j.pop_undoable().await.unwrap();
        }
        // 새 인스턴스
        let j2 = Journal::load_from(&path).await.unwrap();
        let h = j2.history(10).await;
        assert_eq!(h.len(), 1);
        assert!(h[0].undone, "MarkUndone replay 가 적용되어야 함");
    }

    #[tokio::test]
    async fn tail_limit_bounds_memory() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("j.jsonl");
        let j = Journal::load_from(&path).await.unwrap();
        for _ in 0..(TAIL_LOAD_LIMIT + 50) {
            j.push(mk_op(), mk_undo()).await.unwrap();
        }
        assert_eq!(j.inner.lock().await.len(), TAIL_LOAD_LIMIT);
    }
}
```

- [ ] **Step 4: 테스트 + 커밋**

```bash
cd src-tauri && cargo test --lib services::journal
```

기대: 4 passed.

```bash
git add src-tauri/src/services/ src-tauri/Cargo.toml
git commit -m "be/svc: Journal — jsonl append + 메모리 캐시 + uuid v7 ID

- JournalEntry { id, timestamp, op, undo, undone }
- OpKind / UndoAction (5 variants + Irreversible) — DTO via specta
- JsonlRecord::{Push, MarkUndone} — 같은 파일에 두 종류 레코드, 시작 시 replay
- TAIL_LOAD_LIMIT 100: 메모리 + 시작 로드 둘 다 제한
- uuid v7 feature 추가 (시간순 정렬, ULID 와 동일 특성)
- 4 tests"
```

---

### Task 4: settings_get / settings_set commands

**Files:**
- Create: `src-tauri/src/commands/settings.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs` (manage SettingsStore + Journal, register commands)

- [ ] **Step 1: commands/settings.rs**

```rust
//! 설정 IPC commands.

use std::sync::Arc;

use crate::services::settings::{Settings, SettingsPatch, SettingsStore};
use crate::types::DuetError;

#[tauri::command]
#[specta::specta]
pub async fn settings_get(
    store: tauri::State<'_, Arc<SettingsStore>>,
) -> Result<Settings, DuetError> {
    Ok(store.get().await)
}

#[tauri::command]
#[specta::specta]
pub async fn settings_set(
    patch: SettingsPatch,
    store: tauri::State<'_, Arc<SettingsStore>>,
) -> Result<Settings, DuetError> {
    store.apply(patch).await
}
```

- [ ] **Step 2: commands/mod.rs 에 등록**

```rust
pub mod settings;
```

- [ ] **Step 3: lib.rs — make_specta_builder + setup**

`make_specta_builder` 의 `collect_commands![]` 에 두 줄 추가:

```rust
commands::settings::settings_get,
commands::settings::settings_set,
```

`run()` 의 setup 직전에:

```rust
let settings = tauri::async_runtime::block_on(async {
    services::settings::SettingsStore::load_default().await
}).expect("settings load");
let journal = tauri::async_runtime::block_on(async {
    services::journal::Journal::load_default().await
}).expect("journal load");
```

`tauri::Builder::default()` 의 `.manage(pool)` 다음에:

```rust
.manage(settings)
.manage(journal)
```

- [ ] **Step 4: bindings 재생성 + 테스트**

```bash
cd src-tauri && cargo run --bin export_bindings
cargo test --lib
```

기대: 모든 lib 테스트 통과 (Phase A 종료 시 ~7 신규).

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/commands/ src-tauri/src/lib.rs src/types/bindings.ts
git commit -m "be/cmd + lib: settings_get/settings_set + Settings/Journal manage"
```

---

## Phase B: FileSystem trait 확장

### Task 5: FileSystem trait 메서드 추가 (시그니처)

**Files:**
- Modify: `src-tauri/src/fs/mod.rs`
- Modify: `src-tauri/src/types/mod.rs` (EntryMeta 신규, TrashLocation 신규)

- [ ] **Step 1: types/mod.rs — EntryMeta + TrashLocation**

`src-tauri/src/types/mod.rs` 끝에 추가:

```rust
/// 단일 항목의 stat — list 의 Entry 와 분리 (이름은 호출자가 알고 있음).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct EntryMeta {
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub modified_ms: Option<i64>,
    pub permissions: Option<u32>,
}

/// trash() 결과 — 어디로 갔는지. undo 시 복원 정보.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TrashLocation {
    /// 로컬 trash crate 의 native id (OS 휴지통)
    Local { trash_id: String },
    /// 원격 ~/.duet-trash/<batch>/<original-path>/
    Remote { trash_path: PathBuf },
}
```

- [ ] **Step 2: fs/mod.rs trait 확장**

```rust
#[async_trait]
pub trait FileSystem: Send + Sync {
    fn source_id(&self) -> SourceId;
    async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError>;

    // === MVP-2 신규 ===
    async fn metadata(&self, path: &Path) -> Result<crate::types::EntryMeta, DuetError>;
    async fn rename(&self, from: &Path, to: &Path) -> Result<(), DuetError>;
    async fn mkdir(&self, path: &Path) -> Result<(), DuetError>;
    async fn trash(&self, path: &Path, batch_id: &str) -> Result<crate::types::TrashLocation, DuetError>;
    async fn remove(&self, path: &Path) -> Result<(), DuetError>;

    /// trash 의 역동작 — undo 용. local/remote 구분 필요.
    async fn restore_from_trash(
        &self,
        location: &crate::types::TrashLocation,
        original_path: &Path,
    ) -> Result<(), DuetError>;
}
```

- [ ] **Step 3: 컴파일 확인 — LocalFs/SshFs 가 unimplemented! 로 stub 통과해야 함**

`src-tauri/src/fs/local.rs` 와 `src-tauri/src/fs/ssh.rs` 양쪽에 임시 stub 추가:

```rust
async fn metadata(&self, _path: &Path) -> Result<crate::types::EntryMeta, DuetError> { unimplemented!("Task 6/10") }
async fn rename(&self, _: &Path, _: &Path) -> Result<(), DuetError> { unimplemented!("Task 6/10") }
async fn mkdir(&self, _: &Path) -> Result<(), DuetError> { unimplemented!("Task 6/10") }
async fn trash(&self, _: &Path, _: &str) -> Result<crate::types::TrashLocation, DuetError> { unimplemented!("Task 8/11") }
async fn remove(&self, _: &Path) -> Result<(), DuetError> { unimplemented!("Task 6/10") }
async fn restore_from_trash(&self, _: &crate::types::TrashLocation, _: &Path) -> Result<(), DuetError> { unimplemented!("Task 8/11") }
```

```bash
cd src-tauri && cargo check --lib --tests
```

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/fs/ src-tauri/src/types/
git commit -m "be/fs: FileSystem trait 확장 (metadata/rename/mkdir/trash/remove/restore_from_trash) + EntryMeta/TrashLocation 타입

LocalFs/SshFs 는 일단 unimplemented! stub — 다음 task 들에서 구현."
```

---

### Task 6: LocalFs::rename + mkdir + remove + metadata

**Files:**
- Modify: `src-tauri/src/fs/local.rs`

- [ ] **Step 1: 테스트 먼저**

`src-tauri/src/fs/local.rs` 의 `mod tests` 에 추가:

```rust
#[tokio::test]
async fn rename_renames_file() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("a.txt"), b"x").await.unwrap();
    let local = LocalFs::new();
    local.rename(&dir.path().join("a.txt"), &dir.path().join("b.txt")).await.unwrap();
    assert!(!dir.path().join("a.txt").exists());
    assert!(dir.path().join("b.txt").exists());
}

#[tokio::test]
async fn mkdir_creates_dir() {
    let dir = TempDir::new().unwrap();
    let local = LocalFs::new();
    local.mkdir(&dir.path().join("new")).await.unwrap();
    assert!(dir.path().join("new").is_dir());
}

#[tokio::test]
async fn mkdir_fails_if_exists() {
    let dir = TempDir::new().unwrap();
    let local = LocalFs::new();
    fs::create_dir(dir.path().join("x")).await.unwrap();
    let result = local.mkdir(&dir.path().join("x")).await;
    assert!(result.is_err(), "기존 디렉토리에 mkdir 은 실패해야 함");
}

#[tokio::test]
async fn remove_file() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("a"), b"").await.unwrap();
    let local = LocalFs::new();
    local.remove(&dir.path().join("a")).await.unwrap();
    assert!(!dir.path().join("a").exists());
}

#[tokio::test]
async fn remove_empty_dir() {
    let dir = TempDir::new().unwrap();
    fs::create_dir(dir.path().join("empty")).await.unwrap();
    let local = LocalFs::new();
    local.remove(&dir.path().join("empty")).await.unwrap();
    assert!(!dir.path().join("empty").exists());
}

#[tokio::test]
async fn remove_nonempty_dir_recursive() {
    let dir = TempDir::new().unwrap();
    fs::create_dir(dir.path().join("d")).await.unwrap();
    fs::write(dir.path().join("d/a"), b"").await.unwrap();
    let local = LocalFs::new();
    local.remove(&dir.path().join("d")).await.unwrap();
    assert!(!dir.path().join("d").exists());
}

#[tokio::test]
async fn metadata_returns_kind_size() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("a"), b"hello").await.unwrap();
    let local = LocalFs::new();
    let m = local.metadata(&dir.path().join("a")).await.unwrap();
    assert_eq!(m.kind, EntryKind::File);
    assert_eq!(m.size, Some(5));
}
```

- [ ] **Step 2: 구현 — unimplemented stub 교체**

```rust
async fn metadata(&self, path: &Path) -> Result<crate::types::EntryMeta, DuetError> {
    let m = tokio::fs::symlink_metadata(path).await.map_err(DuetError::from)?;
    let kind = if m.is_dir() {
        EntryKind::Dir
    } else if m.is_file() {
        EntryKind::File
    } else if m.file_type().is_symlink() {
        EntryKind::Symlink
    } else {
        EntryKind::Other
    };
    let size = if m.is_file() { Some(m.len()) } else { None };
    let modified_ms = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        Some(m.permissions().mode() & 0o777)
    };
    #[cfg(not(unix))]
    let permissions = None;
    Ok(crate::types::EntryMeta { kind, size, modified_ms, permissions })
}

async fn rename(&self, from: &Path, to: &Path) -> Result<(), DuetError> {
    tokio::fs::rename(from, to).await.map_err(DuetError::from)
}

async fn mkdir(&self, path: &Path) -> Result<(), DuetError> {
    // create_dir (not _all) — 부모 없으면 에러, 이미 있으면 에러
    tokio::fs::create_dir(path).await.map_err(DuetError::from)
}

async fn remove(&self, path: &Path) -> Result<(), DuetError> {
    let m = tokio::fs::symlink_metadata(path).await.map_err(DuetError::from)?;
    if m.is_dir() {
        tokio::fs::remove_dir_all(path).await.map_err(DuetError::from)
    } else {
        tokio::fs::remove_file(path).await.map_err(DuetError::from)
    }
}
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
cargo test --lib fs::local
git add src-tauri/src/fs/local.rs
git commit -m "be/fs: LocalFs::{metadata, rename, mkdir, remove}

remove 는 dir 면 remove_dir_all (재귀). CLAUDE.md §3 준수: 이 메서드는
core/ops 의 PermanentDelete 만 호출 — 일반 코드에서 직접 호출 금지.
7 tests."
```

---

### Task 7: services/trash.rs (batch dir 명명 + 원격 path 계산)

**Files:**
- Create: `src-tauri/src/services/trash.rs`
- Modify: `src-tauri/src/services/mod.rs`

- [ ] **Step 1: services/mod.rs**

```rust
pub mod trash;
```

- [ ] **Step 2: trash.rs**

```rust
//! 휴지통 헬퍼 — batch ID 발급 + 원격 trash path 계산.
//!
//! 로컬 휴지통은 trash crate 위임 (`fs/local.rs`). 원격은 SFTP `mv` 로
//! `~/.duet-trash/<batch>/<original-absolute-path>` 위치로 보냄.

use chrono::Utc;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// 한 delete op 가 한 batch ID 사용. 같은 op 안 여러 항목은 같은 batch dir 안에.
/// 형식: `<UTC YYYYMMDD-HHMMSS>-<uuid v7 short>`
pub fn new_batch_id() -> String {
    let ts = Utc::now().format("%Y%m%d-%H%M%S");
    let id = Uuid::now_v7();
    let short: String = id.simple().to_string().chars().take(12).collect();
    format!("{ts}-{short}")
}

/// 원격 trash 의 base — `<remote_home>/.duet-trash`.
pub fn remote_trash_base(remote_home: &Path) -> PathBuf {
    remote_home.join(".duet-trash")
}

/// 원본 절대경로 → trash 안의 위치.
/// 예: `/home/u/foo.txt` + batch `20260509-...` → `<base>/<batch>/home/u/foo.txt`
pub fn remote_trash_path_for(base: &Path, batch_id: &str, original_abs: &Path) -> PathBuf {
    let mut out = base.join(batch_id);
    // original_abs 의 첫 `/` 만 제거하고 그 뒤를 그대로 붙임
    for comp in original_abs.components() {
        match comp {
            std::path::Component::RootDir => continue,
            std::path::Component::Normal(s) => out.push(s),
            std::path::Component::CurDir | std::path::Component::ParentDir => {
                // 비정상 경로는 그대로 push
                out.push(comp.as_os_str());
            }
            std::path::Component::Prefix(_) => {
                out.push(comp.as_os_str());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_id_has_expected_shape() {
        let id = new_batch_id();
        assert!(id.len() > 15, "got: {id}");
        // 첫 8자 = YYYYMMDD
        assert!(id.chars().take(8).all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn remote_path_preserves_absolute_structure() {
        let base = Path::new("/home/u/.duet-trash");
        let p = remote_trash_path_for(base, "BATCH", Path::new("/etc/foo/bar.txt"));
        assert_eq!(p, PathBuf::from("/home/u/.duet-trash/BATCH/etc/foo/bar.txt"));
    }

    #[test]
    fn remote_trash_base_appends_dot_dir() {
        assert_eq!(
            remote_trash_base(Path::new("/home/u")),
            PathBuf::from("/home/u/.duet-trash")
        );
    }
}
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
cargo test --lib services::trash
git add src-tauri/src/services/
git commit -m "be/svc: trash 헬퍼 — batch_id + 원격 trash path 계산

원본 절대경로를 batch dir 안에 디렉토리 구조로 보존 (충돌 방지 + undo 명확).
3 tests."
```

---

### Task 8: LocalFs::trash + restore_from_trash (trash crate)

**Files:**
- Modify: `src-tauri/src/fs/local.rs`

- [ ] **Step 1: 구현 — unimplemented stub 교체**

```rust
async fn trash(&self, path: &Path, _batch_id: &str) -> Result<crate::types::TrashLocation, DuetError> {
    let path = path.to_path_buf();
    // trash crate 는 sync — block_in_place 또는 spawn_blocking
    let info = tokio::task::spawn_blocking(move || {
        // delete 는 (Result<TrashItem, ...>) 반환하는 OS-specific API.
        // 모든 OS 에서 사용 가능한 plain trash::delete 는 native id 안 줌 →
        // os_limited::delete 사용 (TrashItem 반환).
        #[cfg(any(target_os = "macos", target_os = "windows", all(unix, not(target_os = "macos"))))]
        {
            use trash::os_limited;
            os_limited::list().ok(); // 워밍업 — 일부 플랫폼 issue 회피
            // delete_all 은 batch — 단일 path 도 OK
            let items_before: Vec<_> = os_limited::list()
                .map_err(|e| format!("trash list before: {e}"))?
                .into_iter()
                .map(|i| i.id.clone())
                .collect();
            trash::delete(&path).map_err(|e| format!("trash delete: {e}"))?;
            // 새 항목의 id 찾기 — original_path 매칭
            let after = os_limited::list().map_err(|e| format!("trash list after: {e}"))?;
            let new = after
                .into_iter()
                .find(|i| !items_before.contains(&i.id) && i.original_path() == path)
                .ok_or_else(|| "trash item not found after delete".to_string())?;
            Ok::<String, String>(new.id.to_string_lossy().into_owned())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", all(unix, not(target_os = "macos")))))]
        {
            Err::<String, String>("trash unsupported on this platform".to_string())
        }
    })
    .await
    .map_err(|e| DuetError::Io(format!("spawn_blocking: {e}")))?
    .map_err(DuetError::Io)?;

    Ok(crate::types::TrashLocation::Local { trash_id: info })
}

async fn restore_from_trash(
    &self,
    location: &crate::types::TrashLocation,
    original_path: &Path,
) -> Result<(), DuetError> {
    let crate::types::TrashLocation::Local { trash_id } = location else {
        return Err(DuetError::Io("restore_from_trash on local fs given non-local location".into()));
    };
    let trash_id = trash_id.clone();
    let original = original_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        use trash::os_limited;
        let items = os_limited::list().map_err(|e| format!("trash list: {e}"))?;
        let item = items
            .into_iter()
            .find(|i| i.id.to_string_lossy() == trash_id)
            .ok_or_else(|| format!("trash item not found: {trash_id}"))?;
        // 복원 — original_path 가 이미 있을 수 있음
        if original.exists() {
            return Err::<(), String>(format!("restore target exists: {}", original.display()));
        }
        os_limited::restore_all([item]).map_err(|e| format!("restore: {e:?}"))?;
        Ok(())
    })
    .await
    .map_err(|e| DuetError::Io(format!("spawn_blocking: {e}")))?
    .map_err(DuetError::Io)
}
```

- [ ] **Step 2: 컴파일만 확인 — 실제 휴지통 건드리는 테스트는 위험하므로 skip**

```bash
cd src-tauri && cargo check --lib --tests
```

(트래시 통합 테스트는 사용자 OS 휴지통을 건드려서 CI 곤란. 수동 검증 단계 (Phase F) 에서.)

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/fs/local.rs
git commit -m "be/fs: LocalFs::trash/restore_from_trash via trash crate

trash crate 가 sync 라 spawn_blocking. os_limited::list 로 native id 캡처.
restore_from_trash 는 target 존재 시 명시적 에러 (사용자 직접 처리)."
```

---

### Task 9: LocalFs::copy_relay (LocalFs↔LocalFs)

**Files:**
- Modify: `src-tauri/src/fs/mod.rs` (trait 에 copy_relay 추가)
- Modify: `src-tauri/src/fs/local.rs`

`copy_relay` 는 trait 메서드가 아니라 `FileSystem` 의 free function 으로 만든다 — 두 fs 사이 stream copy 라 self/other 양쪽 트레잇 객체 필요. Task 5 에서 빠뜨렸으므로 여기서 추가.

- [ ] **Step 1: fs/mod.rs 에 free function 시그니처**

```rust
/// 본인 PC 통한 stream copy. local↔ssh 양방향 OK; ssh↔ssh 는 호출 전에
/// `core::ops` 가 same-host 검사 하고 차단.
///
/// 디렉토리는 재귀: src 가 dir 이면 dst 에 mkdir 후 자식 entries 차례로 복사.
pub async fn copy_relay(
    src_fs: &dyn FileSystem,
    src: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst: &std::path::Path,
) -> Result<(), DuetError> {
    let meta = src_fs.metadata(src).await?;
    match meta.kind {
        crate::types::EntryKind::Dir => {
            dst_fs.mkdir(dst).await?;
            let entries = src_fs.list(src).await?;
            for e in entries {
                let child_src = src.join(&e.name);
                let child_dst = dst.join(&e.name);
                Box::pin(copy_relay(src_fs, &child_src, dst_fs, &child_dst)).await?;
            }
            Ok(())
        }
        crate::types::EntryKind::File => copy_file_bytes(src_fs, src, dst_fs, dst).await,
        crate::types::EntryKind::Symlink | crate::types::EntryKind::Other => {
            // MVP-2 는 symlink 따라가서 복사 (target 의 내용 복사). target 부재 시 read 가 에러.
            copy_file_bytes(src_fs, src, dst_fs, dst).await
        }
    }
}

/// 단일 파일을 byte stream 으로 복사.
/// MVP-2 는 LocalFs 만 read_bytes/write_bytes 구현 — SshFs 통합은 Task 12.
async fn copy_file_bytes(
    src_fs: &dyn FileSystem,
    src: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst: &std::path::Path,
) -> Result<(), DuetError> {
    let bytes = src_fs.read_full(src).await?;
    dst_fs.write_full(dst, &bytes).await
}
```

trait 에도 새 메서드 두 개 추가 (read_full / write_full):

```rust
async fn read_full(&self, path: &std::path::Path) -> Result<Vec<u8>, DuetError>;
async fn write_full(&self, path: &std::path::Path, bytes: &[u8]) -> Result<(), DuetError>;
```

LocalFs/SshFs 양쪽에 unimplemented stub 추가 (LocalFs 는 곧 구현; SshFs 는 Task 12 에서).

- [ ] **Step 2: LocalFs::read_full / write_full**

```rust
async fn read_full(&self, path: &Path) -> Result<Vec<u8>, DuetError> {
    tokio::fs::read(path).await.map_err(DuetError::from)
}

async fn write_full(&self, path: &Path, bytes: &[u8]) -> Result<(), DuetError> {
    tokio::fs::write(path, bytes).await.map_err(DuetError::from)
}
```

- [ ] **Step 3: 테스트**

`fs/local.rs` 의 tests:

```rust
#[tokio::test]
async fn copy_relay_local_to_local_file() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("a"), b"hello").await.unwrap();
    let local = LocalFs::new();
    crate::fs::copy_relay(&local, &dir.path().join("a"), &local, &dir.path().join("b"))
        .await.unwrap();
    let b = fs::read(dir.path().join("b")).await.unwrap();
    assert_eq!(b, b"hello");
}

#[tokio::test]
async fn copy_relay_local_to_local_dir_recursive() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("src/sub")).await.unwrap();
    fs::write(dir.path().join("src/a"), b"A").await.unwrap();
    fs::write(dir.path().join("src/sub/b"), b"B").await.unwrap();
    let local = LocalFs::new();
    crate::fs::copy_relay(&local, &dir.path().join("src"), &local, &dir.path().join("dst"))
        .await.unwrap();
    assert_eq!(fs::read(dir.path().join("dst/a")).await.unwrap(), b"A");
    assert_eq!(fs::read(dir.path().join("dst/sub/b")).await.unwrap(), b"B");
}
```

- [ ] **Step 4: 컴파일 + 테스트 + 커밋**

```bash
cargo test --lib fs::local
git add src-tauri/src/fs/
git commit -m "be/fs: copy_relay 함수 + LocalFs::read_full/write_full

free function — 두 fs 사이 stream copy. dir 재귀, file 은 read_full →
write_full. SshFs 의 read_full/write_full 은 Task 12.
2 tests."
```

---

## Task 10-12 (SshFs 확장) — 별도 후속 메시지로 계속

Phase B 의 SSH 측 구현 (rename/mkdir/remove/trash/restore + read_full/write_full) 은 5개 메서드 분량이 많아 별도로 확장. 본 plan v1 에서는 LocalFs↔LocalFs 까지 검증된 후 SshFs 통합 과정에서 작성.

**SshFs Task 10 - 12 가이드라인:**
- Task 10: `SshFs::{metadata, rename, mkdir, remove}` — sftp metadata / rename / create_dir / remove_file/remove_dir 사용
- Task 11: `SshFs::{trash, restore_from_trash}` — `services::trash::remote_trash_path_for` 호출 + `~/.duet-trash` 가 없으면 mkdir_all (재귀) → 그 안으로 rename
- Task 12: `SshFs::{read_full, write_full}` — `sftp.open` + `read_to_end` / `sftp.create` + `write_all`. 큰 파일은 8MB 청크 (메모리 폭주 방지) — 후속 task 에서 streaming 화

각 Task 의 단위 테스트는 시그니처 sanity 만 (실제 SFTP 통합은 docker-based 후속).

---

## Phase C: Op layer + IPC commands

### Task 13: core/ops.rs — Op trait + DeleteOp

**Files:**
- Create: `src-tauri/src/core/ops.rs`
- Modify: `src-tauri/src/core/mod.rs`

- [ ] **Step 1: core/mod.rs**

```rust
//! 도메인 로직 — fs 위 op 추상화.

pub mod ops;
```

- [ ] **Step 2: core/ops.rs — DeleteOp 만 우선**

```rust
//! 파괴적 작업 추상화 — plan + execute 두 단계.
//!
//! plan() 결과는 IPC 노출 — UI 다이얼로그가 사용자에게 보여줌.
//! execute() 는 백엔드에서 settings/journal 갱신.

use crate::fs::FileSystem;
use crate::services::journal::{Journal, JournalEntry, OpKind, TrashItem, UndoAction};
use crate::services::settings::SettingsStore;
use crate::types::{DeleteMode, DuetError, EntryRef, Location, SourceId, TrashLocation};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::sync::Arc;

/// op 실행 컨텍스트. 명시적 의존성 주입.
pub struct OpCtx {
    pub journal: Arc<Journal>,
    pub settings: Arc<SettingsStore>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DeletePlan {
    pub mode: DeleteMode,
    pub targets: Vec<EntryRef>,
    pub total_size_bytes: u64,
    pub total_count: u32,
    /// targets 의 location.source — 모든 target 이 같은 source 가정 (UI 가 강제).
    pub source: SourceId,
    pub source_location: Location,
}

pub async fn delete_plan(
    fs: &dyn FileSystem,
    targets: Vec<EntryRef>,
    mode: DeleteMode,
) -> Result<DeletePlan, DuetError> {
    if targets.is_empty() {
        return Err(DuetError::Io("no targets".into()));
    }
    let source = targets[0].location.source.clone();
    let source_location = targets[0].location.clone();
    // 모든 target 이 같은 source 인지 검증
    for t in &targets {
        if t.location.source != source {
            return Err(DuetError::Io("targets must share source".into()));
        }
    }
    let mut total_size_bytes = 0u64;
    for t in &targets {
        let p = t.location.path.join(&t.name);
        if let Ok(m) = fs.metadata(&p).await {
            total_size_bytes += m.size.unwrap_or(0);
        }
    }
    Ok(DeletePlan {
        mode,
        targets: targets.clone(),
        total_size_bytes,
        total_count: targets.len() as u32,
        source,
        source_location,
    })
}

pub async fn delete_execute(
    fs: &dyn FileSystem,
    plan: DeletePlan,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    if matches!(plan.mode, DeleteMode::Permanent) {
        let s = ctx.settings.get().await;
        if !s.permanent_delete_enabled {
            return Err(DuetError::NotPermitted);
        }
    }

    let undo = match plan.mode {
        DeleteMode::Trash => {
            let batch_id = crate::services::trash::new_batch_id();
            let mut items = Vec::new();
            for t in &plan.targets {
                let p = t.location.path.join(&t.name);
                let loc = fs.trash(&p, &batch_id).await?;
                let trash_path = match &loc {
                    TrashLocation::Local { trash_id } => trash_id.clone(),
                    TrashLocation::Remote { trash_path } => trash_path.to_string_lossy().into_owned(),
                };
                items.push(TrashItem { trash_path, original_path: p });
            }
            UndoAction::RestoreFromTrash { source: plan.source.clone(), items }
        }
        DeleteMode::Permanent => {
            for t in &plan.targets {
                let p = t.location.path.join(&t.name);
                fs.remove(&p).await?;
            }
            UndoAction::Irreversible
        }
    };

    let op = match plan.mode {
        DeleteMode::Trash => OpKind::Trash {
            count: plan.total_count,
            location: plan.source_location.clone(),
        },
        DeleteMode::Permanent => OpKind::PermanentDelete {
            count: plan.total_count,
            location: plan.source_location.clone(),
        },
    };
    ctx.journal.push(op, undo).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::LocalFs;
    use crate::types::{Location, SourceId};
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn mk_target(parent: &PathBuf, name: &str) -> EntryRef {
        EntryRef {
            location: Location { source: SourceId::Local, path: parent.clone() },
            name: name.to_string(),
        }
    }

    #[tokio::test]
    async fn delete_plan_aggregates_size() {
        let dir = TempDir::new().unwrap();
        tokio::fs::write(dir.path().join("a"), b"hello").await.unwrap();
        tokio::fs::write(dir.path().join("b"), b"world!").await.unwrap();
        let local = LocalFs::new();
        let parent = dir.path().to_path_buf();
        let plan = delete_plan(
            &local,
            vec![mk_target(&parent, "a"), mk_target(&parent, "b")],
            DeleteMode::Trash,
        ).await.unwrap();
        assert_eq!(plan.total_count, 2);
        assert_eq!(plan.total_size_bytes, 5 + 6);
    }

    #[tokio::test]
    async fn delete_plan_empty_targets_errors() {
        let local = LocalFs::new();
        assert!(delete_plan(&local, vec![], DeleteMode::Trash).await.is_err());
    }

    // permanent delete with settings off → NotPermitted
    #[tokio::test]
    async fn permanent_delete_blocked_when_settings_off() {
        let dir = TempDir::new().unwrap();
        tokio::fs::write(dir.path().join("a"), b"x").await.unwrap();
        let local = LocalFs::new();
        let parent = dir.path().to_path_buf();
        let plan = delete_plan(
            &local,
            vec![mk_target(&parent, "a")],
            DeleteMode::Permanent,
        ).await.unwrap();

        let settings_dir = TempDir::new().unwrap();
        let settings = crate::services::settings::SettingsStore::load_from(
            &settings_dir.path().join("s.toml"),
        ).await.unwrap();
        let journal_dir = TempDir::new().unwrap();
        let journal = crate::services::journal::Journal::load_from(
            &journal_dir.path().join("j.jsonl"),
        ).await.unwrap();

        let ctx = OpCtx { journal, settings };
        let result = delete_execute(&local, plan, &ctx).await;
        assert!(matches!(result, Err(DuetError::NotPermitted)));
        // 파일 안 지워졌는지
        assert!(dir.path().join("a").exists());
    }
}
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
cd src-tauri && cargo test --lib core::ops
git add src-tauri/src/core/
git commit -m "be/core: DeleteOp (plan + execute) + OpCtx

- delete_plan: 대상 검증 + 크기 집계
- delete_execute: Trash → 각 target trash() + UndoAction::RestoreFromTrash;
  Permanent → settings 검증 → remove() + Irreversible
- 3 tests (size 집계, empty targets 에러, permanent 블락)"
```

---

### Task 14: CopyOp + MoveOp (충돌 감지 + same-host SSH 차단)

**Files:**
- Modify: `src-tauri/src/core/ops.rs`

- [ ] **Step 1: CopyPlan / MovePlan + Conflict DTO**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CopyPlan {
    pub src_source: SourceId,
    pub dst: Location,
    pub items: Vec<EntryRef>,
    pub conflicts: Vec<Conflict>,
    pub total_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MovePlan {
    pub src_source: SourceId,
    pub dst: Location,
    pub items: Vec<EntryRef>,
    pub conflicts: Vec<Conflict>,
    /// true 면 단순 rename (같은 fs). false 면 copy + trash.
    pub is_same_fs: bool,
    pub total_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Conflict {
    pub name: String,
    pub dst_path: PathBuf,
    pub will_become_backup: PathBuf,
}

/// `name` → `name.bak.<ts>`. timestamp 충돌 시 .<n> suffix 는 호출자가 retry.
pub fn backup_name(original: &str) -> String {
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    format!("{original}.bak.{ts}")
}
```

- [ ] **Step 2: copy_plan / copy_execute**

```rust
pub async fn copy_plan(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    items: Vec<EntryRef>,
    dst: Location,
) -> Result<CopyPlan, DuetError> {
    if items.is_empty() {
        return Err(DuetError::Io("no items".into()));
    }
    let src_source = items[0].location.source.clone();
    for t in &items {
        if t.location.source != src_source {
            return Err(DuetError::Io("items must share source".into()));
        }
    }

    // 같은 호스트 SSH↔SSH 차단 (CLAUDE.md DON'T list)
    if let (
        SourceId::Ssh { host_ip: a, .. },
        SourceId::Ssh { host_ip: b, .. },
    ) = (&src_source, &dst.source) {
        if a == b {
            return Err(DuetError::NotSupported(
                "same-host SSH copy: MVP-3 에서 지원".into(),
            ));
        }
    }

    let mut conflicts = Vec::new();
    let mut total = 0u64;
    for it in &items {
        let dst_path = dst.path.join(&it.name);
        if dst_fs.metadata(&dst_path).await.is_ok() {
            conflicts.push(Conflict {
                name: it.name.clone(),
                dst_path: dst_path.clone(),
                will_become_backup: dst.path.join(backup_name(&it.name)),
            });
        }
        let src_path = it.location.path.join(&it.name);
        if let Ok(m) = src_fs.metadata(&src_path).await {
            total += m.size.unwrap_or(0);
        }
    }

    Ok(CopyPlan {
        src_source,
        dst,
        items,
        conflicts,
        total_size_bytes: total,
    })
}

pub async fn copy_execute(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: CopyPlan,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    use crate::services::journal::{BackupRestore, OpKind, UndoAction};

    let mut copied = Vec::new();
    let mut backups = Vec::new();
    for it in &plan.items {
        let src_path = it.location.path.join(&it.name);
        let dst_path = plan.dst.path.join(&it.name);

        // 충돌 시 backup 으로 mv (timestamp 단계 retry 최대 5회)
        if dst_fs.metadata(&dst_path).await.is_ok() {
            let mut backup = plan.dst.path.join(backup_name(&it.name));
            for n in 2..=6 {
                if dst_fs.metadata(&backup).await.is_err() { break; }
                backup = plan.dst.path.join(format!("{}.{}", backup_name(&it.name), n));
                if n == 6 {
                    return Err(DuetError::Io("backup name collision (>5 retries)".into()));
                }
            }
            dst_fs.rename(&dst_path, &backup).await?;
            backups.push(BackupRestore {
                backup_path: backup,
                original_path: dst_path.clone(),
            });
        }

        crate::fs::copy_relay(src_fs, &src_path, dst_fs, &dst_path).await?;
        copied.push(dst_path);
    }

    let undo = UndoAction::UndoCopy {
        target_source: plan.dst.source.clone(),
        copied,
        backups_to_restore: backups,
    };
    let op = OpKind::Copy {
        count: plan.items.len() as u32,
        src: plan.items[0].location.clone(),
        dst: plan.dst.clone(),
    };
    ctx.journal.push(op, undo).await
}
```

- [ ] **Step 3: move_plan / move_execute (copy + trash 또는 rename)**

```rust
pub async fn move_plan(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    items: Vec<EntryRef>,
    dst: Location,
) -> Result<MovePlan, DuetError> {
    let copy = copy_plan(src_fs, dst_fs, items.clone(), dst.clone()).await?;
    let is_same_fs = copy.src_source == dst.source;
    Ok(MovePlan {
        src_source: copy.src_source,
        dst: copy.dst,
        items: copy.items,
        conflicts: copy.conflicts,
        is_same_fs,
        total_size_bytes: copy.total_size_bytes,
    })
}

pub async fn move_execute(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: MovePlan,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    use crate::services::journal::{BackupRestore, MoveItem, OpKind, UndoAction};

    let mut moved = Vec::new();
    let mut backups = Vec::new();
    for it in &plan.items {
        let src_path = it.location.path.join(&it.name);
        let dst_path = plan.dst.path.join(&it.name);

        if dst_fs.metadata(&dst_path).await.is_ok() {
            let mut backup = plan.dst.path.join(backup_name(&it.name));
            for n in 2..=6 {
                if dst_fs.metadata(&backup).await.is_err() { break; }
                backup = plan.dst.path.join(format!("{}.{}", backup_name(&it.name), n));
                if n == 6 {
                    return Err(DuetError::Io("backup name collision".into()));
                }
            }
            dst_fs.rename(&dst_path, &backup).await?;
            backups.push(BackupRestore {
                backup_path: backup,
                original_path: dst_path.clone(),
            });
        }

        if plan.is_same_fs {
            // 같은 fs: 단순 rename — 빠르고 atomic
            src_fs.rename(&src_path, &dst_path).await?;
        } else {
            crate::fs::copy_relay(src_fs, &src_path, dst_fs, &dst_path).await?;
            // src 는 휴지통으로 (영구삭제 아님)
            let batch_id = crate::services::trash::new_batch_id();
            src_fs.trash(&src_path, &batch_id).await?;
        }
        moved.push(MoveItem { src_original: src_path, dst_now: dst_path });
    }

    let undo = UndoAction::UndoMove {
        src_source: plan.src_source.clone(),
        dst_source: plan.dst.source.clone(),
        moved,
        backups_to_restore: backups,
    };
    let op = OpKind::Move {
        count: plan.items.len() as u32,
        src: plan.items[0].location.clone(),
        dst: plan.dst.clone(),
    };
    ctx.journal.push(op, undo).await
}
```

- [ ] **Step 4: 테스트 (same-host SSH 차단 + 충돌 감지)**

```rust
#[tokio::test]
async fn copy_plan_blocks_same_host_ssh() {
    use std::net::Ipv4Addr;
    use crate::types::ConnectionId;

    let local = LocalFs::new();
    // 가짜 SSH source (실제 fs 객체는 LocalFs 라 metadata 동작; source_id 만 ssh)
    // 더 깔끔히 하려면 mock FileSystem 필요. MVP-2 에서는 SourceId 비교만 검증.
    let src = SourceId::Ssh {
        connection_id: ConnectionId("a".into()),
        host_ip: std::net::IpAddr::V4(Ipv4Addr::new(10,0,0,1)),
        user: "u".into(),
    };
    let dst_src = src.clone();

    let item = EntryRef {
        location: Location { source: src, path: PathBuf::from("/x") },
        name: "f".into(),
    };
    let dst = Location { source: dst_src, path: PathBuf::from("/y") };

    let result = copy_plan(&local, &local, vec![item], dst).await;
    match result {
        Err(DuetError::NotSupported(msg)) => assert!(msg.contains("MVP-3")),
        other => panic!("expected NotSupported, got {other:?}"),
    }
}

#[tokio::test]
async fn copy_plan_detects_conflict() {
    let dir = TempDir::new().unwrap();
    tokio::fs::write(dir.path().join("a"), b"new").await.unwrap();
    tokio::fs::create_dir(dir.path().join("dst")).await.unwrap();
    tokio::fs::write(dir.path().join("dst/a"), b"existing").await.unwrap();

    let local = LocalFs::new();
    let item = EntryRef {
        location: Location { source: SourceId::Local, path: dir.path().to_path_buf() },
        name: "a".into(),
    };
    let dst = Location { source: SourceId::Local, path: dir.path().join("dst") };
    let plan = copy_plan(&local, &local, vec![item], dst).await.unwrap();
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(plan.conflicts[0].name, "a");
}
```

- [ ] **Step 5: 컴파일 + 테스트 + 커밋**

```bash
cargo test --lib core::ops
git add src-tauri/src/core/
git commit -m "be/core: CopyOp + MoveOp (충돌 감지 + same-host SSH 차단 + auto backup)

- copy_plan/move_plan: SourceId 비교로 same-host SSH NotSupported(MVP-3)
- 충돌 감지: dst 에 같은 이름 있으면 will_become_backup 미리 표시
- copy_execute: 충돌 시 dst → .bak.<ts> mv 후 src 복사. UndoCopy 에 기록
- move_execute: same fs 면 rename, 아니면 copy_relay + trash
- backup name 충돌 시 .bak.<ts>.<n> retry (5회)
- 5 tests (clean + 5 신규 = 8)"
```

---

### Task 15: RenameOp + MkdirOp

**Files:**
- Modify: `src-tauri/src/core/ops.rs`

- [ ] **Step 1: 단순 함수 (plan 불필요)**

```rust
pub async fn rename(
    fs: &dyn FileSystem,
    target: EntryRef,
    new_name: String,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    use crate::services::journal::{OpKind, UndoAction};
    if new_name.contains('/') || new_name.is_empty() {
        return Err(DuetError::Io(format!("invalid name: {new_name}")));
    }
    let from = target.location.path.join(&target.name);
    let to = target.location.path.join(&new_name);
    if fs.metadata(&to).await.is_ok() {
        return Err(DuetError::Io(format!("target exists: {}", to.display())));
    }
    fs.rename(&from, &to).await?;
    ctx.journal.push(
        OpKind::Rename {
            from: from.clone(),
            to: to.clone(),
            source: target.location.source.clone(),
        },
        UndoAction::UndoRename {
            source: target.location.source,
            current: to,
            original: from,
        },
    ).await
}

pub async fn mkdir(
    fs: &dyn FileSystem,
    parent: Location,
    name: String,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    use crate::services::journal::{OpKind, UndoAction};
    if name.contains('/') || name.is_empty() {
        return Err(DuetError::Io(format!("invalid name: {name}")));
    }
    let path = parent.path.join(&name);
    fs.mkdir(&path).await?;
    ctx.journal.push(
        OpKind::Mkdir { path: path.clone(), source: parent.source.clone() },
        UndoAction::UndoMkdir { source: parent.source, path },
    ).await
}
```

- [ ] **Step 2: 테스트**

```rust
#[tokio::test]
async fn rename_works_and_journals() {
    let dir = TempDir::new().unwrap();
    tokio::fs::write(dir.path().join("a"), b"x").await.unwrap();
    let local = LocalFs::new();
    let ctx = mk_ctx().await;
    let target = EntryRef {
        location: Location { source: SourceId::Local, path: dir.path().to_path_buf() },
        name: "a".into(),
    };
    let entry = rename(&local, target, "b".into(), &ctx).await.unwrap();
    assert!(dir.path().join("b").exists());
    assert!(matches!(
        entry.undo,
        crate::services::journal::UndoAction::UndoRename { .. }
    ));
}

async fn mk_ctx() -> OpCtx {
    let dir = tempfile::tempdir().unwrap();
    OpCtx {
        settings: crate::services::settings::SettingsStore::load_from(
            &dir.path().join("s.toml")
        ).await.unwrap(),
        journal: crate::services::journal::Journal::load_from(
            &dir.path().join("j.jsonl")
        ).await.unwrap(),
    }
    // NB: dir 은 함수 끝에서 drop — 테스트용으로는 OK (TempDir Drop 늦음 보장 안 함)
    // 실용적으로 OK; 더 엄격히 하려면 dir 도 반환.
}

#[tokio::test]
async fn mkdir_works_and_journals() {
    let dir = TempDir::new().unwrap();
    let local = LocalFs::new();
    let ctx = mk_ctx().await;
    mkdir(&local, Location {
        source: SourceId::Local, path: dir.path().to_path_buf()
    }, "newdir".into(), &ctx).await.unwrap();
    assert!(dir.path().join("newdir").is_dir());
}
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
cargo test --lib core::ops
git add src-tauri/src/core/
git commit -m "be/core: RenameOp + MkdirOp (단순, plan 불필요)

이름 검증 (slash 금지, 빈문자 금지). 같은 이름 존재 시 명시 에러.
2 tests."
```

---

### Task 16: commands/fs_ops.rs + lib.rs 등록 + bindings 재생성

**Files:**
- Create: `src-tauri/src/commands/fs_ops.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: commands/mod.rs**

```rust
pub mod fs_ops;
```

- [ ] **Step 2: commands/fs_ops.rs**

```rust
//! 파괴적 작업 IPC commands. plan/execute 두 단계 (CLAUDE.md §3, §4 준수).

use std::sync::Arc;

use crate::core::ops::{
    self, CopyPlan, DeletePlan, MovePlan, OpCtx,
};
use crate::fs::{FileSystem, LocalFs, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::{Journal, JournalEntry, JournalId};
use crate::services::settings::SettingsStore;
use crate::types::{DeleteMode, DuetError, EntryRef, Location, SourceId};

/// SourceId → FileSystem 동적 디스패치.
/// SSH 면 ConnectionPool 에서 ActiveConnection 가져와 SshFs 빌드.
async fn fs_for(source: &SourceId, pool: &Arc<ConnectionPool>) -> Result<Box<dyn FileSystem>, DuetError> {
    match source {
        SourceId::Local => Ok(Box::new(LocalFs::new())),
        SourceId::Ssh { connection_id, .. } => {
            let conn = pool.get(connection_id).await?;
            Ok(Box::new(SshFs::new(conn)))
        }
    }
}

fn ctx(settings: Arc<SettingsStore>, journal: Arc<Journal>) -> OpCtx {
    OpCtx { settings, journal }
}

#[tauri::command]
#[specta::specta]
pub async fn fs_delete_plan(
    targets: Vec<EntryRef>,
    mode: DeleteMode,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<DeletePlan, DuetError> {
    let source = targets.first().map(|t| t.location.source.clone())
        .ok_or_else(|| DuetError::Io("no targets".into()))?;
    let fs = fs_for(&source, pool.inner()).await?;
    ops::delete_plan(&*fs, targets, mode).await
}

#[tauri::command]
#[specta::specta]
pub async fn fs_delete_execute(
    plan: DeletePlan,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
) -> Result<JournalId, DuetError> {
    let fs = fs_for(&plan.source, pool.inner()).await?;
    let entry = ops::delete_execute(&*fs, plan, &ctx(settings.inner().clone(), journal.inner().clone())).await?;
    Ok(entry.id)
}

#[tauri::command]
#[specta::specta]
pub async fn fs_copy_plan(
    items: Vec<EntryRef>,
    dst: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<CopyPlan, DuetError> {
    let src_source = items.first().map(|t| t.location.source.clone())
        .ok_or_else(|| DuetError::Io("no items".into()))?;
    let src_fs = fs_for(&src_source, pool.inner()).await?;
    let dst_fs = fs_for(&dst.source, pool.inner()).await?;
    ops::copy_plan(&*src_fs, &*dst_fs, items, dst).await
}

#[tauri::command]
#[specta::specta]
pub async fn fs_copy_execute(
    plan: CopyPlan,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
) -> Result<JournalId, DuetError> {
    let src_fs = fs_for(&plan.src_source, pool.inner()).await?;
    let dst_fs = fs_for(&plan.dst.source, pool.inner()).await?;
    let entry = ops::copy_execute(&*src_fs, &*dst_fs, plan, &ctx(settings.inner().clone(), journal.inner().clone())).await?;
    Ok(entry.id)
}

#[tauri::command]
#[specta::specta]
pub async fn fs_move_plan(
    items: Vec<EntryRef>,
    dst: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<MovePlan, DuetError> {
    let src_source = items.first().map(|t| t.location.source.clone())
        .ok_or_else(|| DuetError::Io("no items".into()))?;
    let src_fs = fs_for(&src_source, pool.inner()).await?;
    let dst_fs = fs_for(&dst.source, pool.inner()).await?;
    ops::move_plan(&*src_fs, &*dst_fs, items, dst).await
}

#[tauri::command]
#[specta::specta]
pub async fn fs_move_execute(
    plan: MovePlan,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
) -> Result<JournalId, DuetError> {
    let src_fs = fs_for(&plan.src_source, pool.inner()).await?;
    let dst_fs = fs_for(&plan.dst.source, pool.inner()).await?;
    let entry = ops::move_execute(&*src_fs, &*dst_fs, plan, &ctx(settings.inner().clone(), journal.inner().clone())).await?;
    Ok(entry.id)
}

#[tauri::command]
#[specta::specta]
pub async fn fs_rename(
    target: EntryRef,
    new_name: String,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
) -> Result<JournalId, DuetError> {
    let fs = fs_for(&target.location.source, pool.inner()).await?;
    let entry = ops::rename(&*fs, target, new_name, &ctx(settings.inner().clone(), journal.inner().clone())).await?;
    Ok(entry.id)
}

#[tauri::command]
#[specta::specta]
pub async fn fs_mkdir(
    parent: Location,
    name: String,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
) -> Result<JournalId, DuetError> {
    let fs = fs_for(&parent.source, pool.inner()).await?;
    let entry = ops::mkdir(&*fs, parent, name, &ctx(settings.inner().clone(), journal.inner().clone())).await?;
    Ok(entry.id)
}
```

- [ ] **Step 3: lib.rs make_specta_builder 에 8개 command 추가**

```rust
commands::fs_ops::fs_delete_plan,
commands::fs_ops::fs_delete_execute,
commands::fs_ops::fs_copy_plan,
commands::fs_ops::fs_copy_execute,
commands::fs_ops::fs_move_plan,
commands::fs_ops::fs_move_execute,
commands::fs_ops::fs_rename,
commands::fs_ops::fs_mkdir,
```

- [ ] **Step 4: bindings 재생성 + 컴파일 + 커밋**

```bash
cd src-tauri && cargo run --bin export_bindings
cargo test --lib
git add src-tauri/src/commands/ src-tauri/src/lib.rs src/types/bindings.ts
git commit -m "be/cmd: fs_ops 8개 command (plan/execute) + bindings

fs_for() 헬퍼: SourceId → Box<dyn FileSystem> 동적 디스패치 (Local | SSH).
ConnectionPool/SettingsStore/Journal 모두 tauri::State 주입."
```

---

## Phase D: Undo

### Task 17: UndoAction 디스패처

**Files:**
- Create: `src-tauri/src/core/undo.rs`
- Modify: `src-tauri/src/core/mod.rs`

- [ ] **Step 1: core/mod.rs**

```rust
pub mod undo;
```

- [ ] **Step 2: core/undo.rs**

```rust
//! UndoAction 종류별 실행. core/ops 가 만든 entry 의 undo 필드를 본문 그대로 적용.
//!
//! 실행 결과는 `UndoOutcome` — UI 가 토스트로 보여주거나 영향받은 location refresh.

use crate::fs::{copy_relay, FileSystem, LocalFs, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::{JournalEntry, UndoAction};
use crate::types::{DuetError, Location, SourceId, TrashLocation};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UndoOutcome {
    pub kind: UndoKind,
    pub message: Option<String>,
    pub refreshed_locations: Vec<Location>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UndoKind {
    Ok,
    Skipped,
    Irreversible,
    Error,
}

async fn fs_for(source: &SourceId, pool: &Arc<ConnectionPool>) -> Result<Box<dyn FileSystem>, DuetError> {
    match source {
        SourceId::Local => Ok(Box::new(LocalFs::new())),
        SourceId::Ssh { connection_id, .. } => {
            let conn = pool.get(connection_id).await?;
            Ok(Box::new(SshFs::new(conn)))
        }
    }
}

pub async fn execute_undo(
    entry: &JournalEntry,
    pool: &Arc<ConnectionPool>,
) -> UndoOutcome {
    match &entry.undo {
        UndoAction::Irreversible => UndoOutcome {
            kind: UndoKind::Irreversible,
            message: Some("Cannot undo permanent delete".into()),
            refreshed_locations: vec![],
        },
        UndoAction::RestoreFromTrash { source, items } => {
            match fs_for(source, pool).await {
                Ok(fs) => {
                    let mut refresh = std::collections::HashSet::<PathBuf>::new();
                    for item in items {
                        let loc = TrashLocation::Local { trash_id: item.trash_path.clone() };
                        // 원격은 TrashLocation::Remote — items 안에서 구분 안 됨.
                        // SshFs 는 자기 source 위라 remote 분기 — 하지만 items 의 trash_path
                        // 가 path-string 이므로 아래에서 fs 가 자체 분기.
                        // 로컬은 위 Local 변환, 원격은 SshFs 가 trash_path 를 path 로 해석.
                        let actual_loc = match source {
                            SourceId::Local => loc,
                            SourceId::Ssh { .. } => TrashLocation::Remote {
                                trash_path: PathBuf::from(&item.trash_path),
                            },
                        };
                        if let Err(e) = fs.restore_from_trash(&actual_loc, &item.original_path).await {
                            return UndoOutcome {
                                kind: UndoKind::Error,
                                message: Some(format!("restore failed: {e}")),
                                refreshed_locations: vec![],
                            };
                        }
                        if let Some(parent) = item.original_path.parent() {
                            refresh.insert(parent.to_path_buf());
                        }
                    }
                    UndoOutcome {
                        kind: UndoKind::Ok,
                        message: None,
                        refreshed_locations: refresh.into_iter()
                            .map(|p| Location { source: source.clone(), path: p })
                            .collect(),
                    }
                }
                Err(e) => UndoOutcome {
                    kind: UndoKind::Error,
                    message: Some(format!("source unreachable: {e}")),
                    refreshed_locations: vec![],
                },
            }
        }
        UndoAction::UndoCopy { target_source, copied, backups_to_restore } => {
            match fs_for(target_source, pool).await {
                Ok(fs) => {
                    // 1) 새로 만든 파일들 삭제 (영구) — undo 본질
                    for p in copied {
                        if fs.metadata(p).await.is_ok() {
                            if let Err(e) = fs.remove(p).await {
                                return UndoOutcome {
                                    kind: UndoKind::Error,
                                    message: Some(format!("remove copied: {e}")),
                                    refreshed_locations: vec![],
                                };
                            }
                        }
                    }
                    // 2) backup → 원래 자리로 mv
                    for b in backups_to_restore {
                        if fs.metadata(&b.backup_path).await.is_ok() {
                            if let Err(e) = fs.rename(&b.backup_path, &b.original_path).await {
                                return UndoOutcome {
                                    kind: UndoKind::Error,
                                    message: Some(format!("restore backup: {e}")),
                                    refreshed_locations: vec![],
                                };
                            }
                        }
                    }
                    let mut refresh = std::collections::HashSet::<PathBuf>::new();
                    for p in copied { if let Some(par) = p.parent() { refresh.insert(par.to_path_buf()); } }
                    UndoOutcome {
                        kind: UndoKind::Ok,
                        message: None,
                        refreshed_locations: refresh.into_iter()
                            .map(|p| Location { source: target_source.clone(), path: p })
                            .collect(),
                    }
                }
                Err(e) => UndoOutcome {
                    kind: UndoKind::Error,
                    message: Some(format!("source unreachable: {e}")),
                    refreshed_locations: vec![],
                },
            }
        }
        UndoAction::UndoMove { src_source, dst_source, moved, backups_to_restore } => {
            // dst_now → src_original 로 mv (같은 fs면 rename, 아니면 copy_relay+remove)
            let src_fs_r = fs_for(src_source, pool).await;
            let dst_fs_r = fs_for(dst_source, pool).await;
            let (src_fs, dst_fs) = match (src_fs_r, dst_fs_r) {
                (Ok(a), Ok(b)) => (a, b),
                _ => return UndoOutcome {
                    kind: UndoKind::Error,
                    message: Some("source unreachable".into()),
                    refreshed_locations: vec![],
                },
            };
            for m in moved {
                if dst_fs.metadata(&m.dst_now).await.is_err() {
                    return UndoOutcome {
                        kind: UndoKind::Skipped,
                        message: Some("Item no longer at moved location — undo skipped".into()),
                        refreshed_locations: vec![],
                    };
                }
                if src_source == dst_source {
                    if let Err(e) = src_fs.rename(&m.dst_now, &m.src_original).await {
                        return UndoOutcome {
                            kind: UndoKind::Error,
                            message: Some(format!("rename back: {e}")),
                            refreshed_locations: vec![],
                        };
                    }
                } else {
                    if let Err(e) = copy_relay(&*dst_fs, &m.dst_now, &*src_fs, &m.src_original).await {
                        return UndoOutcome {
                            kind: UndoKind::Error,
                            message: Some(format!("copy back: {e}")),
                            refreshed_locations: vec![],
                        };
                    }
                    let _ = dst_fs.remove(&m.dst_now).await;
                }
            }
            // backups 복원
            for b in backups_to_restore {
                if dst_fs.metadata(&b.backup_path).await.is_ok() {
                    let _ = dst_fs.rename(&b.backup_path, &b.original_path).await;
                }
            }
            let mut refresh = std::collections::HashSet::<(SourceId, PathBuf)>::new();
            for m in moved {
                if let Some(p) = m.dst_now.parent() { refresh.insert((dst_source.clone(), p.to_path_buf())); }
                if let Some(p) = m.src_original.parent() { refresh.insert((src_source.clone(), p.to_path_buf())); }
            }
            UndoOutcome {
                kind: UndoKind::Ok,
                message: None,
                refreshed_locations: refresh.into_iter()
                    .map(|(s, p)| Location { source: s, path: p })
                    .collect(),
            }
        }
        UndoAction::UndoRename { source, current, original } => {
            match fs_for(source, pool).await {
                Ok(fs) => {
                    if let Err(e) = fs.rename(current, original).await {
                        return UndoOutcome {
                            kind: UndoKind::Error,
                            message: Some(format!("rename back: {e}")),
                            refreshed_locations: vec![],
                        };
                    }
                    UndoOutcome {
                        kind: UndoKind::Ok,
                        message: None,
                        refreshed_locations: original.parent().map(|p| Location {
                            source: source.clone(),
                            path: p.to_path_buf(),
                        }).into_iter().collect(),
                    }
                }
                Err(e) => UndoOutcome {
                    kind: UndoKind::Error,
                    message: Some(format!("source unreachable: {e}")),
                    refreshed_locations: vec![],
                },
            }
        }
        UndoAction::UndoMkdir { source, path } => {
            match fs_for(source, pool).await {
                Ok(fs) => {
                    let entries = fs.list(path).await.unwrap_or_default();
                    if !entries.is_empty() {
                        return UndoOutcome {
                            kind: UndoKind::Skipped,
                            message: Some("Directory not empty — undo skipped".into()),
                            refreshed_locations: vec![],
                        };
                    }
                    if let Err(e) = fs.remove(path).await {
                        return UndoOutcome {
                            kind: UndoKind::Error,
                            message: Some(format!("rmdir: {e}")),
                            refreshed_locations: vec![],
                        };
                    }
                    UndoOutcome {
                        kind: UndoKind::Ok,
                        message: None,
                        refreshed_locations: path.parent().map(|p| Location {
                            source: source.clone(),
                            path: p.to_path_buf(),
                        }).into_iter().collect(),
                    }
                }
                Err(e) => UndoOutcome {
                    kind: UndoKind::Error,
                    message: Some(format!("source unreachable: {e}")),
                    refreshed_locations: vec![],
                },
            }
        }
    }
}
```

- [ ] **Step 3: 단위 테스트 (LocalFs 한정)**

`core/undo.rs` 테스트:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::connection_pool::ConnectionPool;
    use crate::services::journal::{JournalEntry, JournalId, OpKind};
    use crate::types::SourceId;
    use chrono::Utc;
    use tempfile::TempDir;

    fn mk_entry(undo: UndoAction) -> JournalEntry {
        JournalEntry {
            id: JournalId::new(),
            timestamp: Utc::now(),
            op: OpKind::Mkdir { path: PathBuf::from("/tmp"), source: SourceId::Local },
            undo,
            undone: false,
        }
    }

    #[tokio::test]
    async fn irreversible_returns_irreversible() {
        let pool = ConnectionPool::new();
        let entry = mk_entry(UndoAction::Irreversible);
        let outcome = execute_undo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Irreversible));
    }

    #[tokio::test]
    async fn undo_mkdir_removes_empty_dir() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("new");
        tokio::fs::create_dir(&target).await.unwrap();
        let pool = ConnectionPool::new();
        let entry = mk_entry(UndoAction::UndoMkdir {
            source: SourceId::Local, path: target.clone(),
        });
        let outcome = execute_undo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Ok));
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn undo_mkdir_skips_when_not_empty() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("new");
        tokio::fs::create_dir(&target).await.unwrap();
        tokio::fs::write(target.join("a"), b"").await.unwrap();
        let pool = ConnectionPool::new();
        let entry = mk_entry(UndoAction::UndoMkdir {
            source: SourceId::Local, path: target.clone(),
        });
        let outcome = execute_undo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Skipped));
        assert!(target.exists());
    }
}
```

- [ ] **Step 4: 컴파일 + 테스트 + 커밋**

```bash
cargo test --lib core::undo
git add src-tauri/src/core/
git commit -m "be/core: UndoAction 디스패처 (5 variants)

- Irreversible: 즉시 Irreversible 반환
- RestoreFromTrash: items 마다 fs.restore_from_trash + 부모 dir refresh
- UndoCopy: copied 삭제 + backup 복원
- UndoMove: dst→src rename (같은 fs) 또는 copy_relay+remove (다른 fs)
- UndoRename: 단순 rename 역
- UndoMkdir: 비었으면 remove, 아니면 Skipped
3 tests."
```

---

### Task 18: undo_last / undo_history commands + journal-changed event

**Files:**
- Create: `src-tauri/src/services/journal_events.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/lib.rs` (events 등록)
- Create: `src-tauri/src/commands/undo.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: services/journal_events.rs**

```rust
//! Journal 변경 이벤트.

use crate::services::journal::JournalEntry;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct JournalChangedEvent {
    pub entry: JournalEntry,
    /// "push" | "undone"
    pub change: String,
}
```

- [ ] **Step 2: services/mod.rs**

```rust
pub mod journal_events;
```

- [ ] **Step 3: commands/undo.rs**

```rust
use std::sync::Arc;

use crate::core::undo::{execute_undo, UndoOutcome};
use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::{Journal, JournalEntry};
use crate::services::journal_events::JournalChangedEvent;
use crate::types::DuetError;
use tauri_specta::Event;

#[tauri::command]
#[specta::specta]
pub async fn undo_last(
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<UndoOutcome, DuetError> {
    let entry = match journal.pop_undoable().await? {
        Some(e) => e,
        None => return Ok(UndoOutcome {
            kind: crate::core::undo::UndoKind::Skipped,
            message: Some("Nothing to undo".into()),
            refreshed_locations: vec![],
        }),
    };
    let outcome = execute_undo(&entry, pool.inner()).await;
    let _ = JournalChangedEvent {
        entry,
        change: "undone".into(),
    }.emit(&app);
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub async fn undo_history(
    limit: u32,
    journal: tauri::State<'_, Arc<Journal>>,
) -> Result<Vec<JournalEntry>, DuetError> {
    Ok(journal.history(limit as usize).await)
}
```

- [ ] **Step 4: commands/mod.rs**

```rust
pub mod undo;
```

- [ ] **Step 5: lib.rs make_specta_builder — events + commands 추가**

```rust
.events(collect_events![
    services::connection_events::ConnectionStateEvent,
    services::fs_events::FsChangedEvent,
    services::journal_events::JournalChangedEvent,
])
```

commands 에:
```rust
commands::undo::undo_last,
commands::undo::undo_history,
```

또한 fs_ops 의 `_execute` 함수들이 push 직후 JournalChangedEvent emit 하도록 수정 필요. `commands/fs_ops.rs` 의 각 execute 함수에서 `entry` 받은 직후:

```rust
let _ = crate::services::journal_events::JournalChangedEvent {
    entry: entry.clone(),
    change: "push".into(),
}.emit(&app);
```

이를 위해 각 execute command 시그니처에 `app: tauri::AppHandle` 추가.

- [ ] **Step 6: bindings 재생성 + 테스트 + 커밋**

```bash
cd src-tauri && cargo run --bin export_bindings
cargo test --lib
git add src-tauri/src/services/ src-tauri/src/commands/ src-tauri/src/lib.rs src/types/bindings.ts
git commit -m "be/cmd + be/svc: undo_last/undo_history + journal-changed 이벤트

- JournalChangedEvent { entry, change: 'push'|'undone' }
- undo_last: pop_undoable → execute_undo → emit
- undo_history(limit) → Vec<JournalEntry>
- fs_ops execute 들이 성공 시 push event emit
- bindings 갱신"
```

---

## Phase E: Frontend dialogs + 키바인딩

### Task 19: stores/ui-dialogs.ts

**Files:**
- Create: `src/stores/ui-dialogs.ts`
- Create: `src/stores/ui-dialogs.test.ts`

- [ ] **Step 1: store**

```typescript
import { create } from "zustand";
import type { CopyPlan, DeletePlan, MovePlan, EntryRef, Location } from "@/types/bindings";

export type DialogState =
  | { kind: "none" }
  | { kind: "rename"; target: EntryRef }
  | { kind: "mkdir"; parent: Location }
  | { kind: "delete-confirm"; plan: DeletePlan }
  | { kind: "delete-danger"; plan: DeletePlan }
  | { kind: "copy-confirm"; plan: CopyPlan }
  | { kind: "move-confirm"; plan: MovePlan }
  | { kind: "progress"; title: string }
  | { kind: "settings" };

interface State {
  dialog: DialogState;
  open: (d: DialogState) => void;
  close: () => void;
}

export const useUIDialogs = create<State>((set) => ({
  dialog: { kind: "none" },
  open: (d) => set({ dialog: d }),
  close: () => set({ dialog: { kind: "none" } }),
}));
```

- [ ] **Step 2: 테스트**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { useUIDialogs } from "./ui-dialogs";

describe("ui-dialogs store", () => {
  beforeEach(() => useUIDialogs.setState({ dialog: { kind: "none" } }));

  it("opens and closes", () => {
    useUIDialogs.getState().open({ kind: "settings" });
    expect(useUIDialogs.getState().dialog.kind).toBe("settings");
    useUIDialogs.getState().close();
    expect(useUIDialogs.getState().dialog.kind).toBe("none");
  });

  it("only one dialog at a time — open replaces", () => {
    useUIDialogs.getState().open({ kind: "settings" });
    useUIDialogs.getState().open({ kind: "progress", title: "x" });
    expect(useUIDialogs.getState().dialog.kind).toBe("progress");
  });
});
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
pnpm test --run src/stores/ui-dialogs.test.ts
git add src/stores/ui-dialogs.ts src/stores/ui-dialogs.test.ts
git commit -m "fe/store: ui-dialogs (discriminated union, single dialog)

2 tests."
```

---

### Task 20: stores/journal.ts

**Files:**
- Create: `src/stores/journal.ts`
- Create: `src/stores/journal.test.ts`

- [ ] **Step 1: store**

```typescript
import { create } from "zustand";
import type { JournalEntry } from "@/types/bindings";

interface State {
  entries: JournalEntry[];           // tail, 최신이 마지막
  hasUndoable: boolean;
  pushed: (e: JournalEntry) => void;
  markUndone: (id: string) => void;
  setHistory: (es: JournalEntry[]) => void;
}

const computeUndoable = (entries: JournalEntry[]) =>
  entries.some((e) => !e.undone);

export const useJournal = create<State>((set) => ({
  entries: [],
  hasUndoable: false,
  pushed: (e) => set((s) => {
    const entries = [...s.entries, e];
    return { entries, hasUndoable: computeUndoable(entries) };
  }),
  markUndone: (id) => set((s) => {
    const entries = s.entries.map((e) => e.id === id ? { ...e, undone: true } : e);
    return { entries, hasUndoable: computeUndoable(entries) };
  }),
  setHistory: (es) => set({ entries: es, hasUndoable: computeUndoable(es) }),
}));
```

- [ ] **Step 2: 테스트**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { useJournal } from "./journal";
import type { JournalEntry } from "@/types/bindings";

const mk = (id: string, undone = false): JournalEntry => ({
  id,
  timestamp: new Date().toISOString(),
  op: { kind: "mkdir", path: "/x", source: { kind: "local" } } as any,
  undo: { kind: "irreversible" } as any,
  undone,
});

describe("journal store", () => {
  beforeEach(() => useJournal.setState({ entries: [], hasUndoable: false }));

  it("pushed sets hasUndoable", () => {
    useJournal.getState().pushed(mk("1"));
    expect(useJournal.getState().hasUndoable).toBe(true);
  });

  it("markUndone clears hasUndoable when all undone", () => {
    useJournal.getState().pushed(mk("1"));
    useJournal.getState().markUndone("1");
    expect(useJournal.getState().hasUndoable).toBe(false);
  });

  it("setHistory replaces and recomputes", () => {
    useJournal.getState().setHistory([mk("a", true), mk("b", false)]);
    expect(useJournal.getState().hasUndoable).toBe(true);
  });
});
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
pnpm test --run src/stores/journal.test.ts
git add src/stores/journal.ts src/stores/journal.test.ts
git commit -m "fe/store: journal store (entries + hasUndoable derived)

3 tests."
```

---

### Task 21: hooks/useJournalEvents

**Files:**
- Create: `src/hooks/useJournalEvents.ts`

```typescript
import { useEffect } from "react";
import { events, commands } from "@/types/bindings";
import { useJournal } from "@/stores/journal";

export function useJournalEvents() {
  const pushed = useJournal((s) => s.pushed);
  const markUndone = useJournal((s) => s.markUndone);
  const setHistory = useJournal((s) => s.setHistory);

  // 부트스트랩: tail 100 로드
  useEffect(() => {
    let cancelled = false;
    commands.undoHistory(100).then((r) => {
      if (cancelled) return;
      if (r.status === "ok") setHistory(r.data);
    });
    return () => { cancelled = true; };
  }, [setHistory]);

  // 라이브 이벤트 구독
  useEffect(() => {
    const unlistenP = events.journalChangedEvent.listen(({ payload }) => {
      if (payload.change === "push") pushed(payload.entry);
      else if (payload.change === "undone") markUndone(payload.entry.id);
    });
    return () => { unlistenP.then((fn) => fn()); };
  }, [pushed, markUndone]);
}
```

- [ ] 커밋:

```bash
git add src/hooks/useJournalEvents.ts
git commit -m "fe/hook: useJournalEvents — bootstrap history + live subscribe"
```

---

### Task 22: 6개 다이얼로그 컴포넌트

**Files:**
- Create: `src/components/dialogs/RenameDialog.tsx`
- Create: `src/components/dialogs/MkdirDialog.tsx`
- Create: `src/components/dialogs/ConfirmDialog.tsx`
- Create: `src/components/dialogs/DangerConfirmDialog.tsx`
- Create: `src/components/dialogs/ProgressModal.tsx`
- Create: `src/components/SettingsDialog.tsx`

각 컴포넌트는 ConnectionDialog (Phase E Task 10 참조) 와 같은 radix-ui/react-dialog 패턴 따라가기. 핵심 인터페이스만 명시:

**RenameDialog** — props: `{ target: EntryRef | null, onClose, onSubmit(newName) }`. 입력 자동 포커스. 확장자 빼고 select. Enter=submit.

**MkdirDialog** — props: `{ parent: Location | null, onClose, onSubmit(name) }`.

**ConfirmDialog** — props: `{ title, body: ReactNode, ctaLabel, ctaTone: "neutral"|"danger", onCancel, onConfirm }`. delete-confirm/copy-confirm/move-confirm 공용.

**DangerConfirmDialog** — props: `{ title, body, requiredWord: "delete", onCancel, onConfirm }`. 입력란이 requiredWord 와 정확히 일치하기 전엔 confirm 버튼 disabled. 빨간 보더 + 빨간 confirm.

**ProgressModal** — props: `{ title }`. 스피너 + close 없음 (op 끝나면 부모가 닫음). cancel 버튼 없음 (MVP-2).

**SettingsDialog** — `commands.settingsGet()` / `commands.settingsSet()` 호출. permanent_delete_enabled 토글 + "Permanent delete is irreversible" 경고 텍스트.

각 컴포넌트는 ~60-100 줄. 커밋 단위로 분리해도 좋고 한 커밋도 OK:

```bash
git add src/components/dialogs/ src/components/SettingsDialog.tsx
git commit -m "fe/ui: 6개 다이얼로그 컴포넌트

RenameDialog, MkdirDialog, ConfirmDialog (neutral/danger tone),
DangerConfirmDialog ('delete' 타이핑), ProgressModal, SettingsDialog.
모두 radix-ui/react-dialog 위. ConnectionDialog 패턴 그대로."
```

---

### Task 23: hooks/useDestructiveKeys + Toast

**Files:**
- Create: `src/hooks/useDestructiveKeys.ts`
- Create: `src/components/Toast.tsx`
- Create: `src/stores/toast.ts`

- [ ] **Step 1: stores/toast.ts**

```typescript
import { create } from "zustand";

interface State {
  message: string | null;
  show: (msg: string) => void;
  clear: () => void;
}

export const useToast = create<State>((set) => ({
  message: null,
  show: (msg) => {
    set({ message: msg });
    setTimeout(() => {
      set((s) => s.message === msg ? { message: null } : s);
    }, 3000);
  },
  clear: () => set({ message: null }),
}));
```

- [ ] **Step 2: components/Toast.tsx**

```tsx
import { useToast } from "@/stores/toast";

export function Toast() {
  const message = useToast((s) => s.message);
  if (!message) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      <div className="rounded-md border border-border bg-base px-3 py-1.5 text-base shadow-lg">
        {message}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: hooks/useDestructiveKeys.ts**

```typescript
import { useEffect } from "react";
import { commands } from "@/types/bindings";
import type { EntryRef, DeleteMode, Location } from "@/types/bindings";
import { usePanes, type PaneId } from "@/stores/panes";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";

/**
 * F2/F5/F6/F7/Delete/Shift+Delete/Ctrl+Z 처리.
 * 활성 패널의 선택(set) 또는 cursor 위 단일 항목 대상.
 */
export function useDestructiveKeys() {
  const open = useUIDialogs((s) => s.open);
  const showToast = useToast((s) => s.show);

  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;

      const state = usePanes.getState();
      const active: PaneId = state.activePane;
      const pane = state.panes[active];
      const opposite: PaneId = active === "left" ? "right" : "left";

      const selectedNames = pane.selected.size > 0
        ? Array.from(pane.selected)
        : (pane.entries[pane.cursorIndex]?.name ? [pane.entries[pane.cursorIndex].name] : []);
      const targets: EntryRef[] = selectedNames.map((name) => ({
        location: pane.location,
        name,
      }));

      // F2 — 단일 선택만 rename
      if (e.key === "F2" && targets.length === 1) {
        e.preventDefault();
        open({ kind: "rename", target: targets[0]! });
        return;
      }

      // F7 — new folder (parent = active pane current dir)
      if (e.key === "F7") {
        e.preventDefault();
        open({ kind: "mkdir", parent: pane.location });
        return;
      }

      // F5 — copy → 반대 패널
      if (e.key === "F5" && targets.length > 0) {
        e.preventDefault();
        const dst: Location = state.panes[opposite].location;
        const r = await commands.fsCopyPlan(targets, dst);
        if (r.status === "ok") open({ kind: "copy-confirm", plan: r.data });
        else showToast(`Copy plan failed: ${formatErr(r.error)}`);
        return;
      }

      // F6 — move → 반대 패널
      if (e.key === "F6" && targets.length > 0) {
        e.preventDefault();
        const dst: Location = state.panes[opposite].location;
        const r = await commands.fsMovePlan(targets, dst);
        if (r.status === "ok") open({ kind: "move-confirm", plan: r.data });
        else showToast(`Move plan failed: ${formatErr(r.error)}`);
        return;
      }

      // Delete — trash, Shift+Delete — permanent
      if (e.key === "Delete" && targets.length > 0) {
        e.preventDefault();
        const mode: DeleteMode = e.shiftKey ? "permanent" : "trash";
        const r = await commands.fsDeletePlan(targets, mode);
        if (r.status === "ok") {
          open({ kind: mode === "permanent" ? "delete-danger" : "delete-confirm", plan: r.data });
        } else {
          showToast(`Delete plan failed: ${formatErr(r.error)}`);
        }
        return;
      }

      // Ctrl+Z — undo
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        const r = await commands.undoLast();
        if (r.status === "ok") {
          showToast(r.data.message ?? `Undone (${r.data.kind})`);
          // 영향받은 location refresh — App.tsx 가 onRefresh 패턴 갖고 있어서 직접 호출 어려움
          // 간단히는 양 패널 모두 refresh trigger (fs-changed-event 가 알아서 잡지 못할 수도)
          // 별도 이벤트로 처리 — App.tsx 가 listen
        } else {
          showToast(`Undo failed: ${formatErr(r.error)}`);
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, showToast]);
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "message" in e) return String((e as any).message);
  if (typeof e === "object" && e && "kind" in e) return String((e as any).kind);
  return String(e);
}
```

- [ ] **Step 4: 커밋**

```bash
git add src/hooks/useDestructiveKeys.ts src/components/Toast.tsx src/stores/toast.ts
git commit -m "fe/hook + fe/ui: useDestructiveKeys + Toast

키바인딩: F2/F5/F6/F7/Delete/Shift+Delete/Ctrl+Z. 활성 패널 + selection.
plan 호출 → ui-dialogs.open. Toast: 3초 자동 fade."
```

---

### Task 24: App.tsx 통합 — 다이얼로그 핸들러 + execute 호출

**Files:**
- Modify: `src/App.tsx`

App 에서 dialog state 읽고 매칭되는 컴포넌트 렌더 + execute 호출 핸들러:

- [ ] **Step 1: imports + hook 호출 추가**

```tsx
import { useDestructiveKeys } from "@/hooks/useDestructiveKeys";
import { useJournalEvents } from "@/hooks/useJournalEvents";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import { RenameDialog } from "@/components/dialogs/RenameDialog";
import { MkdirDialog } from "@/components/dialogs/MkdirDialog";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { DangerConfirmDialog } from "@/components/dialogs/DangerConfirmDialog";
import { ProgressModal } from "@/components/dialogs/ProgressModal";
import { SettingsDialog } from "@/components/SettingsDialog";
import { Toast } from "@/components/Toast";
```

- [ ] **Step 2: 부트 hook 호출**

```tsx
useDestructiveKeys();
useJournalEvents();
```

- [ ] **Step 3: Dialog dispatcher**

```tsx
const dialog = useUIDialogs((s) => s.dialog);
const closeDialog = useUIDialogs((s) => s.close);
const openDialog = useUIDialogs((s) => s.open);
const showToast = useToast((s) => s.show);

const refreshAffected = useCallback(async (locations: Location[]) => {
  const panes = usePanes.getState().panes;
  for (const id of ["left", "right"] as const) {
    const same = locations.some((loc) =>
      loc.source.kind === panes[id].location.source.kind &&
      loc.path === panes[id].location.path
    );
    if (same) onRefresh(id);
  }
}, [onRefresh]);

// 각 다이얼로그 confirm 핸들러:
const onRenameSubmit = async (newName: string) => {
  if (dialog.kind !== "rename") return;
  const r = await commands.fsRename(dialog.target, newName);
  closeDialog();
  if (r.status === "ok") refreshAffected([dialog.target.location]);
  else showToast(`Rename failed: ${formatErr(r.error)}`);
};

const onMkdirSubmit = async (name: string) => {
  if (dialog.kind !== "mkdir") return;
  const r = await commands.fsMkdir(dialog.parent, name);
  closeDialog();
  if (r.status === "ok") refreshAffected([dialog.parent]);
  else showToast(`Mkdir failed: ${formatErr(r.error)}`);
};

const onDeleteConfirm = async () => {
  if (dialog.kind !== "delete-confirm" && dialog.kind !== "delete-danger") return;
  const plan = dialog.plan;
  openDialog({ kind: "progress", title: "Deleting..." });
  const r = await commands.fsDeleteExecute(plan);
  closeDialog();
  if (r.status === "ok") refreshAffected([plan.source_location]);
  else showToast(`Delete failed: ${formatErr(r.error)}`);
};

const onCopyConfirm = async () => {
  if (dialog.kind !== "copy-confirm") return;
  const plan = dialog.plan;
  openDialog({ kind: "progress", title: "Copying..." });
  const r = await commands.fsCopyExecute(plan);
  closeDialog();
  if (r.status === "ok") refreshAffected([plan.dst]);
  else showToast(`Copy failed: ${formatErr(r.error)}`);
};

const onMoveConfirm = async () => {
  if (dialog.kind !== "move-confirm") return;
  const plan = dialog.plan;
  openDialog({ kind: "progress", title: "Moving..." });
  const r = await commands.fsMoveExecute(plan);
  closeDialog();
  if (r.status === "ok") refreshAffected([plan.items[0]!.location, plan.dst]);
  else showToast(`Move failed: ${formatErr(r.error)}`);
};
```

(`formatErr` 는 useDestructiveKeys 와 같은 유틸; 공통 `lib/error.ts` 로 추출해도 OK.)

- [ ] **Step 4: JSX 끝부분에 dialog dispatcher**

```tsx
{dialog.kind === "rename" && (
  <RenameDialog target={dialog.target} onClose={closeDialog} onSubmit={onRenameSubmit} />
)}
{dialog.kind === "mkdir" && (
  <MkdirDialog parent={dialog.parent} onClose={closeDialog} onSubmit={onMkdirSubmit} />
)}
{dialog.kind === "delete-confirm" && (
  <ConfirmDialog
    title="Delete to trash?"
    body={`${dialog.plan.total_count} items, ${formatBytes(dialog.plan.total_size_bytes)}`}
    ctaLabel="Delete"
    ctaTone="neutral"
    onCancel={closeDialog}
    onConfirm={onDeleteConfirm}
  />
)}
{dialog.kind === "delete-danger" && (
  <DangerConfirmDialog
    title="Permanently delete?"
    body={`This cannot be undone. ${dialog.plan.total_count} items.`}
    requiredWord="delete"
    onCancel={closeDialog}
    onConfirm={onDeleteConfirm}
  />
)}
{dialog.kind === "copy-confirm" && (
  <ConfirmDialog
    title="Copy"
    body={<CopyPlanBody plan={dialog.plan} />}
    ctaLabel="Copy"
    ctaTone="neutral"
    onCancel={closeDialog}
    onConfirm={onCopyConfirm}
  />
)}
{dialog.kind === "move-confirm" && (
  <ConfirmDialog
    title="Move"
    body={<MovePlanBody plan={dialog.plan} />}
    ctaLabel="Move"
    ctaTone="neutral"
    onCancel={closeDialog}
    onConfirm={onMoveConfirm}
  />
)}
{dialog.kind === "progress" && <ProgressModal title={dialog.title} />}
{dialog.kind === "settings" && <SettingsDialog onClose={closeDialog} />}
<Toast />
```

CopyPlanBody / MovePlanBody 는 conflicts 리스트 + total size 표시 — 같은 파일에 helper component.

- [ ] **Step 5: StatusBar 에 settings 아이콘 추가**

`src/components/StatusBar.tsx` 우측 끝에:
```tsx
import { Settings as SettingsIcon } from "lucide-react";
import { useUIDialogs } from "@/stores/ui-dialogs";
// ...
const open = useUIDialogs((s) => s.open);
// ...
<button onClick={() => open({ kind: "settings" })} className="rounded p-1 hover:bg-border">
  <SettingsIcon size={12} />
</button>
```

- [ ] **Step 6: tsc + lint + 테스트 + 커밋**

```bash
pnpm tsc --noEmit
pnpm lint
pnpm test --run
git add src/App.tsx src/components/StatusBar.tsx
git commit -m "fe: App 통합 — dialog dispatcher + execute 핸들러 + Settings 아이콘"
```

---

## Phase F: 마무리

### Task 25: 수동 검증 + 최종 quality gates + ROADMAP

- [ ] **Step 1: 수동 검증 (`pnpm tauri dev`)**

체크리스트:
- 로컬 패널에서 F7 → 새 폴더 생성 → 양쪽 패널 자동 refresh
- F2 → 이름 변경 → refresh
- F5 (Local→Local) → confirm dialog → 충돌 시 .bak.* 생성 확인
- F6 (Local→Local 같은 dir) → rename 으로 처리, 다른 dir → copy+trash
- Delete → trash dialog → OS 휴지통에 들어감 확인
- Ctrl+Z → 휴지통 항목 원위치 복원
- Settings 아이콘 → permanent_delete_enabled 토글 → Shift+Delete 다이얼로그 활성화
- Shift+Delete → "delete" 타이핑 전엔 disabled → 타이핑 후 영구삭제
- 영구삭제 후 Ctrl+Z → "Cannot undo permanent delete" toast
- (SSH 호스트 연결 후) SSH 패널에서 F2/F5/F6/F7/Delete 동작
- 같은 SSH 호스트로 F5 시도 → "MVP-3 에서 지원" 에러 toast

- [ ] **Step 2: cargo + pnpm 최종 quality gates**

```bash
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --lib
cd .. && pnpm tsc --noEmit && pnpm lint && pnpm test --run
```

모두 통과 확인.

- [ ] **Step 3: ROADMAP MVP-2 [x]**

`ROADMAP.md` MVP-2 섹션:

```markdown
- [x] `DeleteOp`, `CopyOp`, `MoveOp` trait + `Confirmed` 토큰 — Confirmed 토큰은 plan/execute 두 단계 IPC 로 대체 (spec 참조)
- [x] 휴지통 모델 (로컬: trash crate, 원격: ~/.duet-trash/<batch>/<original>)
- [x] 영구 삭제 디폴트 OFF, 켜져 있어도 단어 타이핑 확인
- [x] 확인 다이얼로그 컴포넌트 (Confirm / DangerConfirm)
- [x] Journal 시스템 (config_dir/duet/journal.jsonl)
- [x] Undo (`Ctrl+Z`) — N 단계 walk
- [x] 복사 (F5)
- [x] 이동 (F6)
- [x] 이름 변경 (F2)
- [x] 새 폴더 (F7)
- [x] 충돌 시 backup 파일 (`name.bak.<UTC ts>`)
```

`현재 단계`:
```markdown
**MVP-3 시작 직전.** MVP-2 완료. 일상 사용 가능 — TC 대체. 단, 같은 SSH 호스트 복사는 아직 명시 차단.
```

- [ ] **Step 4: 커밋**

```bash
git add ROADMAP.md
git commit -m "docs: MVP-2 완료 표시"
```

---

## 자기 점검 (작성자용)

**Spec 커버리지:**

| Spec section | Task |
|---|---|
| Settings | 2, 4 |
| Journal (storage) | 3 |
| Trash (helpers) | 7 |
| FileSystem 확장 (Local) | 5, 6, 8, 9 |
| FileSystem 확장 (SSH) | 10-12 (가이드라인) |
| Op trait + Delete | 13 |
| Copy + Move + same-host block | 14 |
| Rename + Mkdir | 15 |
| IPC commands | 16, 18 |
| Undo dispatcher | 17 |
| Frontend stores | 19, 20 |
| Frontend hooks | 21, 23 |
| Dialog components | 22 |
| App integration | 24 |
| 수동 검증 + ROADMAP | 25 |

**위험 영역 / 미정:**
- Task 10-12 (SSH 측 trait 구현) — 본 plan 은 가이드라인만, 실제 코드 작성 시 sftp API 정확한 시그니처 docs.rs 재확인 필요
- 큰 파일 copy_relay: 현재 read_full → write_full (메모리 전체 적재) — 8MB+ 파일에서 메모리 폭주. 후속 task 에서 청크 streaming 화 (MVP-2 마무리 전후로 결정)
- LocalFs::trash 의 trash crate cross-platform 동작 — Linux 일부 디스트로 (XDG trash 미지원) 에서 동작 확인 필요
- 큰 파일 / 다수 파일 stress test 는 MVP-4 (TaskQueue) 와 함께

---

## 실행 핸드오프

Plan complete and saved to `docs/plans/2026-05-09-mvp2-destructive-ops-undo.md`.

**Phase 단위 권장 분할:**
- Session 1: Phase A (Task 1-4) — Settings + Journal foundation
- Session 2: Phase B Local 측 (Task 5-9) — LocalFs 확장
- Session 3: Phase B SSH 측 (Task 10-12) — SshFs 확장 (실제 sftp API 검증)
- Session 4: Phase C (Task 13-16) — core/ops + commands
- Session 5: Phase D (Task 17-18) — Undo
- Session 6: Phase E (Task 19-24) — Frontend
- Session 7: Phase F (Task 25) — 수동 검증 + 마무리

각 Session 끝에 `cargo test --lib` + `pnpm test --run` 베이스라인 + 커밋.
