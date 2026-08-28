//! 로컬 파일시스템 구현.

use crate::fs::FileSystem;
use crate::types::{DuetError, Entry, EntryKind, SourceId};
use async_trait::async_trait;
use std::path::Path;

/// 로컬 파일시스템 접근 구현체.
pub struct LocalFs;

impl LocalFs {
    /// 새 `LocalFs` 인스턴스를 생성한다.
    pub fn new() -> Self {
        Self
    }
}

impl Default for LocalFs {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl FileSystem for LocalFs {
    fn source_id(&self) -> SourceId {
        SourceId::Local
    }

    async fn metadata(&self, path: &Path) -> Result<crate::types::EntryMeta, DuetError> {
        let m = tokio::fs::symlink_metadata(path)
            .await
            .map_err(DuetError::from)?;
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
        Ok(crate::types::EntryMeta {
            kind,
            size,
            modified_ms,
            permissions,
        })
    }

    async fn rename(&self, from: &Path, to: &Path) -> Result<(), DuetError> {
        tokio::fs::rename(from, to).await.map_err(DuetError::from)
    }

    async fn mkdir(&self, path: &Path) -> Result<(), DuetError> {
        // create_dir (not _all) — 부모 없으면 에러, 이미 있으면 에러
        tokio::fs::create_dir(path).await.map_err(DuetError::from)
    }

    async fn trash(
        &self,
        path: &Path,
        batch_id: &str,
    ) -> Result<crate::types::TrashLocation, DuetError> {
        // 단일 삭제도 배치 경로를 그대로 탄다(구현 하나만 유지).
        let (mut done, err) = self.trash_many(&[path.to_path_buf()], batch_id).await;
        match done.pop() {
            Some((_, loc)) => Ok(loc),
            None => Err(err.unwrap_or_else(|| DuetError::Io("trash failed".into()))),
        }
    }

    /// 배치 삭제 — OS 휴지통 API 를 **한 번** 호출하고, 실제로 사라졌는지는 항목별
    /// lstat 로 확인한다.
    ///
    /// 이전 구현은 항목마다 휴지통 **전체 목록**을 삭제 전·후로 열거해 native id 를
    /// 잡았다(항목당 2회). Windows 의 휴지통 열거는 항목당 COM 호출 여러 번이라
    /// "N개 삭제 = O(N × 휴지통크기)" 가 되어 삭제가 눈에 띄게 굼떴다. id 는 이제
    /// 기록하지 않고(빈 문자열), 되돌릴 때 원본 경로로 찾는다 — 열거는 undo 시 1회뿐.
    async fn trash_many(
        &self,
        paths: &[std::path::PathBuf],
        _batch_id: &str,
    ) -> (
        Vec<(std::path::PathBuf, crate::types::TrashLocation)>,
        Option<DuetError>,
    ) {
        let owned: Vec<std::path::PathBuf> = paths.to_vec();
        match tokio::task::spawn_blocking(move || trash_many_blocking(owned)).await {
            Ok(r) => r,
            Err(e) => (
                Vec::new(),
                Some(DuetError::Io(format!("spawn_blocking: {e}"))),
            ),
        }
    }

    /// 배치 복원 — 휴지통 목록 조회 1회로 여러 항목을 되돌린다(항목당 1회이던 것).
    async fn restore_many(
        &self,
        items: &[(crate::types::TrashLocation, std::path::PathBuf)],
    ) -> Result<(), DuetError> {
        let owned: Vec<(String, std::path::PathBuf)> = items
            .iter()
            .map(|(loc, original)| {
                let id = match loc {
                    crate::types::TrashLocation::Local { trash_id } => trash_id.clone(),
                    // 로컬 fs 에 원격 위치가 올 일은 없지만, 있으면 id 없이 경로로 찾는다.
                    crate::types::TrashLocation::Remote { .. } => String::new(),
                };
                (id, original.clone())
            })
            .collect();
        tokio::task::spawn_blocking(move || trash_restore_many(&owned))
            .await
            .map_err(|e| DuetError::Io(format!("spawn_blocking: {e}")))?
    }

    async fn restore_from_trash(
        &self,
        location: &crate::types::TrashLocation,
        original_path: &Path,
    ) -> Result<(), DuetError> {
        let crate::types::TrashLocation::Local { trash_id } = location else {
            return Err(DuetError::Io(
                "restore_from_trash on local fs given non-local location".into(),
            ));
        };
        let items = vec![(
            crate::types::TrashLocation::Local {
                trash_id: trash_id.clone(),
            },
            original_path.to_path_buf(),
        )];
        self.restore_many(&items).await
    }

    async fn remove(&self, path: &Path) -> Result<(), DuetError> {
        let m = tokio::fs::symlink_metadata(path)
            .await
            .map_err(DuetError::from)?;
        if m.is_dir() {
            tokio::fs::remove_dir_all(path)
                .await
                .map_err(DuetError::from)
        } else {
            tokio::fs::remove_file(path).await.map_err(DuetError::from)
        }
    }

    /// POSIX 권한 변경 — unix 전용. 재귀는 lstat walk(심볼릭 링크는 자신·대상 모두
    /// 건드리지 않음 — chmod 는 링크를 따라가 *대상*이 바뀌므로).
    async fn set_mode(&self, path: &Path, mode: u32, recursive: bool) -> Result<(), DuetError> {
        #[cfg(unix)]
        {
            set_mode_unix(path, mode, recursive, true).await
        }
        #[cfg(not(unix))]
        {
            let _ = (path, mode, recursive);
            Err(DuetError::NotSupported(
                "POSIX permissions are not available on this OS".into(),
            ))
        }
    }

