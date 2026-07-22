//! 시스템 정보 + 외부 열기 commands.

use crate::fs::{FileSystem, LocalFs, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::services::settings::SettingsStore;
use crate::types::{
    ConnectionId, DuetError, EntryKind, EntryRef, Location, SourceId, TrashLocation,
};
use serde::Serialize;
use specta::Type;
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
    let home = dirs::home_dir().ok_or_else(|| DuetError::Io("home directory not found".into()))?;
    // Windows 에서 드라이브 없는 홈(`\Users\x`)이 오면 절대경로로 보정 (§7). 정상이면 no-op.
    Ok(crate::platform::local_abs(home))
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
///
/// **POSIX 문자열 기준** — `Path::components()`/`PathBuf::push` 는 Windows 클라이언트에서
/// `\` 를 섞어(원격 경로 깨짐) "Put back" 이 실패하던 버그(§7). `/` 로만 분해·결합한다.
fn derive_original_from_trash(full: &Path) -> Option<PathBuf> {
    let s = full.to_string_lossy();
    let segs: Vec<&str> = s.split('/').filter(|seg| !seg.is_empty()).collect();
    // `.duet-trash` 다음 세그먼트가 batch, 그 뒤부터가 원본 경로(루트 기준).
    let idx = segs.iter().position(|&seg| seg == ".duet-trash")?;
    let rest = segs.get(idx + 2..)?;
    if rest.is_empty() {
        return None;
    }
    let mut out = PathBuf::from("/");
    for seg in rest {
        out = crate::fs::posix_join(&out, seg);
    }
    Some(out)
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
    // 원격 경로는 POSIX 결합 (Windows 클라이언트에서 PathBuf::join 의 `\` 회피).
    let full = crate::fs::posix_join(&item.location.path, &item.name);
    let original = derive_original_from_trash(&full)
        .ok_or_else(|| DuetError::Io("not inside .duet-trash".into()))?;
    let conn = pool.inner().get(connection_id).await?;
    let fs = SshFs::new(conn);
    fs.restore_from_trash(&TrashLocation::Remote { trash_path: full }, &original)
        .await?;
    // 부모 Location (갱신용) — POSIX 로 마지막 `/` 앞까지. Path::parent 의 OS 의존 회피.
    let orig_s = original.to_string_lossy();
    let parent = match orig_s.rsplit_once('/') {
        Some(("", _)) | None => PathBuf::from("/"),
        Some((p, _)) => PathBuf::from(p),
    };
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

#[cfg(test)]
mod resolve_path_tests {
    use super::resolve_open_path;

    #[test]
    fn dir_resolves_to_itself() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        assert_eq!(resolve_open_path(p).as_deref(), Some(p));
    }

    #[test]
    fn file_resolves_to_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.txt");
        std::fs::write(&file, b"hi").unwrap();
        assert_eq!(
            resolve_open_path(file.to_str().unwrap()).as_deref(),
            dir.path().to_str()
        );
    }

    #[test]
    fn nonexistent_resolves_to_none() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope-does-not-exist");
        assert_eq!(resolve_open_path(missing.to_str().unwrap()), None);
    }
}

/// 파일을 연다 — 확장자별 연결 프로그램이 지정돼 있으면 그 앱으로, 아니면 OS 기본.
///
/// 로컬: 경로를 그대로. 원격(SSH): SFTP 로 임시 디렉토리에 다운로드한 뒤 그 사본을 연다
/// — 일반 파일 매니저 관례 (읽기 전용 열람. 편집 후 재업로드는 미지원, 향후 watch 로 확장).
#[tauri::command]
#[specta::specta]
pub async fn open_path(
    location: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
) -> Result<(), DuetError> {
    let target = match &location.source {
        // 간헐적 드라이브(C:) 누락 방어 — 이미 절대면 no-op (§ shell_menu 와 동일).
        SourceId::Local => crate::platform::local_abs(location.path.clone()),
        SourceId::Ssh { .. } => download_to_temp(&location, pool.inner()).await?,
    };
    // 확장자별 연결 프로그램 override (소문자 확장자, 점 없음). 없으면 OS 기본.
    let app_overrides = settings.get().await.ext_app_overrides;
    let app_override = target
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .and_then(|ext| app_overrides.get(&ext).cloned());
    // 작업 디렉토리를 파일의 부모로 설정해 연다(탐색기 동작 — .bat/스크립트가 제 폴더에서
    // 실행). OS 런처는 blocking 이라 spawn_blocking.
    tokio::task::spawn_blocking(move || match app_override {
        Some(app) => crate::platform::open_with(std::path::Path::new(&app), &target),
        None => crate::platform::open_default(&target),
    })
    .await
    .map_err(|e| DuetError::Io(format!("open task join: {e}")))?
}

