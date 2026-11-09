//! zip·7z 를 항목 단위로 푼다 — `core::tar_unpack` 과 같은 방식·같은 안전 헬퍼.
//!
//! 예전에는 zip 은 `ZipArchive::extract` 통째로, 암호 zip 은 따로 만든 루프로, 7z 는
//! `sevenz_rust2::decompress_file` 로 풀었다. 그래서 (archive-07·18·04):
//! - Windows 에서 링크 항목 하나(권한 없음 1314)·쓸 수 없는 이름(`?*<>|"`) 하나로 전체 실패,
//!   `:` 가 든 이름은 대체 데이터 스트림으로 숨고, `CON` 같은 예약 이름은 그대로 썼다.
//! - 암호 zip 은 링크를 일반 파일로 풀고 실행 비트를 버렸다.
//! - 표시 없는 CP949 이름이 깨졌다.
//!
//! 여기서는 tar 와 같이: 이름 조각마다 `sanitize_local_name`(바꾸면 `renamed` 로 보고),
//! 링크를 만들 수 없으면 건너뛰고 `skipped_links` 로 보고, 앞 항목이 만든 링크를 거쳐 쓰지
//! 않기(`refuse_through_link`), 기존 링크를 따라가지 않는 새 파일 생성(`write_new_file`),
//! 폴더 권한은 끝에 깊은 것부터(`DeferredDirModes`).

use crate::core::tar_unpack::{
    link_target, link_target_is_dir, make_dir, permissions_from_mode, refuse_through_link,
    relative_path, write_error, write_new_file, DeferredDirModes, NameGuard, UnpackReport,
};
use crate::core::zip_names;
use crate::platform::{entry_name, links};
use crate::types::DuetError;
use std::borrow::Cow;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// 링크 대상 길이 상한 — 링크 항목의 "크기" 는 아카이브가 정한 값이라 그대로 믿고 읽지 않는다
/// (zip crate `extract` 의 `MAX_SYMLINK_TARGET_LEN` 과 같은 취지).
const MAX_LINK_TARGET: u64 = 4096;

/// 이름 조각 하나를 이 OS 에서 쓸 수 있게 바꾸는 함수 (테스트는 Windows 규칙을 넣는다).
type Sanitize = fn(&str) -> Cow<'_, str>;

/// zip 을 `dest`(있어야 함) 아래에 푼다. 암호화 항목이 있으면 `password` 가 필요하다
/// (없음·틀림 → `NeedPassword`, 예전 의미 그대로).
pub(crate) fn unpack_zip(
    archive: &Path,
    dest: &Path,
    password: Option<&str>,
) -> Result<UnpackReport, DuetError> {
    unpack_zip_with(archive, dest, password, entry_name::sanitize_local_name)
}

fn unpack_zip_with(
    archive: &Path,
    dest: &Path,
    password: Option<&str>,
    sanitize: Sanitize,
) -> Result<UnpackReport, DuetError> {
    let file =
        std::fs::File::open(archive).map_err(|e| DuetError::Io(format!("open archive: {e}")))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| DuetError::Io(format!("zip open: {e}")))?;
    // 암호화 항목이 하나라도 있으면(by_index_raw = 복호화 안 함) 모든 항목을 암호로 연다.
    let encrypted =
        (0..zip.len()).any(|i| zip.by_index_raw(i).map(|e| e.encrypted()).unwrap_or(false));
    let password = match (encrypted, password) {
        (false, _) => None,
        (true, Some(pw)) => Some(pw),
        (true, None) => return Err(DuetError::NeedPassword),
    };
    let mut out = Output::new(dest);
    for i in 0..zip.len() {
        let opened = match password {
            Some(pw) => zip.by_index_decrypt(i, pw.as_bytes()),
            None => zip.by_index(i),
        };
        let mut entry = opened.map_err(zip_error)?;
        let decoded = entry.name().map_err(zip_error)?.into_owned();
        let name = zip_names::decode_entry_name(entry.name_raw(), Cow::Owned(decoded)).into_owned();
        // `..` 가 든 항목은 tar 와 같이 건너뛴다(예전 암호 zip 경로와 같음).
        let Some(path) = zip_path(&name, sanitize) else {
            continue;
        };
        let mode = entry.unix_mode();
        if entry.is_dir() {
            out.dir(&name, path, mode)?;
        } else if entry.is_symlink() {
            if entry.size() > MAX_LINK_TARGET {
                return Err(DuetError::Io(format!("{name}: link target is too long")));
            }
            let mut target = Vec::new();
            (&mut entry)
                .take(MAX_LINK_TARGET)
                .read_to_end(&mut target)
                .map_err(|e| write_error(&name, &e))?;
            out.symlink(&name, path, &target)?;
        } else {
            out.file(&name, path, &mut entry, mode)?;
        }
    }
    out.finish()
}

