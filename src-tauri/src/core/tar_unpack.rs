//! tar 스트림을 항목 단위로 푼다 (`tar::Archive::unpack` 대신).
//!
//! 직접 푸는 이유 — 모두 Windows 에서 해제 전체를 실패시키던 원인이다.
//! - 심볼릭 링크: 관리자·개발자 모드가 아니면 만들 수 없다 → 링크만 건너뛰고 보고한다.
//! - Windows 에서 쓸 수 없는 이름(`:` `?`, 끝의 `.`, CON 등) → `_` 로 바꾸고 보고한다.
//! - `unpack` 은 항목마다 `canonicalize` 로 경로를 검증하는데, RAM 디스크나 일부
//!   네트워크·가상 드라이브에선 `canonicalize` 자체가 실패한다. 여기선 경로 조각 검사와
//!   "이미 만든 링크를 거쳐 쓰지 않기" 검사로 같은 보호(zip-slip 차단)를 한다.
//! - 하드링크를 지원하지 않는 드라이브(exFAT 등)에선 복사로 대신한다. 이때도 링크는
//!   따라가지 않는다(원본이 일반 파일일 때만 복사, 대상 자리는 새 파일로 교체 — archive-01).
//! - 실패 메시지에 OS 원인을 남긴다. tar 의 오류 문구는 원인을 빼고
//!   "failed to unpack …" 만 보여 줘서 사용자가 이유를 알 수 없었다.

use crate::platform::{entry_name, links};
use crate::types::DuetError;
use std::error::Error as _;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// 해제는 성공했지만 사용자에게 알려야 할 것 — 표시용 원래 경로(아카이브 안 이름).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct UnpackReport {
    /// 이 OS·드라이브에서 만들 수 없어 건너뛴 심볼릭 링크.
    pub skipped_links: Vec<String>,
    /// 이 OS 에서 쓸 수 없는 이름이라 바꿔서 푼 항목.
    pub renamed: Vec<String>,
}

/// `reader`(압축이 이미 풀린 tar 스트림)를 `dest` 아래에 푼다. `dest` 는 있어야 한다.
pub fn unpack<R: Read>(reader: R, dest: &Path) -> Result<UnpackReport, DuetError> {
    let mut archive = tar::Archive::new(reader);
    let mut report = UnpackReport::default();
    let mut dir_modes = Vec::new();
    let entries = archive.entries().map_err(|e| read_error(&e))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| read_error(&e))?;
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions()
            || kind.is_pax_local_extensions()
            || kind.is_gnu_longname()
            || kind.is_gnu_longlink()
        {
            continue;
        }
        let raw = entry.path_bytes().into_owned();
        let shown = String::from_utf8_lossy(&raw).into_owned();
        // `..` 가 든 항목은 tar 와 같이 조용히 건너뛴다(대상 밖으로 쓰기 차단).
        let Some((rel, renamed)) = safe_relative(&raw) else {
            continue;
        };
        refuse_through_link(dest, &rel)?;
        let dst = dest.join(&rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| write_error(&shown, &e))?;
        }
        if renamed {
            report.renamed.push(shown.clone());
        }

        if kind.is_symlink() {
            let target = entry
                .link_name_bytes()
                .map(|b| link_target(&b))
                .ok_or_else(|| DuetError::Io(format!("{shown}: link has no target")))?;
            match links::create_symlink(&target, &dst) {
                Ok(()) => {}
                Err(e) if links::is_link_not_permitted(&e) => report.skipped_links.push(shown),
                Err(e) => return Err(write_error(&shown, &e)),
            }
        } else if kind.is_hard_link() {
            let src_rel = entry
                .link_name_bytes()
                .and_then(|b| safe_relative(&b))
                .map(|(p, _)| p)
                .ok_or_else(|| {
                    DuetError::Io(format!("{shown}: hard link points outside the archive"))
                })?;
            refuse_through_link(dest, &src_rel)?;
            if src_rel == rel {
                continue; // 자기 자신을 가리키는 하드링크 — 이미 그 자리에 있다.
            }
            let src = dest.join(&src_rel);
            match place_hard_link(&src, &dst).map_err(|e| write_error(&shown, &e))? {
                HardLink::Placed => {}
                HardLink::SkippedSymlink => report.skipped_links.push(shown),
            }
        } else if is_dir_entry(&entry, &raw) {
            // 폴더 권한은 지금 적용하지 않는다 — 0555·0500 폴더면 그 안 항목을 못 쓴다(archive-08).
            make_dir(&dst).map_err(|e| write_error(&shown, &e))?;
            if let Ok(mode) = entry.header().mode() {
                dir_modes.push(DirMode {
                    path: dst,
                    mode,
                    shown,
                });
            }
        } else {
            // 파일·그 밖(POSIX 상 미지의 종류는 일반 파일). 권한·수정 시각 처리는 tar 에 맡긴다.
            entry.unpack(&dst).map_err(|e| write_error(&shown, &e))?;
        }
    }
    apply_dir_modes(dir_modes)?;
    Ok(report)
}

