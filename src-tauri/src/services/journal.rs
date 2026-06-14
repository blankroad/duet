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

impl Default for JournalId {
    fn default() -> Self {
        Self::new()
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
    Trash {
        count: u32,
        location: Location,
    },
    PermanentDelete {
        count: u32,
        location: Location,
    },
    Copy {
        count: u32,
        src: Location,
        dst: Location,
    },
    Move {
        count: u32,
        src: Location,
        dst: Location,
    },
    Rename {
        from: PathBuf,
        to: PathBuf,
        source: SourceId,
    },
    BatchRename {
        count: u32,
        location: Location,
    },
    Mkdir {
        path: PathBuf,
        source: SourceId,
    },
    Extract {
        archive: Location,
        dest: Location,
    },
    Compress {
        count: u32,
        dst: Location,
    },
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
    UndoBatchRename {
        source: SourceId,
        /// 모든 항목을 한 번에 되돌리기 위한 (현재 → 원본) 쌍 목록.
        pairs: Vec<RenamePair>,
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

/// batch rename 의 항목별 (현재 경로 → 원래 경로) — undo 시 단일 그룹으로 복원.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RenamePair {
    pub current: PathBuf,
    pub original: PathBuf,
}

/// jsonl 한 줄. push 새 entry 또는 기존 entry undone 토글.
/// `Push` variant 가 ~400B 라 enum 크기 차이가 커서 Box 로 indirect.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
enum JsonlRecord {
    Push(Box<JournalEntry>),
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
        self.append(JsonlRecord::Push(Box::new(entry.clone())))
            .await?;
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
        let Some(idx) = target_idx else {
            return Ok(None);
        };
        let mut entry = lock[idx].clone();
        entry.undone = true;
        lock[idx].undone = true;
        drop(lock);
        self.append(JsonlRecord::MarkUndone { id: entry.id })
            .await?;
        Ok(Some(entry))
    }

    pub async fn history(&self, limit: usize) -> Vec<JournalEntry> {
        let lock = self.inner.lock().await;
        lock.iter().rev().take(limit).cloned().collect()
    }

    async fn append(&self, record: JsonlRecord) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let line = serde_json::to_string(&record)
            .map_err(|e| DuetError::Io(format!("journal serialize: {e}")))?;
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await
            .map_err(DuetError::from)?;
        file.write_all(line.as_bytes())
            .await
            .map_err(DuetError::from)?;
        file.write_all(b"\n").await.map_err(DuetError::from)?;
        file.flush().await.map_err(DuetError::from)?;
        Ok(())
    }
}

/// jsonl 파일을 처음부터 읽어 push/markundone 을 replay 후 마지막 limit 개 반환.
async fn read_tail(path: &Path, limit: usize) -> Result<VecDeque<JournalEntry>, DuetError> {
    let text = tokio::fs::read_to_string(path)
        .await
        .map_err(DuetError::from)?;
    let mut entries: Vec<JournalEntry> = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let rec: JsonlRecord = serde_json::from_str(line)
            .map_err(|e| DuetError::Io(format!("journal line {} parse: {e}", i + 1)))?;
        match rec {
            JsonlRecord::Push(e) => entries.push(*e),
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
            location: Location {
                source: SourceId::Local,
                path: PathBuf::from("/tmp"),
            },
        }
    }

    #[tokio::test]
    async fn push_and_history() {
        let dir = tempdir().unwrap();
        let j = Journal::load_from(&dir.path().join("j.jsonl"))
            .await
            .unwrap();
        j.push(mk_op(), mk_undo()).await.unwrap();
        j.push(mk_op(), mk_undo()).await.unwrap();
        let h = j.history(10).await;
        assert_eq!(h.len(), 2);
    }

    #[tokio::test]
    async fn pop_undoable_walks_stack() {
        let dir = tempdir().unwrap();
        let j = Journal::load_from(&dir.path().join("j.jsonl"))
            .await
            .unwrap();
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