    /// 심볼릭 링크 생성 — unix 전용 (Windows 는 관리자/개발자모드 필요라 v1 미지원).
    async fn make_symlink(&self, link: &Path, target: &str) -> Result<(), DuetError> {
        #[cfg(unix)]
        {
            tokio::fs::symlink(target, link)
                .await
                .map_err(DuetError::from)
        }
        #[cfg(not(unix))]
        {
            let _ = (link, target);
            Err(DuetError::NotSupported(
                "symlink creation requires elevated rights on Windows".into(),
            ))
        }
    }
    async fn read_full(&self, path: &Path) -> Result<Vec<u8>, DuetError> {
        tokio::fs::read(path).await.map_err(DuetError::from)
    }

    async fn read_head(&self, path: &Path, max: usize) -> Result<(Vec<u8>, bool), DuetError> {
        let mut file = tokio::fs::File::open(path).await.map_err(DuetError::from)?;
        let mut buf = vec![0u8; max.saturating_add(1)];
        let n = crate::fs::read_upto(&mut file, &mut buf)
            .await
            .map_err(DuetError::from)?;
        let truncated = n > max;
        buf.truncate(n.min(max));
        Ok((buf, truncated))
    }

    async fn read_range(&self, path: &Path, offset: u64, len: usize) -> Result<Vec<u8>, DuetError> {
        use tokio::io::AsyncSeekExt;
        let mut file = tokio::fs::File::open(path).await.map_err(DuetError::from)?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(DuetError::from)?;
        let mut buf = vec![0u8; len];
        let n = crate::fs::read_upto(&mut file, &mut buf)
            .await
            .map_err(DuetError::from)?;
        buf.truncate(n);
        Ok(buf)
    }

    async fn write_full(&self, path: &Path, bytes: &[u8]) -> Result<(), DuetError> {
        tokio::fs::write(path, bytes).await.map_err(DuetError::from)
    }

    async fn open_read(
        &self,
        path: &Path,
        offset: u64,
    ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
        let mut file = tokio::fs::File::open(path).await.map_err(DuetError::from)?;
        if offset > 0 {
            use tokio::io::AsyncSeekExt;
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(DuetError::from)?;
        }
        Ok(Box::pin(file))
    }

    async fn open_write(
        &self,
        path: &Path,
        offset: u64,
    ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
        if offset == 0 {
            // create + truncate (write_full 과 동일 의미).
            let file = tokio::fs::File::create(path)
                .await
                .map_err(DuetError::from)?;
            return Ok(Box::pin(file));
        }
        // 재개: 기존 파일을 열어 offset 위치부터 이어쓰기.
        use tokio::io::AsyncSeekExt;
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .await
            .map_err(DuetError::from)?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(DuetError::from)?;
        Ok(Box::pin(file))
    }

    /// 디렉토리 목록 — 전체를 **blocking 태스크 하나**에서 동기 walk 한다.
    ///
    /// 이전 구현은 항목마다 `tokio::fs::symlink_metadata(entry.path())` 를 불렀다.
    /// 그건 (1) readdir 이 이미 넘겨준 정보를 버리고 파일을 다시 열어 stat 하고,
    /// (2) tokio::fs 특성상 항목마다 blocking 풀을 왕복한다 — 5,000개 폴더면 스레드
    /// 왕복 5,000회 + 파일 오픈 5,000회. Windows 에서 목록·새로고침이 굼뜬 주원인이었다.
    ///
    /// `DirEntry::metadata()` 는 심볼릭 링크를 따라가지 않고(= lstat 의미 동일),
    /// Windows 에선 FindFirstFileW 가 채워준 캐시라 **추가 syscall 이 없다**.
    async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError> {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || list_blocking(&path))
            .await
            .map_err(|e| DuetError::Io(format!("spawn_blocking: {e}")))?
    }

    /// 총 바이트 크기 — 기본 재귀(`list` + `metadata`) 대신 blocking 동기 walk.
    ///
    /// 기본 구현은 항목마다 `list()`(symlink_metadata) 과 `dir_size()`(metadata) 로
    /// **파일당 stat 2회** + 파일당 boxed future 를 쓴다. 대용량 트리에서는 이게
    /// 복사/이동 확인 다이얼로그가 뜨기까지의 지연 대부분을 차지해서, `std::fs`
    /// 동기 walk (파일당 stat 1회) 로 대체한다.
    ///
    /// 판정 기준은 기본 구현과 **동일**하다 (총량이 달라지면 진행률 분모가 바뀜):
    /// - lstat 기준 — 심볼릭 링크는 0 으로 세고 따라 들어가지 않는다(순환 방지).
    /// - 링크·소켓·디바이스 등 파일 아닌 항목은 0.
    /// - stat 실패한 개별 항목은 건너뛴다 (`list()` 의 `continue` 와 동일).
    /// - 비-UTF8 이름은 건너뛴다 — `list()` 가 건너뛰어 복사 대상에서도 빠지므로
    ///   여기서 세면 진행률 분모만 과대해진다.
    async fn dir_size(&self, path: &Path) -> Result<u64, DuetError> {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || dir_size_blocking(&path))
            .await
            .map_err(|e| DuetError::Io(format!("spawn_blocking: {e}")))?
    }
}