/// zip 오류 → DuetError. 틀린 암호는 다시 묻도록 `NeedPassword`.
fn zip_error(e: zip::result::ZipError) -> DuetError {
    match e {
        zip::result::ZipError::InvalidPassword => DuetError::NeedPassword,
        e => DuetError::Io(format!("zip extract: {e}")),
    }
}

/// zip 항목 이름 → 상대 경로. `/` 와 `\` 를 모두 구분자로 본다 — zip crate 9 의 `extract`
/// 와 같다(Windows PowerShell 5 `Compress-Archive` 같은 도구가 `\` 로 쓴다). 맨 앞 루트
/// (`/x`)와 드라이브(`C:\x`)는 떼어 해제 폴더 아래로 둔다(zip crate 와 같음). `..`·NUL 이 있으면 None.
fn zip_path(name: &str, sanitize: Sanitize) -> Option<(PathBuf, bool)> {
    if name.contains('\0') {
        return None; // zip crate `enclosed_name` 처럼 NUL 이 든 이름은 건너뛴다.
    }
    let mut parts = name.split(['/', '\\']).peekable();
    if parts.peek().is_some_and(|p| is_drive(p)) {
        parts.next();
    }
    relative_path(parts, sanitize)
}

/// `C:` 같은 드라이브 지정자인지.
fn is_drive(part: &str) -> bool {
    matches!(part.as_bytes(), [d, b':'] if d.is_ascii_alphabetic())
}

/// 7z 를 `dest` 아래에 푼다(없으면 만든다 — 예전 `decompress_file` 과 같음).
/// 암호 없음·틀림은 `NeedPassword` (예전과 같은 메시지 판정).
pub(crate) fn unpack_sevenz(
    archive: &Path,
    dest: &Path,
    password: Option<&str>,
) -> Result<UnpackReport, DuetError> {
    unpack_sevenz_with(archive, dest, password, entry_name::sanitize_local_name)
}

fn unpack_sevenz_with(
    archive: &Path,
    dest: &Path,
    password: Option<&str>,
    sanitize: Sanitize,
) -> Result<UnpackReport, DuetError> {
    let file = std::fs::File::open(archive)
        .map_err(|e| DuetError::Io(format!("7z extract: open archive: {e}")))?;
    let password = password.map_or_else(sevenz_rust2::Password::empty, Into::into);
    let mut reader = sevenz_rust2::ArchiveReader::new(file, password).map_err(sevenz_error)?;
    std::fs::create_dir_all(dest).map_err(|e| write_error("", &e))?;
    let mut out = Output::new(dest);
    // 우리 쪽(쓰기) 실패는 여기 담아 두고, 라이브러리 쪽(읽기·복호화) 실패는 라이브러리
    // 오류로 돌려 예전과 같은 암호 판정을 받게 한다.
    let mut failure: Option<DuetError> = None;
    let walked = reader.for_each_entries(|entry, data| {
        match sevenz_entry(&mut out, entry, data, sanitize) {
            Ok(()) => Ok(true),
            Err(Failure::Read(e)) => Err(e.into()),
            Err(Failure::Ours(e)) => {
                failure = Some(e);
                // false 는 지금 블록만 멈추고 다음 블록을 계속 돈다 — 오류로 전체를 멈춘다.
                Err(sevenz_rust2::Error::Other("extraction stopped".into()))
            }
        }
    });
    if let Some(e) = failure {
        return Err(e);
    }
    walked.map_err(sevenz_error)?;
    out.finish()
}

