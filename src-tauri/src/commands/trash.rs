//! OS 휴지통 가상 뷰 commands — Windows Recycle Bin(셸 네임스페이스) / XDG Trash 를
//! 패널에서 보고 **제자리 복원 / 영구 삭제 / 비우기**.
//!
//! Recycle Bin 은 `$I/$R` 쌍의 셸 가상폴더라 경로로 탐색할 수 없지만, `trash` crate 의
//! `os_limited`(탐색기가 쓰는 것과 같은 셸 API) 로 **일반 사용자 권한**으로 목록·원본
//! 경로·복원·영구삭제가 모두 된다. 그래서 항목은 경로가 아니라 `id` 로 다루고, 패널은
//! `VIRTUAL_TRASH_PATH` 라는 가상 location 에 머문다 (프론트 `lib/trashView.ts` 와 동일 상수).
//!
//! 영구 삭제(purge)는 되돌릴 수 없으므로 CLAUDE.md §3 의 확인 단어를 요구하고 journal 에
//! `PermanentDelete`(Irreversible) 로 남긴다.

use std::path::PathBuf;
use std::sync::Arc;

use crate::core::ops::PERMANENT_DELETE_CONFIRM_WORD;
use crate::fs::LocalFs;
use crate::services::journal::{Journal, OpKind, UndoAction};
use crate::types::{DuetError, Location, SourceId, TrashItemDto};

/// 가상 휴지통 location 의 path. 실제 경로가 아니다 — `list_directory` 등에 넘기면 안 됨.
pub const VIRTUAL_TRASH_PATH: &str = "shell:RecycleBinFolder";

/// 가상 휴지통 `Location` (로컬 전용).
pub fn virtual_trash_location() -> Location {
    Location {
        source: SourceId::Local,
        path: PathBuf::from(VIRTUAL_TRASH_PATH),
    }
}

fn join_err(e: tokio::task::JoinError) -> DuetError {
    DuetError::Io(format!("trash task join: {e}"))
}

fn check_confirm_word(word: &str) -> Result<(), DuetError> {
    if word != PERMANENT_DELETE_CONFIRM_WORD {
        return Err(DuetError::Io(
            "permanent delete: confirmation word mismatch".into(),
        ));
    }
    Ok(())
}

/// 영구 삭제 결과를 journal 에 남긴다 (undo 불가 — 기록/히스토리 표시용).
async fn record_purge(journal: &Journal, app: &tauri::AppHandle, count: u32) {
    if count == 0 {
        return;
    }
    let op = OpKind::PermanentDelete {
        count,
        location: virtual_trash_location(),
    };
    if let Ok(entry) = journal.push(op, UndoAction::Irreversible).await {
        crate::commands::fs_ops::emit_pushed(app, entry);
    }
}

/// OS 휴지통 항목 목록 (Windows / Linux). macOS 는 `NotSupported`.
#[tauri::command]
#[specta::specta]
pub async fn trash_list() -> Result<Vec<TrashItemDto>, DuetError> {
    tokio::task::spawn_blocking(LocalFs::trash_view_list)
        .await
        .map_err(join_err)?
}

/// 휴지통 항목을 원래 위치로 복원. 복원된 항목들의 **부모 폴더** location 을 반환 —
/// 프론트가 그 폴더를 보고 있는 패널을 새로고침한다.
#[tauri::command]
#[specta::specta]
pub async fn trash_put_back(ids: Vec<String>) -> Result<Vec<Location>, DuetError> {
    let parents = tokio::task::spawn_blocking(move || LocalFs::trash_view_put_back(&ids))
        .await
        .map_err(join_err)??;
    let mut out: Vec<Location> = Vec::new();
    for p in parents {
        if !out.iter().any(|l| l.path == p) {
            out.push(Location {
                source: SourceId::Local,
                path: p,
            });
        }
    }
    Ok(out)
}

/// 휴지통 항목 영구 삭제 — 확인 단어 필수(§3). 지운 개수 반환.
#[tauri::command]
#[specta::specta]
pub async fn trash_purge(
    ids: Vec<String>,
    confirm_word: String,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<u32, DuetError> {
    check_confirm_word(&confirm_word)?;
    let n = tokio::task::spawn_blocking(move || LocalFs::trash_view_purge(&ids))
        .await
        .map_err(join_err)??;
    record_purge(journal.inner(), &app, n).await;
    Ok(n)
}

/// 휴지통 비우기 — 확인 단어 필수(§3). 지운 개수 반환.
#[tauri::command]
#[specta::specta]
pub async fn trash_empty(
    confirm_word: String,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<u32, DuetError> {
    check_confirm_word(&confirm_word)?;
    let n = tokio::task::spawn_blocking(LocalFs::trash_view_purge_all)
        .await
        .map_err(join_err)??;
    record_purge(journal.inner(), &app, n).await;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirm_word_must_match_exactly() {
        assert!(check_confirm_word("delete").is_ok());
        assert!(check_confirm_word("Delete").is_err());
        assert!(check_confirm_word("").is_err());
    }

    #[test]
    fn virtual_location_is_local_sentinel() {
        let l = virtual_trash_location();
        assert!(matches!(l.source, SourceId::Local));
        assert_eq!(l.path.to_string_lossy(), VIRTUAL_TRASH_PATH);
    }
}