/// `LocalFs::list` 본체 (sync — spawn_blocking 안에서 호출).
///
/// 판정 규칙은 이전 async 구현과 동일: 비-UTF8 이름 스킵, stat 실패 항목 스킵,
/// 심볼릭 링크는 target 을 따라가 종류/크기/시각을 정하되 깨진 링크는 Symlink 로 남긴다.
fn list_blocking(path: &Path) -> Result<Vec<Entry>, DuetError> {
    let read_dir = std::fs::read_dir(path).map_err(DuetError::from)?;
    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(DuetError::from)?;
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue, // 비-UTF8 이름은 스킵
        };
        // lstat(링크 추적 X) — 심볼릭 링크는 깨졌어도 항상 목록에 보이게(Dolphin 처럼).
        let lmeta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // 정말 접근 불가한 항목만 스킵
        };
        let mut kind = classify(&lmeta);
        let mut size = size_of(&lmeta);
        let mut modified_ms = mtime_of(&lmeta);
        let mut permissions = perms_of(&lmeta);
        let hidden = name.starts_with('.') || is_os_hidden(&lmeta);
        // 심볼릭 링크는 target 을 따라가 종류 결정(폴더 링크 → Dir → 진입 가능).
        // 깨진 링크(target stat 실패)는 그대로 Symlink 로 둔다.
        if matches!(kind, EntryKind::Symlink) {
            if let Ok(t) = std::fs::metadata(entry.path()) {
                kind = classify(&t);
                size = size_of(&t);
                modified_ms = mtime_of(&t);
                permissions = perms_of(&t);
            }
        }
        entries.push(Entry {
            name,
            kind,
            size,
            modified_ms,
            permissions,
            hidden,
        });
    }
    Ok(entries)
}

/// std Metadata → EntryKind (lstat/stat 어느 쪽이든 같은 규칙).
fn classify(m: &std::fs::Metadata) -> EntryKind {
    if m.is_dir() {
        EntryKind::Dir
    } else if m.is_file() {
        EntryKind::File
    } else if m.file_type().is_symlink() {
        EntryKind::Symlink
    } else {
        EntryKind::Other
    }
}

/// 크기 — 디렉토리/링크는 None(목록에서 크기 칸 비움).
fn size_of(m: &std::fs::Metadata) -> Option<u64> {
    if m.is_file() {
        Some(m.len())
    } else {
        None
    }
}

/// 수정 시각(epoch ms) — 지원 안 하는 플랫폼/파일은 None.
fn mtime_of(m: &std::fs::Metadata) -> Option<i64> {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// POSIX 권한 비트 — Windows 는 None.
fn perms_of(m: &std::fs::Metadata) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Some(m.permissions().mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        let _ = m;
        None
    }
}

/// `LocalFs::dir_size` 본체 (sync — spawn_blocking 안에서 호출).
///
/// 재귀 호출 대신 명시적 스택 — 깊은 트리에서 스택 오버플로를 피한다.
/// `DirEntry::file_type()` 은 readdir 이 이미 넘겨준 정보를 쓰는 플랫폼이 많아
/// 대개 추가 syscall 이 없고, 링크를 따라가지 않는다.
fn dir_size_blocking(path: &Path) -> Result<u64, DuetError> {
    let meta = std::fs::symlink_metadata(path).map_err(DuetError::from)?;
    if !meta.is_dir() {
        // 파일이면 그 크기, 링크/기타는 0 — 기본 구현과 동일.
        return Ok(if meta.is_file() { meta.len() } else { 0 });
    }
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        // 디렉토리 자체를 못 읽으면 에러 — 기본 구현(`list()?`)과 동일하게 전파.
        for entry in std::fs::read_dir(&dir).map_err(DuetError::from)? {
            let entry = entry.map_err(DuetError::from)?;
            if entry.file_name().to_str().is_none() {
                continue; // 비-UTF8 이름 — list() 와 동일하게 제외
            }
            let Ok(ft) = entry.file_type() else {
                continue; // 개별 항목 stat 실패 — list() 와 동일하게 건너뜀
            };
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                total = total.saturating_add(entry.metadata().map(|m| m.len()).unwrap_or(0));
            }
            // 심볼릭 링크·기타는 0 (따라가지 않는다).
        }
    }
    Ok(total)
}

#[cfg(windows)]
fn is_os_hidden(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    (meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN) != 0
}

#[cfg(not(windows))]
fn is_os_hidden(_meta: &std::fs::Metadata) -> bool {
    false
}

// === Trash helpers (sync — spawn_blocking 안에서 호출) ===

/// 배치 삭제 본체 — OS 휴지통 API 를 **한 번** 호출하고, 성패는 파일시스템 상태로 판정.
///
/// 반환: (실제로 사라진 항목, 첫 실패). 휴지통 native id 는 **기록하지 않는다**(빈 문자열).
/// 예전엔 id 를 잡으려고 항목마다 휴지통 전체를 삭제 전·후로 열거했는데, Windows 에선
/// 그 열거가 항목당 COM 호출 여러 번이라 "N개 삭제 = O(N × 휴지통 크기)" 였다.
/// 되돌릴 땐 원본 경로로 찾으면 되므로(→ `pick_trash_item`) 열거는 undo 때 1회면 충분하다.
fn trash_many_blocking(
    paths: Vec<std::path::PathBuf>,
) -> (
    Vec<(std::path::PathBuf, crate::types::TrashLocation)>,
    Option<DuetError>,
) {
    let batch_err = trash::delete_all(&paths)
        .err()
        .map(|e| DuetError::Io(format!("trash delete: {e}")));
    let mut done = Vec::with_capacity(paths.len());
    let mut left: Option<std::path::PathBuf> = None;
    for p in paths {
        // 사라졌으면 휴지통으로 갔다는 뜻 — 부분 성공도 여기서 정확히 잡힌다.
        if std::fs::symlink_metadata(&p).is_err() {
            done.push((
                p,
                crate::types::TrashLocation::Local {
                    trash_id: String::new(),
                },
            ));
        } else if left.is_none() {
            left = Some(p);
        }
    }
    let err = match (batch_err, left) {
        (Some(e), _) => Some(e),
        // API 는 성공을 보고했는데 남아 있는 항목 — 조용히 넘기지 않는다.
        (None, Some(p)) => Some(DuetError::Io(format!(
            "not moved to trash: {}",
            p.display()
        ))),
        (None, None) => None,
    };
    (done, err)
}

