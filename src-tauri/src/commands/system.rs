//! 시스템 정보 + 외부 열기 commands.

use crate::fs::{FileSystem, LocalFs, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::types::{ConnectionId, DuetError, EntryKind, Location, SourceId};
use std::path::PathBuf;
use std::sync::Arc;

/// SourceId → FileSystem 동적 디스패치 (원격 다운로드용).
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

/// 사용자 home 디렉토리 절대경로.
///
/// Windows: `C:\Users\<name>`, Mac: `/Users/<name>`, Linux: `/home/<name>`.
/// 부트스트랩 시 양쪽 패널 초기 경로로 사용.
#[tauri::command]
#[specta::specta]
pub async fn home_directory() -> Result<PathBuf, DuetError> {
    dirs::home_dir().ok_or_else(|| DuetError::Io("home directory not found".into()))
}

/// 원격 SSH 호스트의 사용자 home 디렉토리 절대경로 (SFTP canonicalize ".").
///
/// 연결 직후 SSH 패널 시작 위치로 사용 — `/` 는 권한 없는 호스트 흔하므로
/// home 으로 바로 이동.
#[tauri::command]
#[specta::specta]
pub async fn ssh_home_directory(
    connection_id: ConnectionId,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<PathBuf, DuetError> {
    let conn = pool.inner().get(&connection_id).await?;
    let fs = crate::fs::SshFs::new(conn);
    fs.home().await
}

/// 파일을 OS 기본 앱으로 연다.
///
/// 로컬: 경로를 그대로 `opener::open`.
/// 원격(SSH): SFTP 로 임시 디렉토리에 다운로드한 뒤 그 사본을 연다 — 일반 파일
/// 매니저 관례 (읽기 전용 열람. 편집 후 재업로드는 미지원, 향후 watch 로 확장 여지).
#[tauri::command]
#[specta::specta]
pub async fn open_path(
    location: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<(), DuetError> {
    let target = match &location.source {
        SourceId::Local => location.path.clone(),
        SourceId::Ssh { .. } => download_to_temp(&location, pool.inner()).await?,
    };
    // opener::open 은 OS 런처 프로세스를 띄우는 blocking 호출 — 런타임 블록 회피.
    tokio::task::spawn_blocking(move || opener::open(&target))
        .await
        .map_err(|e| DuetError::Io(format!("open task join: {e}")))?
        .map_err(|e| DuetError::Io(format!("open failed: {e}")))
}

/// 파일/폴더를 OS 파일 매니저에서 보여준다 (선택 강조). 로컬 전용.
#[tauri::command]
#[specta::specta]
pub async fn reveal_path(location: Location) -> Result<(), DuetError> {
    match location.source {
        SourceId::Local => {
            let path = location.path;
            tokio::task::spawn_blocking(move || opener::reveal(&path))
                .await
                .map_err(|e| DuetError::Io(format!("reveal task join: {e}")))?
                .map_err(|e| DuetError::Io(format!("reveal failed: {e}")))
        }
        SourceId::Ssh { .. } => {
            Err(DuetError::Io("reveal is not supported for remote files".into()))
        }
    }
}

/// 원격 파일을 임시 디렉토리(`<temp>/duet-opened/`)로 다운로드 후 그 경로 반환.
async fn download_to_temp(
    location: &Location,
    pool: &Arc<ConnectionPool>,
) -> Result<PathBuf, DuetError> {
    let fs = fs_for(&location.source, pool).await?;
    let meta = fs.metadata(&location.path).await?;
    if meta.kind != EntryKind::File {
        return Err(DuetError::Io("can only open regular files".into()));
    }
    let name = location
        .path
        .file_name()
        .ok_or_else(|| DuetError::Io("remote path has no file name".into()))?;
    let dir = std::env::temp_dir().join("duet-opened");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| DuetError::Io(format!("create temp dir: {e}")))?;
    let dst = dir.join(name);
    let bytes = fs.read_full(&location.path).await?;
    tokio::fs::write(&dst, &bytes)
        .await
        .map_err(|e| DuetError::Io(format!("write temp file: {e}")))?;
    Ok(dst)
}
