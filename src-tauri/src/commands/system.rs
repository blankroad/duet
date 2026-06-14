//! 시스템 정보 + 외부 열기 commands.

use crate::fs::{FileSystem, LocalFs, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::types::{ConnectionId, DuetError, EntryKind, EntryRef, Location, SourceId, TrashLocation};
use std::path::{Path, PathBuf};
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

/// 로컬 OS 휴지통 디렉토리 (탐색용). OS별 cfg 분기.
#[cfg(target_os = "macos")]
fn local_trash_dir() -> Result<PathBuf, DuetError> {
    let home = dirs::home_dir().ok_or_else(|| DuetError::Io("home directory not found".into()))?;
    Ok(home.join(".Trash"))
}
#[cfg(target_os = "linux")]
fn local_trash_dir() -> Result<PathBuf, DuetError> {
    // XDG: $XDG_DATA_HOME 또는 ~/.local/share, 그 아래 Trash/files.
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("share")))
        .ok_or_else(|| DuetError::Io("data directory not found".into()))?;
    Ok(base.join("Trash").join("files"))
}
#[cfg(target_os = "windows")]
fn local_trash_dir() -> Result<PathBuf, DuetError> {
    // Recycle Bin 은 셸 네임스페이스($I/$R) — 탐색 가능한 경로가 아님.
    Err(DuetError::NotSupported(
        "trash browsing is not available on Windows".into(),
    ))
}

/// 휴지통 위치를 `Location` 으로 — 패널이 그대로 탐색(삭제 항목 보기/복구).
///
/// 로컬: OS 휴지통 (mac `~/.Trash`, linux XDG). 원격: `<home>/.duet-trash`
/// (없으면 생성). Windows 로컬은 `NotSupported` — 프론트가 안내 메시지.
/// 경로 구성은 모두 backend (CLAUDE.md §7).
#[tauri::command]
#[specta::specta]
pub async fn trash_location(
    source: SourceId,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<Location, DuetError> {
    match &source {
        SourceId::Local => {
            let path = local_trash_dir()?;
            // 읽기 가능 여부 선확인 — macOS ~/.Trash 는 TCC 보호라 명확히 안내.
            match tokio::fs::read_dir(&path).await {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    return Err(DuetError::Io(
                        "Full Disk Access required to browse Trash on macOS \
                         (System Settings → Privacy & Security → Full Disk Access). \
                         Recent deletes can be undone with Ctrl+Z."
                            .into(),
                    ));
                }
                // 아직 휴지통 폴더가 없으면(삭제 이력 없음) 빈 폴더로 생성해 탐색 가능하게.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    let _ = tokio::fs::create_dir_all(&path).await;
                }
                Err(_) => {} // 그 외는 navigate 가 처리
            }
            Ok(Location { source, path })
        }
        SourceId::Ssh { connection_id, .. } => {
            let conn = pool.inner().get(connection_id).await?;
            let fs = SshFs::new(conn);
            let home = fs.home().await?;
            let base = crate::services::trash::remote_trash_base(&home);
            // 첫 사용 시 빈 폴더로 탐색 가능하도록 없으면 생성.
            if fs.metadata(&base).await.is_err() {
                fs.mkdir(&base).await?;
            }
            Ok(Location { source, path: base })
        }
    }
}

/// 원격 `.duet-trash` 경로에서 원본 절대경로 도출.
/// `<home>/.duet-trash/<batch>/etc/foo/bar` → `/etc/foo/bar`. 마커 없으면 None.
fn derive_original_from_trash(full: &Path) -> Option<PathBuf> {
    use std::path::Component;
    let mut comps = full.components();
    // ".duet-trash" 까지 소비
    let mut found = false;
    for c in comps.by_ref() {
        if matches!(c, Component::Normal(s) if s == ".duet-trash") {
            found = true;
            break;
        }
    }
    if !found {
        return None;
    }
    comps.next()?; // batch 디렉토리 소비
    let mut out = PathBuf::from("/");
    let mut any = false;
    for c in comps {
        if let Component::Normal(s) = c {
            out.push(s);
            any = true;
        }
    }
    any.then_some(out)
}

/// 휴지통 항목을 원래 위치로 복원 ("Put back") — 원격 `.duet-trash` 전용.
///
/// 경로에 인코딩된 원본 위치로 SFTP `mv` (부모 생성 + 대상존재 가드는
/// `restore_from_trash` 재사용). 로컬 OS 휴지통은 원본 경로 도출이 불가하여
/// `NotSupported` — 복사/이동으로 복구하면 됨. 복원된 원본의 부모 Location 반환(갱신용).
#[tauri::command]
#[specta::specta]
pub async fn trash_restore(
    item: EntryRef,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<Location, DuetError> {
    let SourceId::Ssh { connection_id, .. } = &item.location.source else {
        return Err(DuetError::NotSupported(
            "auto put-back is for remote (.duet-trash) only — use copy/move to recover local items"
                .into(),
        ));
    };
    let full = item.location.path.join(&item.name);
    let original = derive_original_from_trash(&full)
        .ok_or_else(|| DuetError::Io("not inside .duet-trash".into()))?;
    let conn = pool.inner().get(connection_id).await?;
    let fs = SshFs::new(conn);
    fs.restore_from_trash(&TrashLocation::Remote { trash_path: full }, &original)
        .await?;
    let parent = original
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(original);
    Ok(Location {
        source: item.location.source,
        path: parent,
    })
}

#[cfg(test)]
mod trash_tests {
    use super::{derive_original_from_trash, local_trash_dir};
    use std::path::{Path, PathBuf};

    #[test]
    fn derive_original_strips_base_and_batch() {
        let full = Path::new("/home/u/.duet-trash/20260614-abc/etc/foo/bar.txt");
        assert_eq!(
            derive_original_from_trash(full),
            Some(PathBuf::from("/etc/foo/bar.txt"))
        );
    }

    #[test]
    fn derive_original_none_without_marker() {
        assert_eq!(derive_original_from_trash(Path::new("/home/u/x/y")), None);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_trash_is_home_dot_trash() {
        let p = local_trash_dir().unwrap();
        assert_eq!(p.file_name().unwrap(), ".Trash");
        assert!(p.is_absolute());
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn linux_trash_ends_with_trash_files() {
        let p = local_trash_dir().unwrap();
        assert!(p.ends_with("Trash/files"), "got {p:?}");
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn windows_trash_is_unsupported() {
        assert!(local_trash_dir().is_err());
    }
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
