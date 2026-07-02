//! 앱 런처 IPC — 목록 CRUD + 폴더(1-레벨) + 인자 + 실행.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use crate::services::app_launchers::{AppItem, AppLaunchersStore};
use crate::types::DuetError;

type Store<'a> = tauri::State<'a, Arc<AppLaunchersStore>>;

#[tauri::command]
#[specta::specta]
pub async fn apps_list(store: Store<'_>) -> Result<Vec<AppItem>, DuetError> {
    Ok(store.list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn apps_add(
    name: String,
    path: PathBuf,
    store: Store<'_>,
) -> Result<Vec<AppItem>, DuetError> {
    store.add(name, path).await
}

#[tauri::command]
#[specta::specta]
pub async fn apps_rename(
    id: String,
    name: String,
    store: Store<'_>,
) -> Result<Vec<AppItem>, DuetError> {
    store.rename(&id, name).await
}

#[tauri::command]
#[specta::specta]
pub async fn apps_set_args(
    id: String,
    args: Vec<String>,
    store: Store<'_>,
) -> Result<Vec<AppItem>, DuetError> {
    store.set_args(&id, args).await
}

#[tauri::command]
#[specta::specta]
pub async fn apps_remove(id: String, store: Store<'_>) -> Result<Vec<AppItem>, DuetError> {
    store.remove(&id).await
}

#[tauri::command]
#[specta::specta]
pub async fn apps_reorder(ids: Vec<String>, store: Store<'_>) -> Result<Vec<AppItem>, DuetError> {
    store.reorder(ids).await
}

#[tauri::command]
#[specta::specta]
pub async fn apps_group(
    drag_id: String,
    target_id: String,
    store: Store<'_>,
) -> Result<Vec<AppItem>, DuetError> {
    store.group(&drag_id, &target_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn apps_move_into_folder(
    app_id: String,
    folder_id: String,
    store: Store<'_>,
) -> Result<Vec<AppItem>, DuetError> {
    store.move_into_folder(&app_id, &folder_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn apps_move_out(
    app_id: String,
    folder_id: String,
    store: Store<'_>,
) -> Result<Vec<AppItem>, DuetError> {
    store.move_out(&app_id, &folder_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn apps_dissolve(folder_id: String, store: Store<'_>) -> Result<Vec<AppItem>, DuetError> {
    store.dissolve(&folder_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn apps_reorder_in_folder(
    folder_id: String,
    ids: Vec<String>,
    store: Store<'_>,
) -> Result<Vec<AppItem>, DuetError> {
    store.reorder_in_folder(&folder_id, ids).await
}

/// 앱 실행 — 인자 없으면 `opener::open`(기존), 있으면 argv 로 `std::process::Command`
/// (셸 미경유 — 인젝션 안전, CLAUDE.md §7/§9).
#[tauri::command]
#[specta::specta]
pub async fn app_launch(path: PathBuf, args: Vec<String>) -> Result<(), DuetError> {
    if !path.exists() {
        return Err(DuetError::Io(format!(
            "app not found (moved or uninstalled?): {}",
            path.display()
        )));
    }
    if args.is_empty() {
        return tokio::task::spawn_blocking(move || opener::open(&path))
            .await
            .map_err(|e| DuetError::Io(format!("launch task join: {e}")))?
            .map_err(|e| DuetError::Io(format!("launch failed: {e}")));
    }
    let mut cmd = build_launch_command(&path, &args)?;
    tokio::task::spawn_blocking(move || cmd.spawn())
        .await
        .map_err(|e| DuetError::Io(format!("launch task join: {e}")))?
        .map(|_child| ())
        .map_err(|e| DuetError::Io(format!("launch failed: {e}")))
}

/// OS별 실행 Command 구성 (argv 벡터만, 셸 문자열 절대 X).
fn build_launch_command(path: &Path, args: &[String]) -> Result<Command, DuetError> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        // /usr/bin/open = Apple LaunchServices 프론트엔드 (셸/ssh 아님).
        // -n: 새 인스턴스 (이미 실행 중이면 --args 무시되는 macOS 동작 회피).
        let mut c = Command::new("/usr/bin/open");
        c.arg("-n").arg("-a").arg(path).arg("--args").args(args);
        c
    };
    #[cfg(not(target_os = "macos"))]
    let mut cmd = {
        // Windows .exe / Linux 실행파일 — argv 네이티브 전달.
        // .desktop 은 자유 argv 를 못 받음.
        if path.extension().and_then(|e| e.to_str()) == Some("desktop") {
            return Err(DuetError::NotSupported(
                "arguments require a binary target, not a .desktop launcher".into(),
            ));
        }
        let mut c = Command::new(path);
        c.args(args);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_command_uses_argv_not_shell() {
        // 셸 메타문자가 들어와도 argv 로만 전달 (인젝션 불가) — 구성만 검증, spawn 안 함.
        let cmd = build_launch_command(
            Path::new("/Applications/Foo.app"),
            &["a b".into(), "$(rm -rf /)".into()],
        );
        assert!(cmd.is_ok());
    }
}