/// 7z 항목 하나에서 난 실패의 출처.
enum Failure {
    /// 아카이브를 읽다(복호화·압축 해제) 실패 — 라이브러리 오류 판정으로 보낸다.
    Read(io::Error),
    /// 이름·쓰기 등 우리 쪽 실패.
    Ours(DuetError),
}

impl From<DuetError> for Failure {
    fn from(e: DuetError) -> Self {
        Failure::Ours(e)
    }
}

fn sevenz_entry(
    out: &mut Output<'_>,
    entry: &sevenz_rust2::ArchiveEntry,
    data: &mut dyn Read,
    sanitize: Sanitize,
) -> Result<(), Failure> {
    let name = entry.name();
    if entry.is_anti_item {
        return drain(data); // 갱신용 "삭제 표시" 항목 — 풀 것이 없다.
    }
    // 7z 는 `..`·루트·드라이브가 든 이름을 예전(sevenz-rust2 `safe_join`)처럼 전체 거부한다.
    let path = sevenz_path(name, sanitize).ok_or_else(|| {
        DuetError::Io(format!(
            "7z extract: unsafe entry path escapes destination: {name}"
        ))
    })?;
    let mode = sevenz_unix_mode(entry);
    if entry.is_directory() {
        out.dir(name, path, mode)?;
        return drain(data);
    }
    let mut src = ReadSide {
        inner: data,
        failed: false,
    };
    match out.file_handle(name, path, &mut src, mode) {
        Ok(file) => {
            if entry.has_last_modified_date {
                // 예전 `default_entry_extract_fn` 처럼 수정 시각을 옮긴다(실패는 무시).
                let _ = file.set_modified(entry.last_modified_date().into());
            }
            Ok(())
        }
        Err(FileError::Io(e)) if src.failed => Err(Failure::Read(e)),
        Err(FileError::Io(e)) => Err(Failure::Ours(write_error(name, &e))),
        Err(FileError::Duet(e)) => Err(Failure::Ours(e)),
    }
}

/// 남은 데이터를 읽어 버린다(건너뛰는 항목도 스트림은 끝까지 소비).
fn drain(data: &mut dyn Read) -> Result<(), Failure> {
    io::copy(data, &mut io::sink())
        .map(|_| ())
        .map_err(Failure::Read)
}

/// 7z 이름 → 상대 경로. `/`·`\` 모두 구분자, `..`·맨 앞 루트·드라이브는 None(전체 거부).
fn sevenz_path(name: &str, sanitize: Sanitize) -> Option<(PathBuf, bool)> {
    let mut parts = name.split(['/', '\\']);
    let first = parts.clone().next()?;
    if first.is_empty() && !name.is_empty() || is_drive(first) {
        return None; // `/x`, `\x`, `C:\x`
    }
    if parts.any(|p| p == "..") {
        return None;
    }
    relative_path(name.split(['/', '\\']), sanitize)
}

/// 7z 항목의 Unix 모드 — p7zip·7-Zip(Linux)은 속성 상위 16비트에 넣고 0x8000 을 켠다
/// (FILE_ATTRIBUTE_UNIX_EXTENSION). 없으면 None(모드 손대지 않음).
fn sevenz_unix_mode(entry: &sevenz_rust2::ArchiveEntry) -> Option<u32> {
    const UNIX_EXTENSION: u32 = 0x8000;
    let attrs = entry.windows_attributes;
    (entry.has_windows_attributes && attrs & UNIX_EXTENSION != 0).then_some(attrs >> 16)
}

/// 7z 오류 → DuetError. 라이브러리가 암호 필요/오류를 항상 별도 variant 로 주지 않아 메시지로
/// 판정한다(예전과 같은 규칙).
fn sevenz_error(e: sevenz_rust2::Error) -> DuetError {
    let msg = e.to_string();
    if msg.to_ascii_lowercase().contains("password") {
        DuetError::NeedPassword
    } else {
        DuetError::Io(format!("7z extract: {msg}"))
    }
}

/// 읽는 쪽에서 오류가 났는지 기억하는 reader — 쓰기 실패와 구분한다.
struct ReadSide<'a> {
    inner: &'a mut dyn Read,
    failed: bool,
}

impl Read for ReadSide<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let r = self.inner.read(buf);
        self.failed |= r.is_err();
        r
    }
}

