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

async fn fs_for(
    source: &SourceId,
    pool: &Arc<ConnectionPool>,
) -> Result<Box<dyn FileSystem>, DuetError> {
    match source {
        SourceId::Local => Ok(Box::new(LocalFs::new())),
        SourceId::Ssh { connection_id, .. } => {
            let conn = pool.get(connection_id).await?;
            Ok(Box::new(SshFs::new(conn)))
        }
    }
}

pub async fn execute_undo(entry: &JournalEntry, pool: &Arc<ConnectionPool>) -> UndoOutcome {
    match &entry.undo {
        UndoAction::Irreversible => UndoOutcome {
            kind: UndoKind::Irreversible,
            message: Some("Cannot undo permanent delete".into()),
            refreshed_locations: vec![],
        },
        UndoAction::RestoreFromTrash { source, items } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            let mut refresh = std::collections::HashSet::<PathBuf>::new();
            for item in items {
                let actual_loc = match source {
                    SourceId::Local => TrashLocation::Local {
                        trash_id: item.trash_path.clone(),
                    },
                    SourceId::Ssh { .. } => TrashLocation::Remote {
                        trash_path: PathBuf::from(&item.trash_path),
                    },
                };
                if let Err(e) = fs
                    .restore_from_trash(&actual_loc, &item.original_path)
                    .await
                {
                    return error("restore failed", e);
                }
                if let Some(parent) = item.original_path.parent() {
                    refresh.insert(parent.to_path_buf());
                }
            }
            ok_with_locs(source, refresh)
        }
        UndoAction::UndoCopy {
            target_source,
            copied,
            backups_to_restore,
        } => {
            let fs = match fs_for(target_source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            // 1) 새로 만든 파일들 삭제 (영구) — undo 본질
            for p in copied {
                if fs.metadata(p).await.is_ok() {
                    if let Err(e) = fs.remove(p).await {
                        return error("remove copied", e);
                    }
                }
            }
            // 2) backup → 원래 자리로 mv
            for b in backups_to_restore {
                if fs.metadata(&b.backup_path).await.is_ok() {
                    if let Err(e) = fs.rename(&b.backup_path, &b.original_path).await {
                        return error("restore backup", e);
                    }
                }
            }
            let mut refresh = std::collections::HashSet::<PathBuf>::new();
            for p in copied {
                if let Some(par) = p.parent() {
                    refresh.insert(par.to_path_buf());
                }
            }
            ok_with_locs(target_source, refresh)
        }
        UndoAction::UndoMove {
            src_source,
            dst_source,
            moved,
            backups_to_restore,
        } => {
            let src_fs_r = fs_for(src_source, pool).await;
            let dst_fs_r = fs_for(dst_source, pool).await;
            let (src_fs, dst_fs) = match (src_fs_r, dst_fs_r) {
                (Ok(a), Ok(b)) => (a, b),
                _ => {
                    return UndoOutcome {
                        kind: UndoKind::Error,
                        message: Some("source unreachable".into()),
                        refreshed_locations: vec![],
                    }
                }
            };
            for m in moved {
                if dst_fs.metadata(&m.dst_now).await.is_err() {
                    return UndoOutcome {
                        kind: UndoKind::Skipped,
                        message: Some("Item no longer at moved location — undo skipped".into()),
                        refreshed_locations: vec![],
                    };
                }
                // 같은 source 면 rename 으로 되돌림(빠름). 단 로컬 C:↔D: 처럼 물리 드라이브가
                // 달라 rename 이 cross-device 로 거부되면 copy+remove 로 폴백(cross-source 와
                // 동일) — 안 그러면 undo 가 실패하고 원본이 휴지통에 갇힌다(§4 위반).
                let renamed = if src_source == dst_source {
                    match src_fs.rename(&m.dst_now, &m.src_original).await {
                        Ok(()) => true,
                        Err(DuetError::CrossDevice(_)) => false,
                        Err(e) => return error("rename back", e),
                    }
                } else {
                    false
                };
                if !renamed {
                    if let Err(e) =
                        copy_relay(&*dst_fs, &m.dst_now, &*src_fs, &m.src_original).await
                    {
                        return error("copy back", e);
                    }
                    let _ = dst_fs.remove(&m.dst_now).await;
                }
            }
            for b in backups_to_restore {
                if dst_fs.metadata(&b.backup_path).await.is_ok() {
                    let _ = dst_fs.rename(&b.backup_path, &b.original_path).await;
                }
            }
            let mut refresh = std::collections::HashSet::<(SourceId, PathBuf)>::new();
            for m in moved {
                if let Some(p) = m.dst_now.parent() {
                    refresh.insert((dst_source.clone(), p.to_path_buf()));
                }
                if let Some(p) = m.src_original.parent() {
                    refresh.insert((src_source.clone(), p.to_path_buf()));
                }
            }
            UndoOutcome {
                kind: UndoKind::Ok,
                message: None,
                refreshed_locations: refresh
                    .into_iter()
                    .map(|(s, p)| Location { source: s, path: p })
                    .collect(),
            }
        }
        UndoAction::UndoRename {
            source,
            current,
            original,
        } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            if let Err(e) = fs.rename(current, original).await {
                return error("rename back", e);
            }
            UndoOutcome {
                kind: UndoKind::Ok,
                message: None,
                refreshed_locations: original
                    .parent()
                    .map(|p| Location {
                        source: source.clone(),
                        path: p.to_path_buf(),
                    })
                    .into_iter()
                    .collect(),
            }
        }
        UndoAction::UndoBatchRename { source, pairs } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            // 역순으로 current → original 복원. forward 에서 new==old 겹침을 차단했으므로
            // 순서 무관하게 충돌 없이 복원 가능.
            let mut refresh = std::collections::HashSet::<PathBuf>::new();
            for p in pairs.iter().rev() {
                if fs.metadata(&p.current).await.is_err() {
                    return UndoOutcome {
                        kind: UndoKind::Skipped,
                        message: Some("Item no longer at renamed location — undo skipped".into()),
                        refreshed_locations: vec![],
                    };
                }
                if let Err(e) = fs.rename(&p.current, &p.original).await {
                    return error("rename back", e);
                }
                if let Some(par) = p.original.parent() {
                    refresh.insert(par.to_path_buf());
                }
            }
            ok_with_locs(source, refresh)
        }
        UndoAction::UndoMkdir { source, path } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            let entries = fs.list(path).await.unwrap_or_default();
            if !entries.is_empty() {
                return UndoOutcome {
                    kind: UndoKind::Skipped,
                    message: Some("Directory not empty — undo skipped".into()),
                    refreshed_locations: vec![],
                };
            }
            if let Err(e) = fs.remove(path).await {
                return error("rmdir", e);
            }
            UndoOutcome {
                kind: UndoKind::Ok,
                message: None,
                refreshed_locations: path
                    .parent()
                    .map(|p| Location {
                        source: source.clone(),
                        path: p.to_path_buf(),
                    })
                    .into_iter()
                    .collect(),
            }
        }
        UndoAction::UndoBidirMerge {
            left_source,
            left_created,
            right_source,
            right_created,
        } => {
            // 양쪽에 새로 복사된 것만 제거(충돌은 안 건드렸으니 복원할 백업 없음).
            let mut refresh = std::collections::HashSet::<(SourceId, PathBuf)>::new();
            for (source, created) in [(left_source, left_created), (right_source, right_created)] {
                if let Ok(fs) = fs_for(source, pool).await {
                    for p in created {
                        let _ = fs.remove(p).await;
                        if let Some(par) = p.parent() {
                            refresh.insert((source.clone(), par.to_path_buf()));
                        }
                    }
                }
            }
            UndoOutcome {
                kind: UndoKind::Ok,
                message: None,
                refreshed_locations: refresh
                    .into_iter()
                    .map(|(s, p)| Location { source: s, path: p })
                    .collect(),
            }
        }
        UndoAction::UndoSync {
            dst_source,
            created,
            backups_to_restore,
            pruned,
        } => {
            let fs = match fs_for(dst_source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            // 1) 새로 복사한 파일 제거.
            for p in created {
                if fs.metadata(p).await.is_ok() {
                    if let Err(e) = fs.remove(p).await {
                        return error("remove copied", e);
                    }
                }
            }
            // 2) 덮어쓴 백업 복원. original_path 에는 rsync 가 덮어쓴 *새* 내용이 있으므로
            //    먼저 제거 후 rename — SFTP 는 rename-over-existing 이 실패하기 때문.
            for b in backups_to_restore {
                if fs.metadata(&b.backup_path).await.is_ok() {
                    if fs.metadata(&b.original_path).await.is_ok() {
                        if let Err(e) = fs.remove(&b.original_path).await {
                            return error("remove synced before restore", e);
                        }
                    }
                    if let Err(e) = fs.rename(&b.backup_path, &b.original_path).await {
                        return error("restore backup", e);
                    }
                }
            }
            // 3) prune 로 휴지통 보낸 항목 복원 — best-effort(macOS 로컬은 NotSupported).
            let mut prune_failed = false;
            let mut refresh = std::collections::HashSet::<PathBuf>::new();
            for item in pruned {
                let loc = match dst_source {
                    SourceId::Local => TrashLocation::Local {
                        trash_id: item.trash_path.clone(),
                    },
                    SourceId::Ssh { .. } => TrashLocation::Remote {
                        trash_path: PathBuf::from(&item.trash_path),
                    },
                };
                if fs
                    .restore_from_trash(&loc, &item.original_path)
                    .await
                    .is_err()
                {
                    prune_failed = true;
                }
                if let Some(par) = item.original_path.parent() {
                    refresh.insert(par.to_path_buf());
                }
            }
            for p in created {
                if let Some(par) = p.parent() {
                    refresh.insert(par.to_path_buf());
                }
            }
            UndoOutcome {
                kind: UndoKind::Ok,
                message: if prune_failed {
                    Some("일부 삭제 항목은 휴지통에서 수동 복원 필요 (macOS).".into())
                } else {
                    None
                },
                refreshed_locations: refresh
                    .into_iter()
                    .map(|p| Location {
                        source: dst_source.clone(),
                        path: p,
                    })
                    .collect(),
            }
        }
        UndoAction::UndoCompareApply {
            left_source,
            right_source,
            left_created,
            right_created,
            left_backups,
            right_backups,
        } => {
            let mut refresh = std::collections::HashSet::<(SourceId, PathBuf)>::new();
            for (source, created, backups) in [
                (left_source, left_created, left_backups),
                (right_source, right_created, right_backups),
            ] {
                let fs = match fs_for(source, pool).await {
                    Ok(f) => f,
                    Err(e) => return error("source unreachable", e),
                };
                // 1) 새로 생성분 제거.
                for p in created {
                    if fs.metadata(p).await.is_ok() {
                        if let Err(e) = fs.remove(p).await {
                            return error("remove created", e);
                        }
                    }
                    if let Some(par) = p.parent() {
                        refresh.insert((source.clone(), par.to_path_buf()));
                    }
                }
                // 2) 덮어쓴 백업 복원 — remove-then-rename(SFTP rename-over-existing 회피).
                for b in backups {
                    if fs.metadata(&b.backup_path).await.is_ok() {
                        if fs.metadata(&b.original_path).await.is_ok() {
                            if let Err(e) = fs.remove(&b.original_path).await {
                                return error("remove applied before restore", e);
                            }
                        }
                        if let Err(e) = fs.rename(&b.backup_path, &b.original_path).await {
                            return error("restore backup", e);
                        }
                    }
                    if let Some(par) = b.original_path.parent() {
                        refresh.insert((source.clone(), par.to_path_buf()));
                    }
                }
            }
            UndoOutcome {
                kind: UndoKind::Ok,
                message: None,
                refreshed_locations: refresh
                    .into_iter()
                    .map(|(s, p)| Location { source: s, path: p })
                    .collect(),
            }
        }
        UndoAction::UndoThreeWayApply {
            left_source,
            right_source,
            left_created,
            right_created,
            left_backups,
            right_backups,
            trashed_left,
            trashed_right,
        } => {
            let mut refresh = std::collections::HashSet::<(SourceId, PathBuf)>::new();
            let mut trash_failed = false;
            for (source, created, backups, trashed) in [
                (left_source, left_created, left_backups, trashed_left),
                (right_source, right_created, right_backups, trashed_right),
            ] {
                let fs = match fs_for(source, pool).await {
                    Ok(f) => f,
                    Err(e) => return error("source unreachable", e),
                };
                // 1) 생성분 제거.
                for p in created {
                    if fs.metadata(p).await.is_ok() {
                        if let Err(e) = fs.remove(p).await {
                            return error("remove created", e);
                        }
                    }
                    if let Some(par) = p.parent() {
                        refresh.insert((source.clone(), par.to_path_buf()));
                    }
                }
                // 2) 덮어쓴 백업 복원 — remove-then-rename.
                for b in backups {
                    if fs.metadata(&b.backup_path).await.is_ok() {
                        if fs.metadata(&b.original_path).await.is_ok() {
                            if let Err(e) = fs.remove(&b.original_path).await {
                                return error("remove applied before restore", e);
                            }
                        }
                        if let Err(e) = fs.rename(&b.backup_path, &b.original_path).await {
                            return error("restore backup", e);
                        }
                    }
                    if let Some(par) = b.original_path.parent() {
                        refresh.insert((source.clone(), par.to_path_buf()));
                    }
                }
                // 3) 삭제(휴지통)분 복원 — best-effort(macOS 로컬은 NotSupported).
                for item in trashed {
                    let loc = match source {
                        SourceId::Local => TrashLocation::Local {
                            trash_id: item.trash_path.clone(),
                        },
                        SourceId::Ssh { .. } => TrashLocation::Remote {
                            trash_path: PathBuf::from(&item.trash_path),
                        },
                    };
                    if fs
                        .restore_from_trash(&loc, &item.original_path)
                        .await
                        .is_err()
                    {
                        trash_failed = true;
                    }
                    if let Some(par) = item.original_path.parent() {
                        refresh.insert((source.clone(), par.to_path_buf()));
                    }
                }
            }
            UndoOutcome {
                kind: UndoKind::Ok,
                message: if trash_failed {
                    Some("일부 삭제 항목은 휴지통에서 수동 복원 필요 (macOS).".into())
                } else {
                    None
                },
                refreshed_locations: refresh
                    .into_iter()
                    .map(|(s, p)| Location { source: s, path: p })
                    .collect(),
            }
        }
    }
}

fn error(prefix: &str, e: DuetError) -> UndoOutcome {
    UndoOutcome {
        kind: UndoKind::Error,
        message: Some(format!("{prefix}: {e}")),
        refreshed_locations: vec![],
    }
}

fn ok_with_locs(source: &SourceId, refresh: std::collections::HashSet<PathBuf>) -> UndoOutcome {
    UndoOutcome {
        kind: UndoKind::Ok,
        message: None,
        refreshed_locations: refresh
            .into_iter()
            .map(|p| Location {
                source: source.clone(),
                path: p,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::journal::{JournalEntry, JournalId, OpKind};
    use chrono::Utc;
    use tempfile::TempDir;

    fn mk_entry(undo: UndoAction) -> JournalEntry {
        JournalEntry {
            id: JournalId::new(),
            timestamp: Utc::now(),
            op: OpKind::Mkdir {
                path: PathBuf::from("/tmp"),
                source: SourceId::Local,
            },
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
            source: SourceId::Local,
            path: target.clone(),
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
            source: SourceId::Local,
            path: target.clone(),
        });
        let outcome = execute_undo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Skipped));
        assert!(target.exists());
    }
}