/// 폴더 항목인지 — tar 의 `unpack` 과 같은 기준(폴더 종류, 또는 옛 BSD tar 처럼 ustar 가
/// 아닌 헤더에서 이름이 `/` 로 끝남).
fn is_dir_entry<R: Read>(entry: &tar::Entry<'_, R>, raw: &[u8]) -> bool {
    entry.header().entry_type().is_dir()
        || (entry.header().as_ustar().is_none() && raw.ends_with(b"/"))
}

/// 폴더를 만든다. 이미 폴더면 그대로, 같은 이름의 파일·링크가 있으면 오류
/// (링크를 따라 폴더 밖 폴더를 쓰지 않는다 — tar 의 `unpack_dir` 과 같은 판정).
fn make_dir(dst: &Path) -> io::Result<()> {
    match std::fs::create_dir(dst) {
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            if std::fs::symlink_metadata(dst).is_ok_and(|m| m.is_dir()) {
                Ok(())
            } else {
                Err(io::Error::new(
                    e.kind(),
                    format!("{e} when creating dir {}", dst.display()),
                ))
            }
        }
        r => r,
    }
}

/// 미뤄 둔 폴더 권한 하나 — 폴더 경로, tar 헤더의 모드, 오류 표시용 아카이브 안 이름.
struct DirMode {
    path: PathBuf,
    mode: u32,
    shown: String,
}

/// 모든 항목을 쓴 뒤 폴더 권한을 **깊은 것부터** 적용한다(위 폴더를 먼저 잠그면 아래를
/// 못 바꾼다). 같은 폴더가 여러 번 나오면 나중 항목이 이긴다(안정 정렬 + 순서대로 적용).
/// 중간에 해제가 실패하면 이 함수까지 오지 않는다 — 폴더가 쓰기 가능하게 남아 정리·롤백이 쉽다.
/// 적용 직전에 lstat 로 아직 폴더인지 본다(링크면 따라가 바깥 권한을 바꾸지 않는다).
fn apply_dir_modes(mut dirs: Vec<DirMode>) -> Result<(), DuetError> {
    dirs.sort_by_key(|d| std::cmp::Reverse(d.path.components().count()));
    for d in dirs {
        let Ok(meta) = std::fs::symlink_metadata(&d.path) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        if let Some(perm) = dir_permissions(meta.permissions(), d.mode) {
            std::fs::set_permissions(&d.path, perm).map_err(|e| write_error(&d.shown, &e))?;
        }
    }
    Ok(())
}

/// tar 헤더 모드 → 적용할 폴더 권한 (tar crate 의 `set_perms` 와 같은 규칙).
/// Unix: 하위 9비트(setuid 등은 버림). Windows: 소유자 쓰기 비트가 없을 때만 읽기 전용.
fn dir_permissions(current: std::fs::Permissions, mode: u32) -> Option<std::fs::Permissions> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = current;
        Some(std::fs::Permissions::from_mode(mode & 0o777))
    }
    #[cfg(not(unix))]
    {
        let mut perm = current;
        (mode & 0o200 == 0).then(|| {
            perm.set_readonly(true);
            perm
        })
    }
}