/// 파일 쓰기 실패 — io 오류(출처 판정 전)와 이미 DuetError 인 것.
enum FileError {
    Io(io::Error),
    Duet(DuetError),
}

/// 해제 결과를 쓰는 쪽 — 경로 검사·폴더 생성·보고·폴더 권한 지연을 한곳에서.
struct Output<'d> {
    dest: &'d Path,
    report: UnpackReport,
    dir_modes: DeferredDirModes,
    names: NameGuard,
}

impl<'d> Output<'d> {
    fn new(dest: &'d Path) -> Self {
        Self {
            dest,
            report: UnpackReport::default(),
            dir_modes: DeferredDirModes::default(),
            names: NameGuard::default(),
        }
    }

    /// 항목을 쓸 자리를 준비한다 — 링크 경유 거부, 상위 폴더 생성, 바꾼 이름 보고.
    /// 이름이 겹치면(대소문자만 다름 등) `이름 (2)` 로 옮긴다([`NameGuard`]). 실제 상대 경로와
    /// 절대 경로를 돌려준다.
    fn prepare(
        &mut self,
        shown: &str,
        (rel, renamed): (PathBuf, bool),
        is_dir: bool,
    ) -> Result<(PathBuf, PathBuf), DuetError> {
        refuse_through_link(self.dest, &rel)?;
        let (rel, kept_both) = self.names.place(self.dest, rel, shown, is_dir);
        refuse_through_link(self.dest, &rel)?;
        let dst = self.dest.join(&rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| write_error(shown, &e))?;
        }
        if renamed || kept_both {
            self.report.renamed.push(shown.to_string());
        }
        Ok((rel, dst))
    }

    fn dir(
        &mut self,
        shown: &str,
        path: (PathBuf, bool),
        mode: Option<u32>,
    ) -> Result<(), DuetError> {
        let (_, dst) = self.prepare(shown, path, true)?;
        make_dir(&dst).map_err(|e| write_error(shown, &e))?;
        if let Some(mode) = mode {
            self.dir_modes.push(dst, mode, shown.to_string());
        }
        Ok(())
    }

    fn file(
        &mut self,
        shown: &str,
        path: (PathBuf, bool),
        content: &mut impl Read,
        mode: Option<u32>,
    ) -> Result<(), DuetError> {
        match self.file_handle(shown, path, content, mode) {
            Ok(_) => Ok(()),
            Err(FileError::Io(e)) => Err(write_error(shown, &e)),
            Err(FileError::Duet(e)) => Err(e),
        }
    }

    /// 새 일반 파일을 만들어 채우고 모드를 준다. 열린 파일을 돌려준다(시각 설정용).
    fn file_handle(
        &mut self,
        shown: &str,
        path: (PathBuf, bool),
        content: &mut impl Read,
        mode: Option<u32>,
    ) -> Result<std::fs::File, FileError> {
        let (_, dst) = self.prepare(shown, path, false).map_err(FileError::Duet)?;
        let file = write_new_file(&dst, content).map_err(FileError::Io)?;
        if let Some(mode) = mode {
            let current = file.metadata().map_err(FileError::Io)?.permissions();
            if let Some(perm) = permissions_from_mode(current, mode) {
                file.set_permissions(perm).map_err(FileError::Io)?;
            }
        }
        Ok(file)
    }

    /// 링크 항목 — 만들 수 없는 환경이면 건너뛰고 보고한다.
    fn symlink(
        &mut self,
        shown: &str,
        path: (PathBuf, bool),
        target: &[u8],
    ) -> Result<(), DuetError> {
        let (rel, dst) = self.prepare(shown, path, false)?;
        let target = link_target(target);
        let is_dir = link_target_is_dir(self.dest, &rel, &target);
        match links::create_symlink(&target, &dst, is_dir) {
            Ok(()) => Ok(()),
            Err(e) if links::is_link_not_permitted(&e) => {
                self.report.skipped_links.push(shown.to_string());
                Ok(())
            }
            Err(e) => Err(write_error(shown, &e)),
        }
    }

    fn finish(self) -> Result<UnpackReport, DuetError> {
        self.dir_modes.apply()?;
        Ok(self.report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn windows(name: &str) -> Cow<'_, str> {
        entry_name::sanitize_name(name, true)
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    /// (이름, 내용) 목록 zip. `links` 는 (이름, 대상).
    fn zip_with(path: &Path, files: &[(&str, &[u8])], links: &[(&str, &str)]) {
        let mut w = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let o = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, data) in files {
            w.start_file(*name, o).unwrap();
            w.write_all(data).unwrap();
        }
        for (name, target) in links {
            w.add_symlink(*name, *target, o).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn zip_path_rules() {
        let p = |n: &str| zip_path(n, entry_name::sanitize_local_name).map(|(p, _)| p);
        assert_eq!(p("a/b.txt"), Some(PathBuf::from("a").join("b.txt")));
        assert_eq!(p("a\\b.txt"), Some(PathBuf::from("a").join("b.txt")));
        assert_eq!(p("/abs/x"), Some(PathBuf::from("abs").join("x")));
        assert_eq!(p("C:\\dir\\x"), Some(PathBuf::from("dir").join("x")));
        assert_eq!(p("../evil"), None);
        assert_eq!(p("a\\..\\..\\evil"), None);
        assert_eq!(p("a/\0b"), None);
        assert_eq!(p("/"), None);
    }

    #[test]
    fn windows_names_are_sanitized_and_reported() {
        let d = tempfile::tempdir().unwrap();
        let zp = d.path().join("w.zip");
        zip_with(
            &zp,
            &[
                ("log 10:00.txt", b"a"),
                ("CON.txt", b"b"),
                ("q?.txt", b"c"),
                ("ok.txt", b"d"),
            ],
            &[],
        );
        let out = d.path().join("out");
        std::fs::create_dir(&out).unwrap();
        let r = unpack_zip_with(&zp, &out, None, windows).unwrap();
        assert_eq!(
            names(&out),
            ["_CON.txt", "log 10_00.txt", "ok.txt", "q_.txt"]
        );
        let mut renamed = r.renamed.clone();
        renamed.sort();
        assert_eq!(renamed, ["CON.txt", "log 10:00.txt", "q?.txt"]);
    }

    /// zip 판 archive-01: 링크 항목 뒤에 그 링크를 거쳐 쓰는 항목 → 거부, 바깥 불변.
    #[cfg(unix)]
    #[test]
    fn zip_refuses_to_write_through_an_extracted_link() {
        let outside = tempfile::tempdir().unwrap();
        let d = tempfile::tempdir().unwrap();
        let zp = d.path().join("evil.zip");
        let target = outside.path().to_string_lossy().into_owned();
        // 링크를 먼저 쓰도록 순서를 맞춘다.
        let mut w = zip::ZipWriter::new(std::fs::File::create(&zp).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        w.add_symlink("escape", &target, o).unwrap();
        w.start_file("escape/pwned.txt", o).unwrap();
        w.write_all(b"x").unwrap();
        w.finish().unwrap();
        let out = d.path().join("out");
        std::fs::create_dir(&out).unwrap();
        let err = unpack_zip(&zp, &out, None).unwrap_err();
        assert!(matches!(err, DuetError::Io(m) if m.contains("through a link")));
        assert!(!outside.path().join("pwned.txt").exists());
    }

    /// 링크 자리에 같은 이름 일반 파일 → 링크를 따라가지 않고 교체, 바깥 파일 불변.
    #[cfg(unix)]
    #[test]
    fn zip_regular_file_over_link_does_not_follow() {
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim");
        std::fs::write(&victim, b"ORIGINAL").unwrap();
        let d = tempfile::tempdir().unwrap();
        let zp = d.path().join("evil.zip");
        // zip 작성기는 같은 이름을 거부한다 — 같은 길이의 다른 이름으로 쓴 뒤 바이트를 바꾼다.
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            w.add_symlink("SAMENAME1", victim.to_string_lossy(), o)
                .unwrap();
            w.start_file("SAMENAME2", o).unwrap();
            w.write_all(b"new").unwrap();
            w.finish().unwrap();
        }
        let bytes = buf.into_inner();
        let mut patched = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i..].starts_with(b"SAMENAME2") {
                patched.extend_from_slice(b"SAMENAME1");
                i += 9;
            } else {
                patched.push(bytes[i]);
                i += 1;
            }
        }
        std::fs::write(&zp, patched).unwrap();
        let out = d.path().join("out");
        std::fs::create_dir(&out).unwrap();
        unpack_zip(&zp, &out, None).unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"ORIGINAL");
        let x = out.join("SAMENAME1");
        assert!(std::fs::symlink_metadata(&x).unwrap().is_file());
        assert_eq!(std::fs::read(&x).unwrap(), b"new");
    }

    #[test]
    fn zip_skips_parent_dir_entries() {
        let d = tempfile::tempdir().unwrap();
        let zp = d.path().join("t.zip");
        zip_with(
            &zp,
            &[
                ("../evil.txt", b"e"),
                ("a\\..\\..\\evil2.txt", b"e"),
                ("ok.txt", b"k"),
            ],
            &[],
        );
        let out = d.path().join("out");
        std::fs::create_dir(&out).unwrap();
        unpack_zip(&zp, &out, None).unwrap();
        assert_eq!(names(&out), ["ok.txt"]);
        assert!(!d.path().join("evil.txt").exists());
        assert!(!d.path().join("evil2.txt").exists());
    }

    /// Windows 치환 뒤 같아지는 이름(`a:b.txt` → `a_b.txt`)이 앞 항목을 덮지 않는다(archive-17).
    #[test]
    fn names_equal_after_sanitizing_keep_both() {
        let d = tempfile::tempdir().unwrap();
        let zp = d.path().join("c.zip");
        zip_with(&zp, &[("a_b.txt", b"FIRST"), ("a:b.txt", b"SECOND")], &[]);
        let out = d.path().join("out");
        std::fs::create_dir(&out).unwrap();
        let r = unpack_zip_with(&zp, &out, None, windows).unwrap();
        assert_eq!(names(&out), ["a_b (2).txt", "a_b.txt"]);
        assert_eq!(std::fs::read(out.join("a_b.txt")).unwrap(), b"FIRST");
        assert_eq!(std::fs::read(out.join("a_b (2).txt")).unwrap(), b"SECOND");
        assert_eq!(r.renamed, ["a:b.txt"]);
    }

    fn sevenz_with(path: &Path, files: &[(&str, &[u8])]) {
        let mut w = sevenz_rust2::ArchiveWriter::create(path).unwrap();
        for (name, data) in files {
            w.push_archive_entry(
                sevenz_rust2::ArchiveEntry::new_file(name),
                Some(std::io::Cursor::new(data.to_vec())),
            )
            .unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn sevenz_windows_names_are_sanitized_and_reported() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("w.7z");
        sevenz_with(
            &p,
            &[("dir/a:b.txt", b"x"), ("aux", b"y"), ("plain.txt", b"z")],
        );
        let out = d.path().join("out");
        let r = unpack_sevenz_with(&p, &out, None, windows).unwrap();
        assert_eq!(names(&out), ["_aux", "dir", "plain.txt"]);
        assert_eq!(
            std::fs::read(out.join("dir").join("a_b.txt")).unwrap(),
            b"x"
        );
        let mut renamed = r.renamed.clone();
        renamed.sort();
        assert_eq!(renamed, ["aux", "dir/a:b.txt"]);
    }

    #[test]
    fn sevenz_backslash_names_make_folders() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("b.7z");
        sevenz_with(&p, &[("dir\\inner.txt", b"x")]);
        let out = d.path().join("out");
        unpack_sevenz(&p, &out, None).unwrap();
        assert_eq!(
            std::fs::read(out.join("dir").join("inner.txt")).unwrap(),
            b"x"
        );
    }

    #[test]
    fn sevenz_path_rejects_escapes() {
        let p = |n: &str| sevenz_path(n, entry_name::sanitize_local_name).map(|(p, _)| p);
        assert_eq!(p("a/b"), Some(PathBuf::from("a").join("b")));
        assert_eq!(p("../x"), None);
        assert_eq!(p("a\\..\\x"), None);
        assert_eq!(p("/abs"), None);
        assert_eq!(p("\\abs"), None);
        assert_eq!(p("C:\\x"), None);
    }
}