/// 원격 파일을 로컬 temp 로 받아 OS 기본 에디터로 열고, temp 변경을 감지해 원격으로
/// 자동 재업로드(편집 라운드트립). 로컬 파일은 `open_path` 와 동일하게 그냥 열면 되므로
/// 이 command 는 원격(SSH) 전용. 재업로드 watch 는 연결 종료 시 자동 종료된다.
#[tauri::command]
#[specta::specta]
pub async fn ssh_edit_open(
    location: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<(), DuetError> {
    let SourceId::Ssh { connection_id, .. } = &location.source else {
        return Err(DuetError::NotSupported(
            "edit roundtrip is only for remote files".into(),
        ));
    };
    let fs = fs_for(&location.source, pool.inner()).await?;
    let meta = fs.metadata(&location.path).await?;
    if meta.kind != EntryKind::File {
        return Err(DuetError::Io("can only edit regular files".into()));
    }
    let name = location
        .path
        .file_name()
        .ok_or_else(|| DuetError::Io("remote path has no file name".into()))?;
    let temp = crate::services::edit_session::edit_temp_path(connection_id, name);
    if let Some(parent) = temp.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| DuetError::Io(format!("create edit temp dir: {e}")))?;
    }
    let bytes = fs.read_full(&location.path).await?;
    tokio::fs::write(&temp, &bytes)
        .await
        .map_err(|e| DuetError::Io(format!("write edit temp: {e}")))?;
    let to_open = temp.clone();
    tokio::task::spawn_blocking(move || opener::open(&to_open))
        .await
        .map_err(|e| DuetError::Io(format!("open task join: {e}")))?
        .map_err(|e| DuetError::Io(format!("open failed: {e}")))?;
    crate::services::edit_session::spawn_edit_watch(
        pool.inner().clone(),
        connection_id.clone(),
        location.path.clone(),
        temp,
    );
    Ok(())
}

/// 파일/폴더를 OS 파일 매니저에서 보여준다 (선택 강조). 로컬 전용.
#[tauri::command]
#[specta::specta]
pub async fn reveal_path(location: Location) -> Result<(), DuetError> {
    match location.source {
        SourceId::Local => {
            let path = crate::platform::local_abs(location.path);
            tokio::task::spawn_blocking(move || opener::reveal(&path))
                .await
                .map_err(|e| DuetError::Io(format!("reveal task join: {e}")))?
                .map_err(|e| DuetError::Io(format!("reveal failed: {e}")))
        }
        SourceId::Ssh { .. } => Err(DuetError::Io(
            "reveal is not supported for remote files".into(),
        )),
    }
}