/// tar 경로 바이트(항상 `/` 구분) → `dest` 기준 상대 경로. `..` 가 있으면 None, 빈 경로도 None.
/// 두 번째 값은 이 OS 에서 쓸 수 없는 이름을 바꿨는지.
fn safe_relative(raw: &[u8]) -> Option<(PathBuf, bool)> {
    let text = String::from_utf8_lossy(raw);
    let mut rel = PathBuf::new();
    let mut renamed = false;
    for part in text.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            name => {
                let fixed = entry_name::sanitize_local_name(name);
                renamed |= fixed != name;
                rel.push(fixed.as_ref());
            }
        }
    }
    (!rel.as_os_str().is_empty()).then_some((rel, renamed))
}

/// 심볼릭 링크 대상 바이트 → 경로. `/` 로 나눠 이 OS 의 구분자로 다시 잇는다
/// (Windows 링크는 `/` 구분 대상을 따라가지 못한다). 해석·검증은 하지 않는다.
fn link_target(raw: &[u8]) -> PathBuf {
    let text = String::from_utf8_lossy(raw);
    let mut target = PathBuf::new();
    if text.starts_with('/') {
        target.push(std::path::MAIN_SEPARATOR_STR);
    }
    for part in text.split('/').filter(|p| !p.is_empty()) {
        target.push(part);
    }
    target
}

/// `rel` 의 상위 폴더 중 이미 링크인 것이 있으면 거부 — 앞 항목이 만든 링크를 거쳐
/// 대상 폴더 밖에 쓰는 공격(`a -> /etc` 다음 `a/passwd`)을 막는다.
fn refuse_through_link(dest: &Path, rel: &Path) -> Result<(), DuetError> {
    let mut cur = dest.to_path_buf();
    let mut parts = rel.components().peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            break; // 마지막 조각은 이번에 만들 항목 자체.
        }
        cur.push(part);
        if std::fs::symlink_metadata(&cur).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(DuetError::Io(format!(
                "archive writes through a link ({}), refusing to extract",
                rel.display()
            )));
        }
    }
    Ok(())
}

/// 하드링크 항목을 놓은 결과.
#[derive(Debug, PartialEq, Eq)]
enum HardLink {
    /// 하드링크 또는 (하드링크 미지원 드라이브에서) 내용 복사본을 만들었다.
    Placed,
    /// 원본이 심볼릭 링크인데 이 드라이브는 하드링크를 못 만든다 — 링크를 따라 복사하지
    /// 않고 건너뛴다(사용자에게는 "건너뛴 링크" 로 알린다).
    SkippedSymlink,
}

/// `dst` 자리에 `src`(해제 폴더 안, 부모는 이미 검사됨)의 하드링크를 놓는다.
///
/// 링크는 따라가지 않는다(G-15, archive-01):
/// - `src`·`dst` 모두 마지막 조각까지 lstat 으로 본다.
/// - 복사 폴백은 "하드링크 미지원" 오류일 때만, 원본이 일반 파일일 때만 한다.
///   원본이 심볼릭 링크면 복사하지 않는다(복사는 링크를 따라 바깥 내용을 읽는다).
/// - `dst` 에 이미 파일·링크가 있으면 그것을 따라가지 않고 그 자리를 교체한다.
fn place_hard_link(src: &Path, dst: &Path) -> io::Result<HardLink> {
    let src_meta = std::fs::symlink_metadata(src)?;
    if src_meta.is_dir() {
        return Err(io::Error::other("hard link points to a folder"));
    }
    if same_file(&src_meta, dst) {
        return Ok(HardLink::Placed); // 같은 링크가 다시 나옴 — 이미 그 파일이다.
    }
    let mut outcome = HardLink::Placed;
    create_replacing(dst, |at| match std::fs::hard_link(src, at) {
        Ok(()) => Ok(true),
        Err(e) if !hard_link_unsupported(&e) => Err(e),
        Err(_) if src_meta.file_type().is_symlink() => {
            outcome = HardLink::SkippedSymlink;
            Ok(false)
        }
        Err(e) if !src_meta.is_file() => Err(e),
        Err(_) => copy_new(src, at).map(|()| true),
    })?;
    Ok(outcome)
}