/// 두 경로가 "같은 대상"인지 — 정확히 같으면 즉시 true, 아니면 표기 차이(구분자/대소문자)
/// 를 흡수해 비교. 휴지통 매칭 보강용(엄격 동등은 Windows 에서 자주 빗나감).
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn paths_eq(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").to_lowercase();
    norm(a) == norm(b)
}

/// 휴지통 목록에서 되돌릴 항목 고르기.
/// ① `trash_id` 가 있으면(구버전 journal 기록) 그 id, ② 없으면 원본 경로가 같은 것 중
/// **가장 최근에 지워진** 것. `used` 는 한 배치에서 이미 고른 id — 같은 경로를 두 번
/// 지웠다 되돌릴 때 같은 항목을 두 번 집지 않게 한다.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn pick_trash_item<'a>(
    listed: &'a [trash::TrashItem],
    trash_id: &str,
    original: &Path,
    used: &std::collections::HashSet<std::ffi::OsString>,
) -> Option<&'a trash::TrashItem> {
    if !trash_id.is_empty() {
        return listed
            .iter()
            .find(|i| i.id.to_string_lossy() == trash_id && !used.contains(&i.id));
    }
    listed
        .iter()
        .filter(|i| !used.contains(&i.id) && paths_eq(&i.original_path(), original))
        .max_by_key(|i| i.time_deleted)
}

/// 배치 복원 — 휴지통 목록을 **1회** 조회해 전부 매칭한 뒤 한 번에 restore.
#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
fn trash_restore_many(items: &[(String, std::path::PathBuf)]) -> Result<(), DuetError> {
    use trash::os_limited;
    if items.is_empty() {
        return Ok(());
    }
    for (_, original) in items {
        if original.exists() {
            return Err(DuetError::Io(format!(
                "restore target exists: {}",
                original.display()
            )));
        }
    }
    let listed = os_limited::list().map_err(|e| DuetError::Io(format!("trash list: {e}")))?;
    let mut used: std::collections::HashSet<std::ffi::OsString> = std::collections::HashSet::new();
    let mut picked = Vec::with_capacity(items.len());
    for (id, original) in items {
        let item = pick_trash_item(&listed, id, original, &used).ok_or_else(|| {
            DuetError::Io(format!("trash item not found: {}", original.display()))
        })?;
        used.insert(item.id.clone());
        picked.push(item.clone());
    }
    os_limited::restore_all(picked).map_err(|e| DuetError::Io(format!("restore: {e:?}")))
}

/// macOS 는 trash crate 가 `os_limited`(목록/복원)를 제공하지 않는다 — 명시 거부.
/// 사용자는 Finder 에서 "되돌리기" 로 복원.
#[cfg(target_os = "macos")]
fn trash_restore_many(_items: &[(String, std::path::PathBuf)]) -> Result<(), DuetError> {
    Err(DuetError::NotSupported(
        "trash undo on macOS — restore manually via Finder".into(),
    ))
}

