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
    Sync {
        count: u32,
        /// prune 로 휴지통으로 보낸(삭제 전파) 개수.
        pruned: u32,
        src: Location,
        dst: Location,
    },
    /// 양방향 머지 — 한쪽에만 있던 파일을 반대편으로 복사(양쪽 모두). 충돌은 건드리지 않음.
    Merge {
        left: Location,
        right: Location,
        /// 오른쪽→왼쪽으로 복사한 개수 / 왼쪽→오른쪽으로 복사한 개수.
        to_left: u32,
        to_right: u32,
    },
    /// 비교창에서 행별 방향을 골라 적용 — 생성 + 덮어쓰기(백업 후) 혼합.
    CompareApply {
        left: Location,
        right: Location,
        /// 실제 복사한 항목 수 / 그중 덮어쓰기(백업 생성)한 수.
        applied: u32,
        overwritten: u32,
    },
    /// 3-way 자동 해결 적용 — base 대비 한쪽 변경/추가/삭제를 반대편에 반영.
    ThreeWayApply {
        base: Location,
        left: Location,
        right: Location,
        /// 자동 적용한 항목 수 / 건너뛴 충돌 수.
        applied: u32,
        conflicts: u32,
    },
    /// 권한(chmod) 변경 — 비재귀는 undo 가능(이전 mode 기록), 재귀는 Irreversible.
    Chmod {
        count: u32,
        mode: u32,
        recursive: bool,
        location: Location,
    },
    /// 소유자(chown) 변경 — 원격 전용. 이전 소유자 기록이 없어 Irreversible.
    Chown {
        count: u32,
        spec: String,
        recursive: bool,
        location: Location,
    },
    /// 심볼릭 링크 생성.
    Symlink {
        path: PathBuf,
        source: SourceId,
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
        /// redo 용 원본 소스 — 구버전 journal 라인엔 없음(default → redo 불가).
        #[serde(default)]
        src_source: Option<SourceId>,
        /// `copied[i]` 의 원본 경로(병렬 배열). 구버전/아카이브 추출은 빈 벡터.
        #[serde(default)]
        copied_from: Vec<PathBuf>,
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
    /// 양방향 머지 되돌리기 — 양쪽에 새로 복사된 파일들을 제거(충돌은 안 건드렸으므로 복원할 백업 없음).
    UndoBidirMerge {
        left_source: SourceId,
        left_created: Vec<PathBuf>,
        right_source: SourceId,
        right_created: Vec<PathBuf>,
        /// redo 용 성공 복사 쌍 — created 와 달리 partial 정리 항목 제외.
        /// left_pairs = 왼쪽에 생성(from 은 right 측 경로). 구버전 라인은 빈 벡터.
        #[serde(default)]
        left_pairs: Vec<RedoCopyPair>,
        #[serde(default)]
        right_pairs: Vec<RedoCopyPair>,
    },
    /// 단방향 sync 되돌리기 — 새로 복사 제거 + 덮어쓴 백업 복원 + prune 삭제분 휴지통 복원.
    /// (휴지통 복원은 best-effort — macOS 로컬은 NotSupported 라 수동 복원 필요.)
    UndoSync {
        dst_source: SourceId,
        created: Vec<PathBuf>,
        backups_to_restore: Vec<BackupRestore>,
        pruned: Vec<TrashItem>,
        /// redo 용 원본 소스 — 구버전 라인엔 없음(default → redo 불가).
        #[serde(default)]
        src_source: Option<SourceId>,
        /// `created[i]` 의 원본 경로(병렬 배열). 구버전은 빈 벡터.
        #[serde(default)]
        created_from: Vec<PathBuf>,
    },
    /// 비교 적용 되돌리기 — 양쪽 각각 새로 생성분 제거 + 덮어쓴 백업 복원.
    /// (방향이 ToLeft/ToRight 혼합이라 양쪽 모두 추적.)
    UndoCompareApply {
        left_source: SourceId,
        right_source: SourceId,
        left_created: Vec<PathBuf>,
        right_created: Vec<PathBuf>,
        left_backups: Vec<BackupRestore>,
        right_backups: Vec<BackupRestore>,
        /// redo 용 성공 복사 쌍 (신규 생성만 — 덮어쓰기 행 제외). 구버전은 빈 벡터.
        #[serde(default)]
        left_pairs: Vec<RedoCopyPair>,
        #[serde(default)]
        right_pairs: Vec<RedoCopyPair>,
    },
    /// 3-way 적용 되돌리기 — 생성분 제거 + 덮어쓴 백업 복원 + 삭제(휴지통)분 복원.
    UndoThreeWayApply {
        left_source: SourceId,
        right_source: SourceId,
        left_created: Vec<PathBuf>,
        right_created: Vec<PathBuf>,
        left_backups: Vec<BackupRestore>,
        right_backups: Vec<BackupRestore>,
        trashed_left: Vec<TrashItem>,
        trashed_right: Vec<TrashItem>,
    },
    /// chmod 되돌리기 — 항목별 이전 mode 재적용 (비재귀 chmod 만 기록됨).
    UndoChmod {
        source: SourceId,
        items: Vec<ChmodItem>,
    },
    /// 심볼릭 링크 생성 되돌리기 — 링크 자체만 제거(대상 불변).
    UndoSymlink {
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

/// redo 용 (원본 → 대상) 복사 쌍 — merge/compare-apply 의 성공한 복사만 기록.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RedoCopyPair {
    pub from: PathBuf,
    pub to: PathBuf,
}

/// batch rename 의 항목별 (현재 경로 → 원래 경로) — undo 시 단일 그룹으로 복원.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RenamePair {
    pub current: PathBuf,
    pub original: PathBuf,
}