/// `dst` 자리에 `make` 로 새 항목을 만든다. `make` 는 **비어 있는** 경로를 받아 그 자리에
/// 만들고, 만들었으면 true 를 돌려준다(false = 아무것도 안 만듦, `dst` 는 그대로 둔다).
///
/// - `dst` 가 없으면 바로 거기에 만든다.
/// - `dst` 가 폴더면 오류(폴더를 파일로 갈아끼우지 않는다).
/// - `dst` 가 파일·심볼릭 링크 등이면 같은 폴더의 고유 임시 이름에 만든 뒤 `rename` 으로
///   교체한다. 지우기(`remove_*`)를 쓰지 않는다(CLAUDE.md §3). `rename` 은 마지막 조각을
///   따라가지 않고 그 이름(링크 자체)을 바꾼다 — Unix 는 POSIX `rename`, Windows 는
///   std 문서상 10 1607+ 에서 `FileRenameInfoEx` 로 Unix 와 같은 의미, 그 밖에선
///   `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` 이고 "to must not be a directory" 외 제약이
///   없다(<https://doc.rust-lang.org/std/fs/fn.rename.html>).
///   `rename` 이 실패하면 임시 항목이 해제 폴더 안에 남는다(폴더 밖 노출은 없음).
fn create_replacing(dst: &Path, make: impl FnOnce(&Path) -> io::Result<bool>) -> io::Result<bool> {
    match std::fs::symlink_metadata(dst) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => make(dst),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "a folder with this name already exists",
        )),
        Ok(_) => {
            let tmp = sibling_temp(dst)?;
            let created = make(&tmp)?;
            if created {
                std::fs::rename(&tmp, dst)?;
            }
            Ok(created)
        }
    }
}

/// `dst` 와 같은 폴더의 고유 임시 이름. 이름은 `dst` 와 무관하게 짧게(긴 이름 한도 회피).
fn sibling_temp(dst: &Path) -> io::Result<PathBuf> {
    let parent = dst
        .parent()
        .ok_or_else(|| io::Error::other("entry has no parent folder"))?;
    Ok(parent.join(format!(".duet-link-{}", uuid::Uuid::new_v4().simple())))
}

/// `src`(lstat 정보)와 `dst` 가 이미 같은 파일(하드링크)인지. 같은 하드링크 항목이 다시
/// 나오면 POSIX `rename` 은 "둘이 같은 파일이면 아무것도 안 하고 성공" 이라 임시 이름이
/// 남는다 — 그 전에 걸러낸다. Windows 는 파일 번호를 std 안정 API 로 못 읽어 검사하지 않는다.
fn same_file(src_meta: &std::fs::Metadata, dst: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::symlink_metadata(dst)
            .is_ok_and(|d| d.dev() == src_meta.dev() && d.ino() == src_meta.ino())
    }
    #[cfg(not(unix))]
    {
        let _ = (src_meta, dst);
        false
    }
}

/// 하드링크 실패가 "이 드라이브·파일시스템은 하드링크를 못 만든다" 때문인지 —
/// 이때만 복사로 대신한다. 이미 있음(EEXIST)·권한(EACCES) 등은 폴백하지 않는다.
/// - 공통: `CrossesDevices`(Unix EXDEV, Windows ERROR_NOT_SAME_DEVICE),
///   `Unsupported`(std 매핑: Unix ENOSYS·EOPNOTSUPP, Windows ERROR_CALL_NOT_IMPLEMENTED).
/// - Unix EPERM(1): Linux link(2) "filesystem … does not support the creation of hard links"
///   (FAT 계열). 원본이 폴더여도 EPERM 이지만 폴더는 호출 전에 걸렀다.
/// - macOS ENOTSUP(45): link(2) "The underlying file system does not support this call".
///   macOS 는 ENOTSUP(45) ≠ EOPNOTSUPP(102) 라 std 가 `Unsupported` 로 올리지 않는다.
/// - Windows ERROR_INVALID_FUNCTION(1)·ERROR_NOT_SUPPORTED(50): CreateHardLinkW 는
///   "only supported on the NTFS file system" 이고, 기능을 구현하지 않은 파일시스템의
///   STATUS_INVALID_DEVICE_REQUEST·STATUS_NOT_SUPPORTED 가 이 두 번호로 바뀐다
///   (NTSTATUS→Win32 매핑). FAT/exFAT 실기 확인 필요.
fn hard_link_unsupported(e: &io::Error) -> bool {
    #[cfg(target_vendor = "apple")]
    const CODES: &[i32] = &[1, 45];
    #[cfg(all(unix, not(target_vendor = "apple")))]
    const CODES: &[i32] = &[1];
    #[cfg(windows)]
    const CODES: &[i32] = &[1, 50];
    #[cfg(not(any(unix, windows)))]
    const CODES: &[i32] = &[];
    matches!(
        e.kind(),
        io::ErrorKind::CrossesDevices | io::ErrorKind::Unsupported
    ) || e.raw_os_error().is_some_and(|c| CODES.contains(&c))
}