/// mode 적용(unix). `top`=최초 호출 — 명시 대상이 심볼릭 링크면 거부(chmod 는 링크를
/// 따라가 대상 권한을 바꿔 의도 밖 변경). 재귀 중 만나는 링크는 조용히 스킵.
#[cfg(unix)]
async fn set_mode_unix(
    path: &Path,
    mode: u32,
    recursive: bool,
    top: bool,
) -> Result<(), DuetError> {
    use std::os::unix::fs::PermissionsExt;
    let lmeta = tokio::fs::symlink_metadata(path)
        .await
        .map_err(DuetError::from)?;
    if lmeta.file_type().is_symlink() {
        if top {
            return Err(DuetError::NotSupported(
                "chmod on a symlink is not supported (it would change the target)".into(),
            ));
        }
        return Ok(());
    }
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .await
        .map_err(DuetError::from)?;
    if recursive && lmeta.is_dir() {
        let mut rd = tokio::fs::read_dir(path).await.map_err(DuetError::from)?;
        while let Some(ent) = rd.next_entry().await.map_err(DuetError::from)? {
            Box::pin(set_mode_unix(&ent.path(), mode, recursive, false)).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use tokio::fs;

    /// 체크섬 — 알려진 벡터("abc")와 일치 + 청크 경계(256KB 초과)에서도 정확.
    #[tokio::test]
    async fn checksum_known_vector_and_chunked() {
        use crate::types::ChecksumAlgo;
        let dir = TempDir::new().unwrap();
        let small = dir.path().join("abc.txt");
        fs::write(&small, b"abc").await.unwrap();
        let local = LocalFs::new();
        // NIST 표준 벡터.
        assert_eq!(
            local.checksum(&small, ChecksumAlgo::Sha256).await.unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            local
                .checksum(&small, ChecksumAlgo::Sha512)
                .await
                .unwrap()
                .len(),
            128
        );
        // 스트리밍 경로 검증 — 버퍼(256KB)보다 큰 파일을 sha2 직접 계산과 대조.
        let big = dir.path().join("big.bin");
        let data: Vec<u8> = (0..600_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(&big, &data).await.unwrap();
        use sha2::Digest;
        let expect = hex::encode(sha2::Sha256::digest(&data));
        assert_eq!(
            local.checksum(&big, ChecksumAlgo::Sha256).await.unwrap(),
            expect
        );
    }

    /// chmod — 비재귀는 대상만, 재귀는 자식 적용 + 심볼릭 링크(및 그 대상) 불변,
    /// 링크를 직접 대상으로 주면 거부.
    #[cfg(unix)]
    #[tokio::test]
    async fn set_mode_recursive_skips_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("d")).await.unwrap();
        fs::write(root.join("d/f"), b"x").await.unwrap();
        fs::write(root.join("outside"), b"x").await.unwrap();
        std::os::unix::fs::symlink(root.join("outside"), root.join("d/link")).unwrap();
        let mode_of = |p: std::path::PathBuf| async move {
            fs::metadata(p).await.unwrap().permissions().mode() & 0o777
        };
        let local = LocalFs::new();

        // 비재귀 — 폴더 자체만 바뀌고 자식은 그대로.
        let child_before = mode_of(root.join("d/f")).await;
        local.set_mode(&root.join("d"), 0o700, false).await.unwrap();
        assert_eq!(mode_of(root.join("d")).await, 0o700);
        assert_eq!(mode_of(root.join("d/f")).await, child_before);

        // 재귀 — 자식 적용, 링크 대상(outside)은 불변.
        let outside_before = mode_of(root.join("outside")).await;
        local.set_mode(&root.join("d"), 0o755, true).await.unwrap();
        assert_eq!(mode_of(root.join("d/f")).await, 0o755);
        assert_eq!(mode_of(root.join("outside")).await, outside_before);

        // 링크를 직접 대상으로 → 거부 (대상 권한이 바뀌는 사고 방지).
        assert!(local
            .set_mode(&root.join("d/link"), 0o777, false)
            .await
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn make_symlink_creates_relative_link() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("t.txt"), b"x").await.unwrap();
        let local = LocalFs::new();
        local
            .make_symlink(&dir.path().join("l"), "t.txt")
            .await
            .unwrap();
        let m = fs::symlink_metadata(dir.path().join("l")).await.unwrap();
        assert!(m.file_type().is_symlink());
        assert_eq!(fs::read(dir.path().join("l")).await.unwrap(), b"x");
    }

    /// 심볼릭 링크: 폴더 링크는 Dir(진입 가능), 깨진 링크도 목록에 보임(Symlink).
    #[cfg(unix)]
    #[tokio::test]
    async fn list_follows_symlink_to_dir_and_keeps_broken() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("real_dir")).await.unwrap();
        fs::write(root.join("real_file"), b"x").await.unwrap();
        symlink(root.join("real_dir"), root.join("link_to_dir")).unwrap();
        symlink(root.join("real_file"), root.join("link_to_file")).unwrap();
        symlink(root.join("does_not_exist"), root.join("broken_link")).unwrap();

        let local = LocalFs::new();
        let entries = local.list(root).await.unwrap();
        let by = |n: &str| entries.iter().find(|e| e.name == n).cloned();

        // 폴더 링크 → Dir (진입 가능하게 — Dolphin 처럼 폴더로).
        assert_eq!(by("link_to_dir").unwrap().kind, EntryKind::Dir);
        // 파일 링크 → File.
        assert_eq!(by("link_to_file").unwrap().kind, EntryKind::File);
        // 깨진 링크 → 목록에 *보이고* Symlink 로 유지(예전엔 skip 돼 안 보였음).
        assert_eq!(by("broken_link").unwrap().kind, EntryKind::Symlink);
    }

    /// copy 는 심볼릭-디렉토리를 따라가 *재귀*하지 않는다 — copy_tree 가 lstat
    /// (symlink_metadata)로 판정. (원격 symlink 무한 사이클/대상 트리 중복 삭제·복사 방지의
    /// 로컬 검증. list 는 진입용으로 Dir 로 보이지만 copy 판정은 lstat.)
    #[cfg(unix)]
    #[tokio::test]
    async fn copy_does_not_recurse_into_symlinked_dir() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let sub = src.join("sub");
        fs::create_dir_all(&sub).await.unwrap();
        fs::write(sub.join("f.txt"), b"hi").await.unwrap();
        symlink(&sub, src.join("link")).unwrap(); // link → sub (디렉토리 링크)
        let dst = dir.path().join("dst");

        let local = LocalFs::new();
        // link 에서 에러가 날 수 있으나(파일 갈래로 가 open_read 실패) 무한루프 없이 종료해야 하고,
        let _ = crate::fs::copy_relay(&local, &src, &local, &dst).await;
        // 무엇보다 link 를 디렉토리로 재귀해 dst/link/f.txt 를 만들면 안 된다.
        assert!(
            !dst.join("link").join("f.txt").exists(),
            "symlink-to-dir must not be recursed/duplicated"
        );
    }

    #[test]
    fn paths_eq_absorbs_separator_and_case() {
        assert!(paths_eq(Path::new("/a/b.txt"), Path::new("/a/b.txt")));
        // Windows 표기 차이(구분자/드라이브문자 대소문자).
        assert!(paths_eq(
            Path::new(r"C:\Users\a\b.txt"),
            Path::new("c:/Users/a/b.txt")
        ));
        assert!(!paths_eq(Path::new("/a/b.txt"), Path::new("/a/c.txt")));
    }

    /// 휴지통 항목 하나 만들기(테스트용) — 원본 경로 + 삭제 시각.
    fn ti(id: &str, original: &str, time_deleted: i64) -> trash::TrashItem {
        let p = std::path::PathBuf::from(original);
        trash::TrashItem {
            id: id.into(),
            name: p.file_name().unwrap().to_os_string(),
            original_parent: p.parent().unwrap().to_path_buf(),
            time_deleted,
        }
    }

    /// 새 기록(빈 id)은 원본 경로로 찾고, 같은 경로가 여럿이면 가장 최근 삭제분.
    #[test]
    fn pick_trash_item_matches_by_path_newest_first() {
        let listed = vec![
            ti("A", "/x/1.txt", 100),
            ti("B", "/a/want.txt", 200),
            ti("C", "/a/want.txt", 300),
        ];
        let used = std::collections::HashSet::new();
        let got = pick_trash_item(&listed, "", Path::new("/a/want.txt"), &used);
        assert_eq!(
            got.map(|i| i.id.to_string_lossy().into_owned()),
            Some("C".into())
        );
    }

    /// 구버전 journal 의 native id 는 그대로 존중한다(경로 매칭보다 우선).
    #[test]
    fn pick_trash_item_honors_recorded_id() {
        let listed = vec![ti("A", "/a/want.txt", 100), ti("B", "/a/want.txt", 200)];
        let used = std::collections::HashSet::new();
        let got = pick_trash_item(&listed, "A", Path::new("/a/want.txt"), &used);
        assert_eq!(
            got.map(|i| i.id.to_string_lossy().into_owned()),
            Some("A".into())
        );
    }

    /// Windows 표기차(구분자·드라이브문자 대소문자)를 흡수해 매칭.
    #[test]
    fn pick_trash_item_tolerates_windows_notation() {
        let listed = vec![ti("W", "C:\\Users\\a\\file.txt", 10)];
        let used = std::collections::HashSet::new();
        let got = pick_trash_item(&listed, "", Path::new("c:/Users/a/file.txt"), &used);
        assert_eq!(
            got.map(|i| i.id.to_string_lossy().into_owned()),
            Some("W".into())
        );
    }

    /// 한 배치에서 같은 경로를 두 번 되돌릴 때 같은 항목을 두 번 집지 않는다.
    #[test]
    fn pick_trash_item_skips_already_used() {
        let listed = vec![ti("A", "/a/dup.txt", 100), ti("B", "/a/dup.txt", 200)];
        let mut used = std::collections::HashSet::new();
        let first = pick_trash_item(&listed, "", Path::new("/a/dup.txt"), &used).unwrap();
        assert_eq!(first.id.to_string_lossy(), "B"); // 최근분 먼저
        used.insert(first.id.clone());
        let second = pick_trash_item(&listed, "", Path::new("/a/dup.txt"), &used).unwrap();
        assert_eq!(second.id.to_string_lossy(), "A");
    }

    /// 후보가 없으면 None — 호출자가 "not found" 로 보고한다.
    #[test]
    fn pick_trash_item_none_when_no_match() {
        let listed = vec![ti("A", "/x/1.txt", 100)];
        let used = std::collections::HashSet::new();
        assert!(pick_trash_item(&listed, "", Path::new("/totally/other.txt"), &used).is_none());
    }

    #[tokio::test]
    async fn list_empty_directory_returns_empty() {
        let dir = TempDir::new().unwrap();
        let local = LocalFs::new();
        let entries = local.list(dir.path()).await.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn list_returns_files_and_dirs() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.txt"), b"hello").await.unwrap();
        fs::create_dir(dir.path().join("sub")).await.unwrap();

        let local = LocalFs::new();
        let mut entries = local.list(dir.path()).await.unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "a.txt");
        assert_eq!(entries[0].kind, EntryKind::File);
        assert_eq!(entries[0].size, Some(5));
        assert_eq!(entries[1].name, "sub");
        assert_eq!(entries[1].kind, EntryKind::Dir);
    }

    #[tokio::test]
    async fn list_marks_dotfiles_as_hidden() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(".hidden"), b"").await.unwrap();
        fs::write(dir.path().join("visible.txt"), b"")
            .await
            .unwrap();

        let local = LocalFs::new();
        let entries = local.list(dir.path()).await.unwrap();

        let hidden = entries.iter().find(|e| e.name == ".hidden").unwrap();
        let visible = entries.iter().find(|e| e.name == "visible.txt").unwrap();
        assert!(hidden.hidden);
        assert!(!visible.hidden);
    }

    #[tokio::test]
    async fn list_nonexistent_returns_not_found() {
        let local = LocalFs::new();
        let result = local
            .list(Path::new("/this/path/should/not/exist/duet-test"))
            .await;
        assert!(matches!(result, Err(DuetError::NotFound(_))));
    }

    #[tokio::test]
    async fn rename_renames_file() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.txt"), b"x").await.unwrap();
        let local = LocalFs::new();
        local
            .rename(&dir.path().join("a.txt"), &dir.path().join("b.txt"))
            .await
            .unwrap();
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

    #[tokio::test]
    async fn read_head_truncates_and_flags() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("big"), b"0123456789")
            .await
            .unwrap();
        let local = LocalFs::new();
        // 앞 4바이트만 + 더 있음.
        let (head, truncated) = local.read_head(&dir.path().join("big"), 4).await.unwrap();
        assert_eq!(head, b"0123");
        assert!(truncated);
        // cap 이 전체 이상이면 truncated=false.
        let (full, t2) = local.read_head(&dir.path().join("big"), 100).await.unwrap();
        assert_eq!(full, b"0123456789");
        assert!(!t2);
    }

    #[tokio::test]
    async fn read_range_seeks_and_clamps() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("f"), b"0123456789")
            .await
            .unwrap();
        let local = LocalFs::new();
        let p = dir.path().join("f");
        // 중간 범위.
        assert_eq!(local.read_range(&p, 2, 3).await.unwrap(), b"234");
        // 끝을 넘는 len 은 clamp.
        assert_eq!(local.read_range(&p, 8, 100).await.unwrap(), b"89");
        // offset 이 EOF 이상이면 빈 결과.
        assert_eq!(local.read_range(&p, 50, 10).await.unwrap(), b"");
    }

    #[tokio::test]
    async fn copy_relay_local_to_local_file() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a"), b"hello").await.unwrap();
        let local = LocalFs::new();
        crate::fs::copy_relay(&local, &dir.path().join("a"), &local, &dir.path().join("b"))
            .await
            .unwrap();
        let b = fs::read(dir.path().join("b")).await.unwrap();
        assert_eq!(b, b"hello");
    }

    #[tokio::test]
    async fn copy_relay_local_to_local_dir_recursive() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("src/sub"))
            .await
            .unwrap();
        fs::write(dir.path().join("src/a"), b"A").await.unwrap();
        fs::write(dir.path().join("src/sub/b"), b"B").await.unwrap();
        let local = LocalFs::new();
        crate::fs::copy_relay(
            &local,
            &dir.path().join("src"),
            &local,
            &dir.path().join("dst"),
        )
        .await
        .unwrap();
        assert_eq!(fs::read(dir.path().join("dst/a")).await.unwrap(), b"A");
        assert_eq!(fs::read(dir.path().join("dst/sub/b")).await.unwrap(), b"B");
    }

    /// 다중 chunk 파일(>256KB)을 스트리밍 복사 — chunk 경계 정확성 + 진행률 누적 확인.
    /// 전체를 메모리에 안 올리는 경로가 바이트 단위로 정확한지 검증.
    /// 로컬→로컬 파일 복사는 OS 복사 API 경로 — 내용·수정시각 보존, `.part` 잔여물 없음.
    #[tokio::test]
    async fn local_copy_preserves_mtime_and_leaves_no_part() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("a.bin");
        let dst = dir.path().join("b.bin");
        fs::write(&src, b"hello").await.unwrap();
        // 원본을 "오래된" 파일로 — 복사본이 그 시각을 물려받아야 한다.
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
        std::fs::File::options()
            .write(true)
            .open(&src)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();

        let local = LocalFs::new();
        crate::fs::copy_relay(&local, &src, &local, &dst)
            .await
            .unwrap();

        assert_eq!(fs::read(&dst).await.unwrap(), b"hello");
        assert_eq!(std::fs::metadata(&dst).unwrap().modified().unwrap(), old);
        assert!(
            !dir.path().join("b.bin.duet-part").exists(),
            "임시 .part 는 rename 으로 사라져야 한다"
        );
    }

    /// 청크 스트리밍 경로(원격·대용량이 타는 길)의 경계 정확성 — 로컬 작은 파일은 이제
    /// 네이티브 복사로 빠지므로 스트리밍 본체를 직접 불러 커버한다.
    #[tokio::test]
    async fn stream_copy_file_is_byte_exact_across_chunks() {
        let dir = TempDir::new().unwrap();
        let size = 256 * 1024 * 3 + 777;
        let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let src = dir.path().join("big.bin");
        let dst = dir.path().join("out.bin");
        fs::write(&src, &data).await.unwrap();

        let local = LocalFs::new();
        let counted = std::sync::atomic::AtomicU64::new(0);
        let on_bytes = |d: u64| {
            counted.fetch_add(d, std::sync::atomic::Ordering::Relaxed);
        };
        let cancel = tokio_util::sync::CancellationToken::new();
        crate::fs::stream_copy_file(&local, &src, &local, &dst, false, &cancel, &on_bytes)
            .await
            .unwrap();

        assert_eq!(fs::read(&dst).await.unwrap(), data);
        assert_eq!(
            counted.load(std::sync::atomic::Ordering::Relaxed),
            size as u64
        );
    }

    #[tokio::test]
    async fn copy_relay_streaming_multichunk_exact_and_progress() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let dir = TempDir::new().unwrap();
        // 256KB(RELAY_CHUNK) 경계를 여러 번 넘는 크기 + 비정렬 꼬리.
        let size = 256 * 1024 * 3 + 777;
        let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        fs::write(dir.path().join("big.bin"), &data).await.unwrap();

        let local = LocalFs::new();
        let counted = AtomicU64::new(0);
        let on_bytes = |delta: u64| {
            counted.fetch_add(delta, Ordering::Relaxed);
        };
        let cancel = tokio_util::sync::CancellationToken::new();
        crate::fs::copy_relay_streaming(
            &local,
            &dir.path().join("big.bin"),
            &local,
            &dir.path().join("out.bin"),
            false,
            &cancel,
            &on_bytes,
            &|_| {},
        )
        .await
        .unwrap();

        let out = fs::read(dir.path().join("out.bin")).await.unwrap();
        assert_eq!(out.len(), size);
        assert_eq!(out, data, "byte-exact across chunk boundaries");
        assert_eq!(
            counted.load(Ordering::Relaxed),
            size as u64,
            "progress sums to size"
        );
    }

    /// 이미 취소된 토큰이면 첫 chunk 전에 Cancelled.
    #[tokio::test]
    async fn copy_relay_streaming_honors_cancel() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a"), vec![0u8; 512 * 1024])
            .await
            .unwrap();
        let local = LocalFs::new();
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();
        let r = crate::fs::copy_relay_streaming(
            &local,
            &dir.path().join("a"),
            &local,
            &dir.path().join("b"),
            false,
            &cancel,
            &|_| {},
            &|_| {},
        )
        .await;
        assert!(matches!(r, Err(DuetError::Cancelled)));
    }

    /// 재개(resume): 절반 쓴 .part 가 있으면 그 지점부터 이어받아 byte-exact 완성.
    #[tokio::test]
    async fn copy_relay_streaming_resumes_from_part() {
        let dir = TempDir::new().unwrap();
        let size = 256 * 1024 + 500;
        let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        fs::write(dir.path().join("src.bin"), &data).await.unwrap();
        // 중단 상태 모사 — out.bin.duet-part 에 앞부분 절반만 기록.
        let half = size / 2;
        fs::write(dir.path().join("out.bin.duet-part"), &data[..half])
            .await
            .unwrap();

        let local = LocalFs::new();
        let cancel = tokio_util::sync::CancellationToken::new();
        crate::fs::copy_relay_streaming(
            &local,
            &dir.path().join("src.bin"),
            &local,
            &dir.path().join("out.bin"),
            true, // 재개
            &cancel,
            &|_| {},
            &|_| {},
        )
        .await
        .unwrap();

        let out = fs::read(dir.path().join("out.bin")).await.unwrap();
        assert_eq!(out, data, "resumed copy is byte-exact");
        // .part 는 rename 으로 사라짐.
        assert!(!dir.path().join("out.bin.duet-part").exists());
    }

    /// 폴더 트리 복사 시 on_file 이 **내부 개별 파일마다** 호출된다(현재 파일명 표시용).
    #[tokio::test]
    async fn copy_relay_streaming_reports_each_file_in_tree() {
        use std::sync::{Arc, Mutex};
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("srcdir");
        fs::create_dir_all(src.join("sub")).await.unwrap();
        fs::write(src.join("a.txt"), b"a").await.unwrap();
        fs::write(src.join("b.txt"), b"bb").await.unwrap();
        fs::write(src.join("sub").join("c.txt"), b"ccc")
            .await
            .unwrap();

        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen_cb = seen.clone();
        let on_file = move |p: &std::path::Path| {
            if let Some(n) = p.file_name().and_then(|n| n.to_str()) {
                seen_cb.lock().unwrap().push(n.to_string());
            }
        };
        let local = LocalFs::new();
        let cancel = tokio_util::sync::CancellationToken::new();
        crate::fs::copy_relay_streaming(
            &local,
            &src,
            &local,
            &dir.path().join("dstdir"),
            false,
            &cancel,
            &|_| {},
            &on_file,
        )
        .await
        .unwrap();

        let mut got = seen.lock().unwrap().clone();
        got.sort();
        // 폴더 자체가 아니라 내부 파일 3개가 각각 보고돼야 함.
        assert_eq!(got, vec!["a.txt", "b.txt", "c.txt"]);
    }

    /// dir_size 는 디렉토리 하위 전체 바이트를 재귀 합산(진행률 분모용).
    #[tokio::test]
    async fn dir_size_sums_tree() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("d");
        fs::create_dir_all(root.join("sub")).await.unwrap();
        fs::write(root.join("a"), vec![0u8; 100]).await.unwrap();
        fs::write(root.join("sub").join("b"), vec![0u8; 250])
            .await
            .unwrap();
        let local = LocalFs::new();
        // 디렉토리 = 100 + 250.
        assert_eq!(local.dir_size(&root).await.unwrap(), 350);
        // 단일 파일 = 그 크기.
        assert_eq!(local.dir_size(&root.join("a")).await.unwrap(), 100);
    }

    /// dir_size 는 링크를 따라가지 않는다 — 트리 밖 용량이 새 들어오거나
    /// 자기 조상을 가리키는 링크에서 순환하면 안 된다 (기본 구현과 동일 판정).
    #[cfg(unix)]
    #[tokio::test]
    async fn dir_size_does_not_follow_symlinks() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("d");
        fs::create_dir_all(root.join("sub")).await.unwrap();
        fs::write(root.join("sub").join("big"), vec![0u8; 500])
            .await
            .unwrap();
        // 트리 밖 파일로의 링크 — 따라가면 100 이 더 붙는다.
        fs::write(dir.path().join("outside"), vec![0u8; 100])
            .await
            .unwrap();
        std::os::unix::fs::symlink(dir.path().join("outside"), root.join("link")).unwrap();
        // 자기 조상으로의 링크 — 따라가면 무한 순환.
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        let local = LocalFs::new();
        assert_eq!(local.dir_size(&root).await.unwrap(), 500);
    }
}