/// chmod undo 항목 — 적용 전 mode 로 되돌리기 위한 (경로, 이전 mode).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ChmodItem {
    pub path: PathBuf,
    pub old_mode: u32,
}

/// jsonl 한 줄. push 새 entry 또는 기존 entry undone 토글.
/// `Push` variant 가 ~400B 라 enum 크기 차이가 커서 Box 로 indirect.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
enum JsonlRecord {
    Push(Box<JournalEntry>),
    MarkUndone {
        id: JournalId,
    },
    /// redo 성공 — undone 을 false 로 되돌림 (undo 의 역마킹).
    MarkRedone {
        id: JournalId,
    },
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

    /// 가장 최근 undone == false entry 를 **마킹 없이** 반환. `None` 이면 undo 할 게 없음.
    ///
    /// undo 실행 *전* 조회용. 실제 undone 확정은 실행 성공 후 [`commit_undone`] 으로.
    /// (이전 `pop_undoable` 은 실행 전에 undone 을 박아, undo 실패 시 영구 손실됐음.)
    pub async fn peek_undoable(&self) -> Result<Option<JournalEntry>, DuetError> {
        let lock = self.inner.lock().await;
        Ok(lock
            .iter()
            .rposition(|e| !e.undone)
            .map(|i| lock[i].clone()))
    }

    /// undo 실행 성공(또는 비가역 종결) 후 호출 — 메모리 + 디스크에 undone 확정. 멱등.
    /// 캐시에서 이미 밀려난 오래된 id 는 no-op (디스크 replay 가 이미 반영).
    pub async fn commit_undone(&self, id: JournalId) -> Result<(), DuetError> {
        {
            let mut lock = self.inner.lock().await;
            match lock.iter_mut().find(|e| e.id == id) {
                Some(e) if !e.undone => e.undone = true,
                _ => return Ok(()),
            }
        }
        self.append(JsonlRecord::MarkUndone { id }).await
    }

    /// 꼬리쪽 연속 undone 구간에서 **가장 이른** entry — 다음 redo 대상 (LIFO 역순).
    ///
    /// undo 가 B→A 순서로 진행됐다면 redo 는 A→B 순서. 마지막 entry 가 undone 이
    /// 아니면(새 작업이 이후에 push 됨) redo 불가 — 표준 undo/redo 스택 관례.
    pub async fn peek_redoable(&self) -> Result<Option<JournalEntry>, DuetError> {
        let lock = self.inner.lock().await;
        let mut candidate = None;
        for e in lock.iter().rev() {
            if e.undone {
                candidate = Some(e.clone());
            } else {
                break;
            }
        }
        Ok(candidate)
    }