/// 일반 파일 `src` 의 내용·권한을 **새 파일** `at` 에 복사한다(`create_new` = O_EXCL —
/// `at` 자리에 무엇이든, 끊어진 링크라도 있으면 실패하고 따라가지 않는다).
fn copy_new(src: &Path, at: &Path) -> io::Result<()> {
    let mut from = std::fs::File::open(src)?;
    let mut to = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(at)?;
    io::copy(&mut from, &mut to)?;
    to.set_permissions(from.metadata()?.permissions())
}

/// 오류 사슬의 가장 안쪽(실제 OS 원인)까지 이어 한 줄로. tar 는 원인을 Display 에서 빼고
/// `source()` 로만 들고 있다. "(os error N)" 은 남긴다 — 프론트가 번호로 쉬운 설명을 고른다.
pub(crate) fn describe_io(e: &io::Error) -> String {
    let mut msg = e.to_string();
    let mut cur = e.source();
    while let Some(s) = cur {
        let part = s.to_string();
        if !msg.contains(&part) {
            msg.push_str(": ");
            msg.push_str(&part);
        }
        cur = s.source();
    }
    msg
}

/// 가장 안쪽 io 오류의 종류 — 권한·없음은 DuetError 종류로 올려 프론트가 구분하게 한다.
fn root_kind(e: &io::Error) -> io::ErrorKind {
    let mut kind = e.kind();
    let mut cur = e.source();
    while let Some(s) = cur {
        if let Some(inner) = s.downcast_ref::<io::Error>() {
            kind = inner.kind();
        }
        cur = s.source();
    }
    kind
}

fn write_error(entry: &str, e: &io::Error) -> DuetError {
    let msg = format!("{entry}: {}", describe_io(e));
    match root_kind(e) {
        io::ErrorKind::PermissionDenied => DuetError::PermissionDenied(msg),
        io::ErrorKind::NotFound => DuetError::NotFound(msg),
        _ => DuetError::Io(msg),
    }
}

