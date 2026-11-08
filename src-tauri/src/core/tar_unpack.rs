//! tar 스트림을 항목 단위로 푼다 (`tar::Archive::unpack` 대신).
//!
//! 직접 푸는 이유 — 모두 Windows 에서 해제 전체를 실패시키던 원인이다.
//! - 심볼릭 링크: 관리자·개발자 모드가 아니면 만들 수 없다 → 링크만 건너뛰고 보고한다.
//! - Windows 에서 쓸 수 없는 이름(`:` `?`, 끝의 `.`, CON 등) → `_` 로 바꾸고 보고한다.
//! - `unpack` 은 항목마다 `canonicalize` 로 경로를 검증하는데, RAM 디스크나 일부
//!   네트워크·가상 드라이브에선 `canonicalize` 자체가 실패한다. 여기선 경로 조각 검사와
//!   "이미 만든 링크를 거쳐 쓰지 않기" 검사로 같은 보호(zip-slip 차단)를 한다.
//! - 하드링크를 지원하지 않는 드라이브(exFAT 등)에선 복사로 대신한다.
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
            let src = dest.join(&src_rel);
            if std::fs::hard_link(&src, &dst).is_err() {
                // 하드링크를 지원하지 않는 드라이브 — 내용을 복사해 같은 파일을 만든다.
                std::fs::copy(&src, &dst).map_err(|e| write_error(&shown, &e))?;
            }
        } else {
            // 파일·폴더·그 밖(POSIX 상 미지의 종류는 일반 파일). 권한·수정 시각 처리는 tar 에 맡긴다.
            entry.unpack(&dst).map_err(|e| write_error(&shown, &e))?;
        }
    }
    Ok(report)
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

    #[test]
    fn link_target_uses_native_separators() {
        let t = link_target(b"../lib/x.so");
        assert_eq!(t.components().count(), 3);
    }
}