    /// redo 실행 성공 후 호출 — undone 을 false 로 되돌림. 멱등.
    pub async fn commit_redone(&self, id: JournalId) -> Result<(), DuetError> {
        {
            let mut lock = self.inner.lock().await;
            match lock.iter_mut().find(|e| e.id == id) {
                Some(e) if e.undone => e.undone = false,
                _ => return Ok(()),
            }
        }
        self.append(JsonlRecord::MarkRedone { id }).await
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
            JsonlRecord::MarkRedone { id } => {
                if let Some(found) = entries.iter_mut().find(|e| e.id == id) {
                    found.undone = false;
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
    async fn undo_copy_old_format_line_parses_with_defaults() {
        // 2단계에서 추가된 src_source/copied_from 이 없는 구버전 journal 라인 —
        // serde(default) 로 파싱돼야 기존 사용자 journal 이 안 깨진다.
        let dir = tempdir().unwrap();
        let path = dir.path().join("j.jsonl");
        let line = format!(
            r#"{{"type":"Push","id":"{}","timestamp":"2026-01-01T00:00:00Z","op":{{"kind":"copy","count":1,"src":{{"source":{{"kind":"local"}},"path":"/a"}},"dst":{{"source":{{"kind":"local"}},"path":"/b"}}}},"undo":{{"kind":"undo_copy","target_source":{{"kind":"local"}},"copied":["/b/x"],"backups_to_restore":[]}},"undone":false}}"#,
            Uuid::now_v7()
        );
        tokio::fs::write(&path, format!("{line}\n")).await.unwrap();
        let j = Journal::load_from(&path).await.unwrap();
        let h = j.history(10).await;
        assert_eq!(h.len(), 1);
        match &h[0].undo {
            UndoAction::UndoCopy {
                src_source,
                copied_from,
                ..
            } => {
                assert!(src_source.is_none());
                assert!(copied_from.is_empty());
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[tokio::test]
    async fn redo_peek_lifo_and_commit_roundtrip() {
        let dir = tempdir().unwrap();
        let j = Journal::load_from(&dir.path().join("j.jsonl"))
            .await
            .unwrap();
        let a = j.push(mk_op(), mk_undo()).await.unwrap();
        let b = j.push(mk_op(), mk_undo()).await.unwrap();
        // undo 진행 전엔 redo 없음.
        assert!(j.peek_redoable().await.unwrap().is_none());
        // undo 순서 B → A. redo 는 역순 A → B.
        j.commit_undone(b.id.clone()).await.unwrap();
        j.commit_undone(a.id.clone()).await.unwrap();
        assert_eq!(j.peek_redoable().await.unwrap().unwrap().id, a.id);
        j.commit_redone(a.id.clone()).await.unwrap();
        assert_eq!(j.peek_redoable().await.unwrap().unwrap().id, b.id);
        j.commit_redone(b.id.clone()).await.unwrap();
        assert!(j.peek_redoable().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn redo_blocked_by_new_push_and_survives_replay() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("j.jsonl");
        let j = Journal::load_from(&path).await.unwrap();
        let a = j.push(mk_op(), mk_undo()).await.unwrap();
        j.commit_undone(a.id.clone()).await.unwrap();
        // 새 push 가 끼면 마지막 entry 가 non-undone → redo 불가 (표준 관례).
        let b = j.push(mk_op(), mk_undo()).await.unwrap();
        assert!(j.peek_redoable().await.unwrap().is_none());
        j.commit_undone(b.id.clone()).await.unwrap();
        j.commit_redone(b.id.clone()).await.unwrap();
        // replay: MarkRedone 반영 — b 는 undone=false, a 는 여전히 undone.
        let j2 = Journal::load_from(&path).await.unwrap();
        let hist = j2.history(10).await;
        assert!(!hist.iter().find(|e| e.id == b.id).unwrap().undone);
        assert!(hist.iter().find(|e| e.id == a.id).unwrap().undone);
    }

    #[tokio::test]
    async fn peek_commit_walks_stack() {
        let dir = tempdir().unwrap();
        let j = Journal::load_from(&dir.path().join("j.jsonl"))
            .await
            .unwrap();
        let a = j.push(mk_op(), mk_undo()).await.unwrap();
        let b = j.push(mk_op(), mk_undo()).await.unwrap();
        // 가장 최근 = b, commit 해야 다음으로 넘어감
        assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, b.id);
        j.commit_undone(b.id).await.unwrap();
        // 다음 = a
        assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, a.id);
        j.commit_undone(a.id).await.unwrap();
        // 더 없음
        assert!(j.peek_undoable().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn peek_does_not_mark_until_commit() {
        let dir = tempdir().unwrap();
        let j = Journal::load_from(&dir.path().join("j.jsonl"))
            .await
            .unwrap();
        let a = j.push(mk_op(), mk_undo()).await.unwrap();
        // peek 을 여러 번 해도 같은 엔트리 — 아직 소비 안 됨(undo 실패 시 재시도 가능).
        assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, a.id);
        assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, a.id);
        // commit 후에만 소비됨.
        j.commit_undone(a.id).await.unwrap();
        assert!(j.peek_undoable().await.unwrap().is_none());
        // commit 멱등 — 두 번 호출해도 안전.
        j.commit_undone(a.id).await.unwrap();
    }

    #[tokio::test]
    async fn persists_across_load() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("j.jsonl");
        {
            let j = Journal::load_from(&path).await.unwrap();
            let a = j.push(mk_op(), mk_undo()).await.unwrap();
            j.commit_undone(a.id).await.unwrap();
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