fn read_error(e: &io::Error) -> DuetError {
    DuetError::Io(format!(
        "archive is damaged or not a tar: {}",
        describe_io(e)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 항목 목록으로 tar 바이트를 만든다. (이름, 종류, 내용 또는 링크 대상)
    fn build(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        for (name, kind, data) in entries {
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(*kind);
            h.set_mode(if kind.is_dir() { 0o755 } else { 0o644 });
            if kind.is_symlink() || kind.is_hard_link() {
                h.set_size(0);
                h.set_link_name(std::str::from_utf8(data).unwrap()).unwrap();
                b.append_data(&mut h, name, io::empty()).unwrap();
            } else {
                h.set_size(data.len() as u64);
                b.append_data(&mut h, name, *data).unwrap();
            }
        }
        b.into_inner().unwrap()
    }

    #[test]
    fn unpacks_files_dirs_and_links() {
        use tar::EntryType as T;
        let tar = build(&[
            ("dir/", T::Directory, b""),
            ("dir/a.txt", T::Regular, b"hello"),
            ("dir/hard.txt", T::Link, b"dir/a.txt"),
            ("dir/soft.txt", T::Symlink, b"a.txt"),
        ]);
        let dest = tempfile::tempdir().unwrap();
        let report = unpack(&tar[..], dest.path()).unwrap();
        assert_eq!(
            std::fs::read(dest.path().join("dir/a.txt")).unwrap(),
            b"hello"
        );
        assert_eq!(
            std::fs::read(dest.path().join("dir/hard.txt")).unwrap(),
            b"hello"
        );
        #[cfg(unix)]
        assert_eq!(
            std::fs::read(dest.path().join("dir/soft.txt")).unwrap(),
            b"hello"
        );
        assert!(report.renamed.is_empty());
    }

    #[test]
    fn skips_parent_dir_entries() {
        use tar::EntryType as T;
        // Builder 는 `..` 이름을 거부하므로 헤더 바이트를 직접 쓴다.
        let mut tar = build(&[("placeholder", T::Regular, b"x")]);
        tar[..11].copy_from_slice(b"../evil.txt");
        let mut h = tar::Header::new_gnu();
        h.as_mut_bytes().copy_from_slice(&tar[..512]);
        h.set_cksum();
        tar[..512].copy_from_slice(h.as_bytes());
        let outer = tempfile::tempdir().unwrap();
        let dest = outer.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        unpack(&tar[..], &dest).unwrap();
        assert!(!outer.path().join("evil.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_write_through_an_extracted_link() {
        use tar::EntryType as T;
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().to_string_lossy().into_owned();
        let tar = build(&[
            ("escape", T::Symlink, target.as_bytes()),
            ("escape/pwned.txt", T::Regular, b"x"),
        ]);
        let dest = tempfile::tempdir().unwrap();
        let err = unpack(&tar[..], dest.path()).unwrap_err();
        assert!(matches!(err, DuetError::Io(m) if m.contains("through a link")));
        assert!(!outside.path().join("pwned.txt").exists());
    }

    #[test]
    fn hard_link_outside_archive_is_rejected() {
        use tar::EntryType as T;
        let tar = build(&[("a.txt", T::Regular, b"x"), ("b.txt", T::Link, b"../a.txt")]);
        let dest = tempfile::tempdir().unwrap();
        assert!(unpack(&tar[..], dest.path()).is_err());
    }

    #[test]
    fn damaged_stream_reports_read_error() {
        let mut tar = build(&[("a.txt", tar::EntryType::Regular, b"hello")]);
        tar[148..156].copy_from_slice(b"garbage!"); // 체크섬 칸을 깨뜨린다.
        let dest = tempfile::tempdir().unwrap();
        let err = unpack(&tar[..], dest.path()).unwrap_err();
        assert!(matches!(err, DuetError::Io(m) if m.starts_with("archive is damaged")));
    }

    #[test]
    fn describe_io_keeps_the_os_cause() {
        let inner = io::Error::from_raw_os_error(5);
        let wrapped = io::Error::new(inner.kind(), Wrapper(inner));
        let text = describe_io(&wrapped);
        assert!(text.starts_with("failed to unpack"), "{text}");
        assert!(text.contains("os error 5"), "{text}");
        assert_eq!(root_kind(&wrapped), io::Error::from_raw_os_error(5).kind());
    }

    /// tar 의 TarError 처럼 원인을 Display 에서 빼고 source 로만 든 오류.
    #[derive(Debug)]
    struct Wrapper(io::Error);
    impl std::fmt::Display for Wrapper {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("failed to unpack `x`")
        }
    }
    impl std::error::Error for Wrapper {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }

    /// 해제 폴더 안 이름 목록(정렬).
    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn same_name_regular_then_hard_link_replaces_it() {
        use tar::EntryType as T;
        // tar 갱신(append) 에서 흔한 모양 — 같은 이름이 다시 나오면 마지막 것이 이긴다.
        let tar = build(&[
            ("a.txt", T::Regular, b"new"),
            ("b.txt", T::Regular, b"old"),
            ("b.txt", T::Link, b"a.txt"),
        ]);
        let dest = tempfile::tempdir().unwrap();
        unpack(&tar[..], dest.path()).unwrap();
        assert_eq!(std::fs::read(dest.path().join("b.txt")).unwrap(), b"new");
        assert_eq!(names(dest.path()), ["a.txt", "b.txt"], "임시 이름이 남았다");
    }

    #[test]
    fn repeated_and_self_hard_links_leave_no_temp() {
        use tar::EntryType as T;
        let tar = build(&[
            ("a.txt", T::Regular, b"x"),
            ("b.txt", T::Link, b"a.txt"),
            ("b.txt", T::Link, b"a.txt"),
            ("a.txt", T::Link, b"a.txt"),
        ]);
        let dest = tempfile::tempdir().unwrap();
        unpack(&tar[..], dest.path()).unwrap();
        assert_eq!(std::fs::read(dest.path().join("b.txt")).unwrap(), b"x");
        assert_eq!(names(dest.path()), ["a.txt", "b.txt"]);
    }

    #[test]
    fn hard_link_over_folder_is_an_error() {
        use tar::EntryType as T;
        let tar = build(&[
            ("a.txt", T::Regular, b"x"),
            ("d/", T::Directory, b""),
            ("d/keep", T::Regular, b"k"),
            ("d", T::Link, b"a.txt"),
        ]);
        let dest = tempfile::tempdir().unwrap();
        assert!(unpack(&tar[..], dest.path()).is_err());
        assert_eq!(std::fs::read(dest.path().join("d/keep")).unwrap(), b"k");
    }

    #[test]
    fn only_unsupported_errors_fall_back_to_copy() {
        use io::ErrorKind as K;
        assert!(!hard_link_unsupported(&io::Error::from(K::AlreadyExists)));
        assert!(!hard_link_unsupported(&io::Error::from(K::NotFound)));
        assert!(hard_link_unsupported(&io::Error::from(K::CrossesDevices)));
        assert!(hard_link_unsupported(&io::Error::from(K::Unsupported)));
        #[cfg(unix)]
        {
            // EEXIST(17)·EACCES(13) 는 폴백 아님, EPERM(1)·EXDEV(18) 은 폴백.
            assert!(!hard_link_unsupported(&io::Error::from_raw_os_error(17)));
            assert!(!hard_link_unsupported(&io::Error::from_raw_os_error(13)));
            assert!(hard_link_unsupported(&io::Error::from_raw_os_error(1)));
            assert!(hard_link_unsupported(&io::Error::from_raw_os_error(18)));
        }
        #[cfg(target_vendor = "apple")]
        assert!(hard_link_unsupported(&io::Error::from_raw_os_error(45)));
        #[cfg(windows)]
        {
            // ERROR_ALREADY_EXISTS(183)·ERROR_ACCESS_DENIED(5) 는 폴백 아님.
            assert!(!hard_link_unsupported(&io::Error::from_raw_os_error(183)));
            assert!(!hard_link_unsupported(&io::Error::from_raw_os_error(5)));
            assert!(hard_link_unsupported(&io::Error::from_raw_os_error(1)));
            assert!(hard_link_unsupported(&io::Error::from_raw_os_error(17)));
        }
    }

    /// 복사 폴백 경로(macOS 에선 실제로 일으키기 어렵다)를 직접 — 대상 자리의 링크를
    /// 따라가지 않고 링크 자체를 새 파일로 교체한다.
    #[cfg(unix)]
    #[test]
    fn copy_fallback_replaces_destination_link_without_following() {
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim");
        std::fs::write(&victim, b"ORIGINAL").unwrap();
        let dest = tempfile::tempdir().unwrap();
        let src = dest.path().join("s");
        std::fs::write(&src, b"PAYLOAD").unwrap();
        let dst = dest.path().join("h");
        std::os::unix::fs::symlink(&victim, &dst).unwrap();
        let dangling = dest.path().join("d");
        std::os::unix::fs::symlink(outside.path().join("new"), &dangling).unwrap();

        assert!(create_replacing(&dst, |at| copy_new(&src, at).map(|()| true)).unwrap());
        assert!(create_replacing(&dangling, |at| copy_new(&src, at).map(|()| true)).unwrap());

        assert_eq!(std::fs::read(&victim).unwrap(), b"ORIGINAL");
        assert!(!outside.path().join("new").exists());
        for p in [&dst, &dangling] {
            let m = std::fs::symlink_metadata(p).unwrap();
            assert!(m.is_file(), "{p:?} 가 일반 파일이 아니다");
            assert_eq!(std::fs::read(p).unwrap(), b"PAYLOAD");
        }
        assert_eq!(names(dest.path()), ["d", "h", "s"]);
    }

    /// `create_new` 는 끊어진 링크 자리에서도 실패한다(따라가 바깥에 만들지 않음).
    #[cfg(unix)]
    #[test]
    fn copy_new_never_follows_a_link() {
        let outside = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let src = dest.path().join("s");
        std::fs::write(&src, b"x").unwrap();
        let at = dest.path().join("l");
        std::os::unix::fs::symlink(outside.path().join("new"), &at).unwrap();
        let err = copy_new(&src, &at).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert!(!outside.path().join("new").exists());
    }

    /// 모드를 지정해 tar 를 만든다 (폴더 권한 테스트용).
    #[cfg(unix)]
    fn build_modes(entries: &[(&str, tar::EntryType, &[u8], u32)]) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        for (name, kind, data, mode) in entries {
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(*kind);
            h.set_mode(*mode);
            h.set_size(data.len() as u64);
            b.append_data(&mut h, name, *data).unwrap();
        }
        b.into_inner().unwrap()
    }

    #[cfg(unix)]
    fn mode_of(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777
    }

    /// TempDir 이 지울 수 있게 폴더 권한을 되돌린다.
    #[cfg(unix)]
    fn unlock(dirs: &[&Path]) {
        use std::os::unix::fs::PermissionsExt;
        for d in dirs {
            let _ = std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o755));
        }
    }

    #[cfg(unix)]
    #[test]
    fn read_only_folder_modes_are_applied_after_children() {
        use tar::EntryType as T;
        let tar = build_modes(&[
            ("a/", T::Directory, b"", 0o555),
            ("a/b/", T::Directory, b"", 0o500),
            ("a/b/c.txt", T::Regular, b"c", 0o644),
            ("a/d.txt", T::Regular, b"d", 0o600),
        ]);
        let dest = tempfile::tempdir().unwrap();
        let r = unpack(&tar[..], dest.path());
        let (a, b) = (dest.path().join("a"), dest.path().join("a/b"));
        let modes = (mode_of(&a), mode_of(&b));
        unlock(&[&a, &b]);
        r.unwrap();
        assert_eq!(modes, (0o555, 0o500));
        assert_eq!(std::fs::read(b.join("c.txt")).unwrap(), b"c");
        assert_eq!(std::fs::read(a.join("d.txt")).unwrap(), b"d");
    }

    #[cfg(unix)]
    #[test]
    fn repeated_folder_entry_last_mode_wins() {
        use tar::EntryType as T;
        let tar = build_modes(&[
            ("a/", T::Directory, b"", 0o555),
            ("a/f", T::Regular, b"f", 0o644),
            ("a/", T::Directory, b"", 0o750),
        ]);
        let dest = tempfile::tempdir().unwrap();
        unpack(&tar[..], dest.path()).unwrap();
        assert_eq!(mode_of(&dest.path().join("a")), 0o750);
    }

    /// 중간 실패면 폴더 권한을 적용하지 않는다 — 폴더가 쓰기 가능하게 남는다(정리·롤백용).
    #[cfg(unix)]
    #[test]
    fn failure_leaves_folders_writable() {
        use tar::EntryType as T;
        let tar = build_modes(&[
            ("a/", T::Directory, b"", 0o555),
            ("a/f", T::Regular, b"f", 0o644),
            ("a/f/x", T::Regular, b"x", 0o644), // f 가 파일이라 그 아래에 못 쓴다.
        ]);
        let dest = tempfile::tempdir().unwrap();
        assert!(unpack(&tar[..], dest.path()).is_err());
        assert_ne!(mode_of(&dest.path().join("a")) & 0o200, 0);
    }

    #[test]
    fn link_target_uses_native_separators() {
        let t = link_target(b"../lib/x.so");
        assert_eq!(t.components().count(), 3);
    }
}