/// Windows 시스템 휴지통(재활용 통)을 탐색기로 연다.
///
/// Windows Recycle Bin 은 셸 가상폴더(`$I`/`$R` 쌍)라 패널로 직접 탐색·복원이
/// 불가하다(`trash_location` 이 `NotSupported`). 대신 탐색기로 띄워 사용자가
/// 시스템 휴지통을 바로 보고 복원할 수 있게 한다. 삭제 자체는 이미 OS 휴지통으로
/// 이동하며, 최근 삭제는 duet 의 Ctrl+Z(undo)로도 복원된다.
#[tauri::command]
#[specta::specta]
pub async fn open_recycle_bin() -> Result<(), DuetError> {
    #[cfg(target_os = "windows")]
    {
        // `shell:RecycleBinFolder` = Recycle Bin 셸 네임스페이스. opener 가
        // `start ""` 로 띄운다 (CLAUDE.md §9 는 SSH 클라이언트만 제한 — 로컬 런처는 허용).
        tokio::task::spawn_blocking(|| opener::open("shell:RecycleBinFolder"))
            .await
            .map_err(|e| DuetError::Io(format!("open task join: {e}")))?
            .map_err(|e| DuetError::Io(format!("open recycle bin failed: {e}")))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(DuetError::NotSupported(
            "recycle bin opener is Windows-only".into(),
        ))
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

/// 사이드바 "Places" 항목 (이름 + 경로).
#[derive(Debug, Clone, Serialize, Type)]
pub struct Place {
    pub label: String,
    pub path: PathBuf,
}

/// 표준 로컬 위치 — Home/Desktop/Documents/Downloads/Pictures/Movies (존재하는 것만).
/// 경로 해석은 backend `dirs` 로 (CLAUDE.md §7).
#[tauri::command]
#[specta::specta]
pub async fn places() -> Result<Vec<Place>, DuetError> {
    let mut out = Vec::new();
    let candidates: [(&str, Option<PathBuf>); 6] = [
        ("Home", dirs::home_dir()),
        ("Desktop", dirs::desktop_dir()),
        ("Documents", dirs::document_dir()),
        ("Downloads", dirs::download_dir()),
        ("Pictures", dirs::picture_dir()),
        ("Movies", dirs::video_dir()),
    ];
    for (label, p) in candidates {
        if let Some(p) = p {
            if p.is_dir() {
                out.push(Place {
                    label: label.into(),
                    // 홈과 동일하게 드라이브 없는 로컬 경로 보정 (Windows). 정상이면 no-op.
                    path: crate::platform::local_abs(p),
                });
            }
        }
    }
    Ok(out)
}

/// 마운트된 볼륨/드라이브 1건.
#[derive(Debug, Clone, Serialize, Type)]
pub struct Volume {
    pub name: String,
    pub path: PathBuf,
    /// 이 볼륨을 eject(언마운트)할 수 있는지. 부트/시스템 볼륨은 false.
    /// 현재 eject 는 macOS 만 지원하므로 그 외 플랫폼은 항상 false.
    pub ejectable: bool,
}

#[cfg(target_os = "macos")]
fn list_volumes() -> Vec<Volume> {
    use std::os::unix::fs::MetadataExt;
    // 부트(루트) 볼륨의 device id — `/Volumes` 의 boot 볼륨(Macintosh HD)을 eject
    // 대상에서 제외하기 위해 비교. 외장/디스크이미지/네트워크 마운트는 device 가 달라
    // ejectable=true 가 된다.
    let root_dev = std::fs::metadata("/").ok().map(|m| m.dev());
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir("/Volumes") {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                let dev = std::fs::metadata(&path).ok().map(|m| m.dev());
                let ejectable = matches!((dev, root_dev), (Some(d), Some(r)) if d != r);
                out.push(Volume {
                    name: e.file_name().to_string_lossy().into_owned(),
                    path,
                    ejectable,
                });
            }
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn list_volumes() -> Vec<Volume> {
    // /media/<user>/*, /run/media/<user>/*, /mnt/* 의 마운트들 (best-effort).
    let mut out = Vec::new();
    for base in ["/media", "/run/media"] {
        if let Ok(rd) = std::fs::read_dir(base) {
            for user in rd.flatten() {
                if let Ok(inner) = std::fs::read_dir(user.path()) {
                    for e in inner.flatten() {
                        if e.path().is_dir() {
                            // /media, /run/media 는 udisks 가 이동식 미디어를 자동
                            // 마운트하는 위치 → ejectable.
                            out.push(Volume {
                                name: e.file_name().to_string_lossy().into_owned(),
                                path: e.path(),
                                ejectable: true,
                            });
                        }
                    }
                }
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir("/mnt") {
        for e in rd.flatten() {
            if e.path().is_dir() {
                // /mnt 는 보통 수동/fstab 고정 마운트 → eject 대상 아님.
                out.push(Volume {
                    name: e.file_name().to_string_lossy().into_owned(),
                    path: e.path(),
                    ejectable: false,
                });
            }
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn list_volumes() -> Vec<Volume> {
    // 드라이브 문자 A:..Z: 중 실제 마운트된 것 (탐색기처럼). Win32 API/unsafe 없이
    // 존재 확인만 — 새 의존성 회피. 미디어 없는 광학 드라이브·미연결 네트워크
    // 드라이브는 metadata 실패로 자연스레 skip.
    // Windows 가 설치된 시스템 드라이브(보통 C:)는 eject 대상에서 제외.
    let system_drive = std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".to_string())
        .to_ascii_uppercase();
    let mut out = Vec::new();
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        let path = PathBuf::from(&root);
        if std::fs::metadata(&path).is_ok() {
            let name = format!("{}:", letter as char);
            let ejectable = name.to_ascii_uppercase() != system_drive;
            out.push(Volume {
                name,
                path,
                ejectable,
            });
        }
    }
    out
}

/// 마운트된 볼륨 목록 (읽기 전용). eject 는 `eject_volume`.
#[tauri::command]
#[specta::specta]
pub async fn volumes() -> Result<Vec<Volume>, DuetError> {
    tokio::task::spawn_blocking(list_volumes)
        .await
        .map_err(|e| DuetError::Io(format!("volumes task join: {e}")))
}

/// 원격 호스트의 표준 Places — home + 존재하는 표준 폴더 (순수 SFTP stat).
///
/// `places()`(로컬)의 원격판. 헤드리스 서버엔 표준 폴더가 없는 경우가 많아
/// `metadata` 로 실제 존재하는 dir 만 포함한다. exec 없이 SFTP 만 사용(§9 무관).
#[tauri::command]
#[specta::specta]
pub async fn ssh_places(
    connection_id: ConnectionId,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<Vec<Place>, DuetError> {
    let conn = pool.inner().get(&connection_id).await?;
    let fs = SshFs::new(conn);
    let home = fs.home().await?;
    let mut out = vec![Place {
        label: "Home".into(),
        path: home.clone(),
    }];
    for label in ["Desktop", "Documents", "Downloads", "Pictures", "Movies"] {
        let p = home.join(label);
        if let Ok(meta) = fs.metadata(&p).await {
            if meta.kind == EntryKind::Dir {
                out.push(Place {
                    label: label.into(),
                    path: p,
                });
            }
        }
    }
    Ok(out)
}

/// 원격 호스트의 마운트 볼륨 — `/Volumes`(mac)·`/mnt`·`/media`·`/media/<user>`
/// 의 디렉토리 엔트리 (순수 SFTP list). 없는 root 는 skip → OS 판별 불필요.
#[tauri::command]
#[specta::specta]
pub async fn ssh_volumes(
    connection_id: ConnectionId,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<Vec<Volume>, DuetError> {
    let conn = pool.inner().get(&connection_id).await?;
    let fs = SshFs::new(conn);
    let user = match fs.source_id() {
        SourceId::Ssh { user, .. } => user,
        SourceId::Local => String::new(),
    };
    let mut roots = vec![
        PathBuf::from("/Volumes"),
        PathBuf::from("/mnt"),
        PathBuf::from("/media"),
    ];
    if !user.is_empty() {
        roots.push(Path::new("/media").join(&user));
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        // 없는 root(다른 OS 등)는 SFTP 에러 → 조용히 skip.
        let Ok(entries) = fs.list(&root).await else {
            continue;
        };
        for e in entries {
            // mount point 는 dir, /Volumes 의 부팅 디스크 등은 symlink 일 수 있어 둘 다 허용.
            if e.kind != EntryKind::Dir && e.kind != EntryKind::Symlink {
                continue;
            }
            let path = root.join(&e.name);
            if seen.insert(path.clone()) {
                // 원격 마운트는 우리 eject(로컬 macOS diskutil) 대상이 아님.
                out.push(Volume {
                    name: e.name,
                    path,
                    ejectable: false,
                });
            }
        }
    }
    Ok(out)
}

/// 마운트된 볼륨을 eject (언마운트 + 디바이스 분리). macOS/Windows/Linux 지원.
///
/// 실제 프로세스 spawn(diskutil / PowerShell / udisksctl)은 `platform/` 레이어.
/// 비가역 시스템 op 이므로 `open_path`/`reveal_path` 처럼 journal 안 씀 — 안전장치는
/// frontend 확인 다이얼로그(`ejectable` 볼륨에만 노출).
#[tauri::command]
#[specta::specta]
pub async fn eject_volume(path: PathBuf) -> Result<(), DuetError> {
    if path.as_os_str().is_empty() {
        return Err(DuetError::Io("eject: empty path".into()));
    }
    tokio::task::spawn_blocking(move || crate::platform::eject_volume(&path))
        .await
        .map_err(|e| DuetError::Io(format!("eject task join: {e}")))?
}

/// 우클릭 "여기서 터미널 열기" — 로컬 폴더에서 OS 터미널 실행. 원격(SSH)은 미지원.
#[tauri::command]
#[specta::specta]
pub async fn open_terminal(location: Location) -> Result<(), DuetError> {
    match location.source {
        SourceId::Local => {
            let dir = crate::platform::local_abs(location.path);
            if dir.as_os_str().is_empty() {
                return Err(DuetError::Io("open terminal: empty path".into()));
            }
            tokio::task::spawn_blocking(move || crate::platform::open_terminal(&dir))
                .await
                .map_err(|e| DuetError::Io(format!("open terminal task join: {e}")))?
        }
        SourceId::Ssh { .. } => Err(DuetError::NotSupported(
            "open terminal is local-only (remote SSH terminal not supported yet)".into(),
        )),
    }
}

/// 파일의 OS 네이티브 아이콘 → PNG 바이트 (없거나 미지원 OS 면 Err).
/// 파일 목록(확장자/경로별 캐시)과 앱 런처 타일 공용. 프론트는 1회 호출·캐시하고
/// 실패 시 글리프/모노그램 fallback. OS API(GDI) 블로킹이라 `spawn_blocking` 격리.
#[tauri::command]
#[specta::specta]
pub async fn file_icon(path: PathBuf, size: i32) -> Result<Vec<u8>, DuetError> {
    tokio::task::spawn_blocking(move || crate::platform::os_file_icon(&path, size))
        .await
        .map_err(|e| DuetError::Io(format!("icon task join: {e}")))?
}

// ── 셸 컨텍스트 메뉴(IContextMenu) — Explorer/TC 와 동일 ──────────

/// 우클릭 대상의 실제 셸 메뉴를 핫 COM 워커로 빌드해 항목 트리 반환(token 으로 보관). Windows 전용.
#[tauri::command]
#[specta::specta]
pub async fn shell_menu_open(
    app: tauri::AppHandle,
    path: PathBuf,
    scope: crate::platform::ShellScope,
    registry: tauri::State<'_, std::sync::Arc<crate::platform::ShellMenuRegistry>>,
) -> Result<crate::platform::ShellMenu, DuetError> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let hwnd = app
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize)
            .unwrap_or(0);
        // FE 가 간헐적으로 드라이브(C:) 없는 경로를 보내면 셸(IContextMenu)이 항목을 못
        // 잡아 빈 메뉴("(none)")가 된다 — COM 직전에 절대경로화(local_abs: 이미 절대면 no-op).
        let path = crate::platform::local_abs(path);
        // 캐시 있으면 즉시, 없으면 빌드. token 은 워커가 발급/재사용(invoke 대상).
        let (token, items) = registry.worker().open(hwnd, path, scope).await;
        Ok(crate::platform::ShellMenu { token, items })
    }
    #[cfg(not(windows))]
    {
        let _ = (app, path, scope);
        let _ = registry;
        Ok(crate::platform::ShellMenu {
            token: 0,
            items: Vec::new(),
        })
    }
}

/// 셸 메뉴 백그라운드 예열 — 커서가 파일/폴더에 멈추거나 폴더가 바뀔 때 호출. 그 경로의
/// 메뉴를 미리 빌드해 캐시에 채운다(fire-and-forget). 우클릭 시 캐시에서 즉시 서빙되어
/// QueryContextMenu(제3자 셸 확장, cold 수 초)를 임계경로에서 치운다. Windows 전용.
#[tauri::command]
#[specta::specta]
pub async fn shell_menu_warm(
    app: tauri::AppHandle,
    path: PathBuf,
    scope: crate::platform::ShellScope,
    registry: tauri::State<'_, std::sync::Arc<crate::platform::ShellMenuRegistry>>,
) -> Result<(), DuetError> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let hwnd = app
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize)
            .unwrap_or(0);
        let path = crate::platform::local_abs(path);
        registry.worker().warm(hwnd, path, scope);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, path, scope, registry);
    }
    Ok(())
}

/// 셸 메뉴에서 선택한 항목 실행(핫 워커가 캐시 중인 IContextMenu 로 InvokeCommand).
#[tauri::command]
#[specta::specta]
pub async fn shell_menu_invoke(
    token: u64,
    cmd_id: u32,
    registry: tauri::State<'_, std::sync::Arc<crate::platform::ShellMenuRegistry>>,
) -> Result<(), DuetError> {
    #[cfg(windows)]
    registry.worker().invoke(token, cmd_id);
    #[cfg(not(windows))]
    {
        let _ = (token, cmd_id, registry);
    }
    Ok(())
}

/// 탐색기 폴더/드라이브 우클릭 "Open in duet" 등록 여부 (Windows; 그 외 false).
#[tauri::command]
#[specta::specta]
pub async fn open_in_duet_get() -> Result<bool, DuetError> {
    tokio::task::spawn_blocking(crate::platform::open_in_duet_status)
        .await
        .map_err(|e| DuetError::Io(format!("registry task join: {e}")))?
}

/// "Open in duet" 우클릭 등록/해제. current_exe() 경로로 등록(HKCU, 가역). 새 상태 반환.
#[tauri::command]
#[specta::specta]
pub async fn open_in_duet_set(enabled: bool) -> Result<bool, DuetError> {
    tokio::task::spawn_blocking(move || {
        if enabled {
            let exe =
                std::env::current_exe().map_err(|e| DuetError::Io(format!("current_exe: {e}")))?;
            crate::platform::open_in_duet_register(&exe)?;
        } else {
            crate::platform::open_in_duet_unregister()?;
        }
        crate::platform::open_in_duet_status()
    })
    .await
    .map_err(|e| DuetError::Io(format!("registry task join: {e}")))?
}

/// argv 로 받은 경로를 "열 디렉토리"로 정규화 — 디렉토리면 그대로, 파일이면 부모,
/// 존재하지 않으면 None. cold start(`startup_open_path`)와 single-instance forward
/// (`lib.rs` 의 플러그인 콜백)가 공유한다.
pub(crate) fn resolve_open_path(arg: &str) -> Option<String> {
    let p = PathBuf::from(arg);
    let meta = std::fs::metadata(&p).ok()?;
    if meta.is_dir() {
        Some(arg.to_string())
    } else {
        p.parent().and_then(|x| x.to_str()).map(str::to_owned)
    }
}

/// 실행 인자(argv[1])로 받은 폴더 경로 — 탐색기 "Open in duet" / 기본 핸들러 → 시작 시
/// 그 폴더 열기. 디렉토리면 그 경로, 파일이면 부모, 아니면 None. (어느 OS 든 무해)
#[tauri::command]
#[specta::specta]
pub async fn startup_open_path() -> Result<Option<String>, DuetError> {
    let Some(arg) = std::env::args().nth(1) else {
        return Ok(None);
    };
    Ok(resolve_open_path(&arg))
}

/// 폴더/드라이브 더블클릭 기본 동작이 duet 으로 설정돼 있는지 (Windows; 그 외 false).
#[tauri::command]
#[specta::specta]
pub async fn default_folder_handler_get() -> Result<bool, DuetError> {
    tokio::task::spawn_blocking(crate::platform::default_folder_handler_status)
        .await
        .map_err(|e| DuetError::Io(format!("registry task join: {e}")))?
}

/// 폴더 더블클릭 기본 동작을 duet 으로 설정/해제. 켜면 "Open in duet" verb 도 함께
/// 등록한다(기본 동작이 가리킬 대상). current_exe() 경로 사용·HKCU·가역. 새 상태 반환.
#[tauri::command]
#[specta::specta]
pub async fn default_folder_handler_set(enabled: bool) -> Result<bool, DuetError> {
    tokio::task::spawn_blocking(move || {
        if enabled {
            let exe =
                std::env::current_exe().map_err(|e| DuetError::Io(format!("current_exe: {e}")))?;
            crate::platform::set_default_folder_handler(true, &exe)?;
        } else {
            // 끌 때 exe 는 안 쓰임 — 빈 경로.
            crate::platform::set_default_folder_handler(false, &PathBuf::new())?;
        }
        crate::platform::default_folder_handler_status()
    })
    .await
    .map_err(|e| DuetError::Io(format!("registry task join: {e}")))?
}

/// 로컬 항목들의 절대경로 — OS 드래그-아웃(파일 export)용. 경로 결합은 `Path`(§7).
/// SSH 항목은 로컬 경로가 없어 `NotSupported` (원격 드래그-아웃은 후속 — 임시 다운로드 필요).
#[tauri::command]
#[specta::specta]
pub async fn local_abs_paths(items: Vec<EntryRef>) -> Result<Vec<PathBuf>, DuetError> {
    let mut out = Vec::with_capacity(items.len());
    for it in &items {
        if !matches!(it.location.source, SourceId::Local) {
            return Err(DuetError::NotSupported(
                "drag-out supports local files only".into(),
            ));
        }
        out.push(it.location.path.join(&it.name));
    }
    Ok(out)
}
