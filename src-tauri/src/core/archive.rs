//! 아카이브 압축 해제 / 생성.
//!
//! 로컬은 Rust crate (`zip`/`tar` + 코덱 `flate2`/`bzip2`/`lzma-rust2`/`ruzstd`, 7z 는
//! `sevenz-rust2`, rar 는 `unrar`) 로, 원격(SSH)은 호스트의 `unzip`/`tar`/`zip` 을
//! russh exec 로 실행 (시스템 ssh 호출 X — CLAUDE.md §9). 원격은 zip·tar 계열만.
//! 같은-호스트 원칙: 원격 아카이브는 로컬 PC 를 경유하지 않고 호스트에서 직접 처리.
//!
//! plan/execute 두 단계 (CLAUDE.md §3/§4). execute 는 journal 에 기록하여
//! Ctrl+Z 되돌리기 가능 — 생성물(해제 디렉토리 / 압축 파일)을 제거하는 형태.

use crate::core::copy_strategy::{shell_escape_path, shell_escape_str};
use crate::core::ops::{self, OpCtx};
use crate::fs::{FileSystem, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::{BackupRestore, JournalEntry, OpKind, UndoAction};
use crate::ssh::remote_exec::{exec, ExecOutput};
use crate::types::{ConnectionId, DuetError, EntryKind, EntryRef, Location, SourceId};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// 지원 아카이브 포맷.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveFormat {
    Zip,
    Tar,
    TarGz,
    /// `.tar.bz2` / `.tbz2` / `.tbz`.
    TarBz2,
    /// `.tar.xz` / `.txz`.
    TarXz,
    /// `.tar.zst` / `.tzst`.
    TarZst,
    /// 단일 파일 gzip (`file.txt.gz`).
    Gz,
    /// 단일 파일 bzip2 (`file.txt.bz2`).
    Bz2,
    /// 단일 파일 xz (`file.txt.xz`).
    Xz,
    /// 단일 파일 zstd (`file.txt.zst`).
    Zst,
    /// 7-Zip — 읽기 전용(browse/extract). 생성/repack 비대상. 로컬 전용(원격 호스트에
    /// 7z 바이너리 보장 못 함).
    SevenZ,
    /// RAR — 읽기 전용(공식 unrar 라이브러리 라이선스상 생성 불가). 로컬 전용.
    Rar,
}

/// 압축 생성 포맷 (UI 선택). `Gz` 는 단일 파일 전용이라 생성 대상에서 제외.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CompressFormat {
    Zip,
    TarGz,
}

impl CompressFormat {
    /// 기본 확장자 (앞 `.` 포함).
    pub fn extension(self) -> &'static str {
        match self {
            CompressFormat::Zip => ".zip",
            CompressFormat::TarGz => ".tar.gz",
        }
    }
}

/// tar 스트림·단일 파일에 씌운 압축 코덱.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Codec {
    Gzip,
    Bzip2,
    Xz,
    Zstd,
}

/// 포맷의 구조 — 해제·호스트 명령 분기를 포맷 12종이 아니라 이 갈래로 한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Layout {
    Zip,
    /// tar + 압축 코덱 (무압축 tar 는 None).
    Tar(Option<Codec>),
    /// 압축된 단일 파일 — 풀면 파일 하나.
    Single(Codec),
    SevenZ,
    Rar,
}

impl ArchiveFormat {
    fn layout(self) -> Layout {
        match self {
            ArchiveFormat::Zip => Layout::Zip,
            ArchiveFormat::Tar => Layout::Tar(None),
            ArchiveFormat::TarGz => Layout::Tar(Some(Codec::Gzip)),
            ArchiveFormat::TarBz2 => Layout::Tar(Some(Codec::Bzip2)),
            ArchiveFormat::TarXz => Layout::Tar(Some(Codec::Xz)),
            ArchiveFormat::TarZst => Layout::Tar(Some(Codec::Zstd)),
            ArchiveFormat::Gz => Layout::Single(Codec::Gzip),
            ArchiveFormat::Bz2 => Layout::Single(Codec::Bzip2),
            ArchiveFormat::Xz => Layout::Single(Codec::Xz),
            ArchiveFormat::Zst => Layout::Single(Codec::Zstd),
            ArchiveFormat::SevenZ => Layout::SevenZ,
            ArchiveFormat::Rar => Layout::Rar,
        }
    }

    /// 원격(SSH) 호스트에서 해제·탐색 가능한지 — 호스트의 `unzip`/`tar` 로 풀리는 zip·tar
    /// 계열만. 7z/rar(호스트 바이너리 보장 불가)와 단일 파일 압축은 로컬 전용.
    pub fn supports_remote(self) -> bool {
        matches!(self.layout(), Layout::Zip | Layout::Tar(_))
    }

    /// 편집 후 재압축(repack)에 쓸 생성 포맷 — 원본과 같은 포맷으로 다시 만들 수 있는
    /// zip·tar.gz 만. 나머지는 사용자 파일 포맷을 임의로 바꾸지 않도록 None.
    pub fn repack_format(self) -> Option<CompressFormat> {
        match self {
            ArchiveFormat::Zip => Some(CompressFormat::Zip),
            ArchiveFormat::TarGz => Some(CompressFormat::TarGz),
            _ => None,
        }
    }
}

/// 확장자(소문자, 앞 `.` 포함) → 포맷. **긴 접미사가 먼저** — `.tar.gz` 가 `.gz` 보다
/// 앞서야 `data.tar.gz` 가 단일 파일 gzip 으로 오판되지 않는다. 판정과 해제 이름 도출이
/// 이 표 하나를 쓴다. 프론트 `src/lib/archive.ts` 도 같은 집합을 들고 있어 테스트
/// (`frontend_archive_lists_match_backend`)로 대조한다.
const SUFFIXES: &[(&str, ArchiveFormat)] = &[
    (".tar.gz", ArchiveFormat::TarGz),
    (".tgz", ArchiveFormat::TarGz),
    (".tar.bz2", ArchiveFormat::TarBz2),
    (".tbz2", ArchiveFormat::TarBz2),
    (".tbz", ArchiveFormat::TarBz2),
    (".tar.xz", ArchiveFormat::TarXz),
    (".txz", ArchiveFormat::TarXz),
    (".tar.zst", ArchiveFormat::TarZst),
    (".tzst", ArchiveFormat::TarZst),
    (".tar", ArchiveFormat::Tar),
    (".zip", ArchiveFormat::Zip),
    (".7z", ArchiveFormat::SevenZ),
    (".rar", ArchiveFormat::Rar),
    (".gz", ArchiveFormat::Gz),
    (".bz2", ArchiveFormat::Bz2),
    (".xz", ArchiveFormat::Xz),
    (".zst", ArchiveFormat::Zst),
];

/// name 에 맞는 접미사와 포맷 (대소문자 무시). 아카이브가 아니면 None.
fn match_suffix(name: &str) -> Option<(&'static str, ArchiveFormat)> {
    let lower = name.to_ascii_lowercase();
    SUFFIXES
        .iter()
        .find(|(suf, _)| lower.ends_with(suf))
        .copied()
}

/// 파일 이름 확장자로 아카이브 포맷 판정. 아카이브가 아니면 None.
pub fn detect_format(name: &str) -> Option<ArchiveFormat> {
    match_suffix(name).map(|(_, fmt)| fmt)
}

/// 아카이브 이름에서 해제 결과 이름 도출 (`data.tar.gz` → `data`, `log.txt.gz` → `log.txt`).
/// 알려진 확장자가 없거나 결과가 비면 `<name>.extracted`.
pub fn archive_stem(name: &str) -> String {
    if let Some((suf, _)) = match_suffix(name) {
        // 접미사가 ASCII 라 소문자화 전후 바이트 길이가 같다 — 원본 name 을 그대로 자른다.
        let stem = &name[..name.len() - suf.len()];
        if !stem.is_empty() {
            return stem.to_string();
        }
    }
    crate::fs::suffixed_name(name, ".extracted")
}

// === Extract ===

/// 압축 해제 계획 — UI 가 대상/충돌 표시.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ExtractPlan {
    pub source: SourceId,
    /// 아카이브가 위치한 디렉토리.
    pub archive_dir: Location,
    pub archive_name: String,
    pub format: ArchiveFormat,
    /// 해제 결과 위치 — 보통 새로 만들 디렉토리(`archive_dir/<stem>`). 단일 파일 압축
    /// (`.gz`/`.bz2`/`.xz`/`.zst`)은 폴더 없이 풀린 파일 경로(`archive_dir/<stem>`) 자체.
    pub dest_dir: std::path::PathBuf,
    /// dest_dir 가 이미 존재 (execute 시 backup 후 진행).
    pub conflict: bool,
}

pub async fn extract_plan(
    fs: &dyn FileSystem,
    archive: EntryRef,
) -> Result<ExtractPlan, DuetError> {
    let format = detect_format(&archive.name)
        .ok_or_else(|| DuetError::Io(format!("unsupported archive: {}", archive.name)))?;
    // 원격은 호스트 unzip/tar 로 풀리는 포맷만 — 충돌 백업 등 아무것도 건드리기 전에 거부.
    if matches!(archive.location.source, SourceId::Ssh { .. }) && !format.supports_remote() {
        return Err(remote_unsupported());
    }
    // fs.join — 원격은 POSIX, 로컬은 네이티브. PathBuf::join 은 Windows 클라이언트에서
    // 원격 경로에 `\` 를 섞는다(§7).
    let archive_path = fs.join(&archive.location.path, &archive.name);
    let meta = fs.metadata(&archive_path).await?;
    if meta.kind != EntryKind::File {
        return Err(DuetError::Io("not a regular file".into()));
    }
    let stem = archive_stem(&archive.name);
    let dest_dir = fs.join(&archive.location.path, &stem);
    let conflict = fs.metadata(&dest_dir).await.is_ok();
    Ok(ExtractPlan {
        source: archive.location.source.clone(),
        archive_dir: archive.location.clone(),
        archive_name: archive.name,
        format,
        dest_dir,
        conflict,
    })
}

pub async fn extract_execute(
    fs: &dyn FileSystem,
    plan: ExtractPlan,
    password: Option<String>,
    ctx: &OpCtx,
    cancel_token: CancellationToken,
) -> Result<JournalEntry, DuetError> {
    let archive_path = fs.join(&plan.archive_dir.path, &plan.archive_name);

    // dest 충돌 → backup 으로 mv (undo 시 복원).
    let mut backups = Vec::new();
    if fs.metadata(&plan.dest_dir).await.is_ok() {
        let parent = plan
            .dest_dir
            .parent()
            .unwrap_or(plan.archive_dir.path.as_path());
        let name = plan
            .dest_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("extracted");
        let backup = ops::pick_backup_path(fs, parent, name).await?;
        fs.rename(&plan.dest_dir, &backup).await?;
        backups.push(BackupRestore {
            backup_path: backup,
            original_path: plan.dest_dir.clone(),
        });
    }

    // mkdir 이후의 실패(암호 zip 의 NeedPassword, 취소 등)는 아래에서 롤백 — 안 하면
    // 빈/부분 dest 폴더가 남고, 충돌로 옮겨둔 기존 폴더도 backup 이름에 갇힌다.
    // 단일 파일 압축(.gz 등)은 폴더 없이 archive_dir 에 `<stem>` 파일로 바로 푼다
    // (예전엔 `log.txt/log.txt` 처럼 폴더가 한 겹 더 생겼다). 그 경로가 plan.dest_dir.
    let single = matches!(plan.format.layout(), Layout::Single(_));
    let extracted: Result<(), DuetError> = async {
        if !single {
            fs.mkdir(&plan.dest_dir).await?;
        }

        if cancel_token.is_cancelled() {
            return Err(DuetError::Cancelled);
        }

        match &plan.source {
            SourceId::Local => {
                let into = if single {
                    plan.archive_dir.path.as_path()
                } else {
                    plan.dest_dir.as_path()
                };
                extract_local(&archive_path, into, plan.format, password).await
            }
            SourceId::Ssh { connection_id, .. } => {
                let pool = ctx.pool.as_ref().ok_or_else(|| {
                    DuetError::Io("OpCtx.pool required for remote extract".into())
                })?;
                extract_remote(
                    pool,
                    connection_id,
                    &archive_path,
                    &plan.dest_dir,
                    plan.format,
                    password.as_deref(),
                )
                .await
            }
        }
    }
    .await;
    if let Err(e) = extracted {
        // 이 op 가 방금 만든 dest 만 제거 — Replace 백업 정리와 동일한 내부 rollback
        // 경로(fs.remove). 롤백 자체의 실패는 원인 에러를 가리지 않도록 무시.
        let _ = fs.remove(&plan.dest_dir).await;
        for b in &backups {
            let _ = fs.rename(&b.backup_path, &b.original_path).await;
        }
        return Err(e);
    }

    // undo = 생성된 dest_dir 제거 + backup 복원 (UndoCopy 재사용).
    // 아카이브 추출은 파일 원본이 없어 redo 불가 — src 기록 생략.
    let undo = UndoAction::UndoCopy {
        target_source: plan.source.clone(),
        copied: vec![plan.dest_dir.clone()],
        backups_to_restore: backups,
        src_source: None,
        copied_from: Vec::new(),
    };
    let op = OpKind::Extract {
        archive: Location {
            source: plan.source.clone(),
            path: archive_path,
        },
        dest: Location {
            source: plan.source.clone(),
            path: plan.dest_dir,
        },
    };
    ctx.journal.push(op, undo).await
}

/// 로컬 아카이브 해제 — blocking IO 라 spawn_blocking. `password` 는 암호 zip 용(없으면 None).
async fn extract_local(
    archive: &Path,
    dest: &Path,
    fmt: ArchiveFormat,
    password: Option<String>,
) -> Result<(), DuetError> {
    let archive = archive.to_path_buf();
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || {
        extract_local_blocking(&archive, &dest, fmt, password.as_deref())
    })
    .await
    .map_err(|e| DuetError::Io(format!("extract task join: {e}")))?
}

fn extract_local_blocking(
    archive: &Path,
    dest: &Path,
    fmt: ArchiveFormat,
    password: Option<&str>,
) -> Result<(), DuetError> {
    let file =
        std::fs::File::open(archive).map_err(|e| DuetError::Io(format!("open archive: {e}")))?;
    match fmt.layout() {
        Layout::Zip => {
            let mut zip =
                zip::ZipArchive::new(file).map_err(|e| DuetError::Io(format!("zip open: {e}")))?;
            // 암호화 항목이 하나라도 있으면(by_index_raw=복호화 안 함) 암호 경로로.
            let encrypted =
                (0..zip.len()).any(|i| zip.by_index_raw(i).map(|e| e.encrypted()).unwrap_or(false));
            if encrypted {
                let pw = password.ok_or(DuetError::NeedPassword)?;
                extract_zip_with_password(&mut zip, dest, pw)?;
            } else {
                // zip crate 의 extract 는 enclosed_name 으로 zip-slip 방지.
                zip.extract(dest)
                    .map_err(|e| DuetError::Io(format!("zip extract: {e}")))?;
            }
        }
        Layout::Tar(codec) => {
            let mut tar = tar::Archive::new(decode_reader(file, codec)?);
            tar.unpack(dest)
                .map_err(|e| DuetError::Io(format!("tar extract: {e}")))?;
        }
        Layout::Single(codec) => {
            // 단일 파일 → dest/<압축 확장자 뗀 이름>.
            let out_name = archive
                .file_name()
                .and_then(|s| s.to_str())
                .map(archive_stem)
                .ok_or_else(|| DuetError::Io("invalid archive name".into()))?;
            let mut reader = decode_reader(file, Some(codec))?;
            let mut out = std::fs::File::create(dest.join(out_name))
                .map_err(|e| DuetError::Io(format!("create output: {e}")))?;
            std::io::copy(&mut reader, &mut out)
                .map_err(|e| DuetError::Io(format!("decompress: {e}")))?;
        }
        // 경로 기반 API — 위에서 연 file 은 사용 안 함(존재/읽기 가능 검증만 겸함).
        Layout::SevenZ => extract_sevenz(archive, dest, password)?,
        Layout::Rar => extract_rar(archive, dest, password)?,
    }
    Ok(())
}

/// 코덱에 맞는 스트리밍 해제 reader (None = 무압축 tar). 멤버·스트림·프레임이 여러 개
/// 이어 붙은 파일도 끝까지 푼다 — `gzip -d`·`bzip2 -d`·`xz -d`·`zstd -d` 와 같은 의미.
fn decode_reader(file: std::fs::File, codec: Option<Codec>) -> Result<Box<dyn Read>, DuetError> {
    let buf = std::io::BufReader::new(file);
    Ok(match codec {
        None => Box::new(buf),
        Some(Codec::Gzip) => Box::new(flate2::bufread::MultiGzDecoder::new(buf)),
        Some(Codec::Bzip2) => Box::new(bzip2::bufread::MultiBzDecoder::new(buf)),
        Some(Codec::Xz) => Box::new(lzma_rust2::XzReader::new(buf, true)),
        Some(Codec::Zstd) => Box::new(ZstdFrames::new(buf)?),
    })
}

/// 여러 프레임이 이어 붙은 zstd 스트림 reader. ruzstd `StreamingDecoder` 는 프레임
/// 하나만 풀므로, 한 프레임이 끝나면 입력이 남아 있는 한 다음 프레임을 이어 연다.
struct ZstdFrames<R: BufRead> {
    /// 현재 프레임 디코더 — 입력을 다 읽으면 None.
    frame: Option<ruzstd::decoding::StreamingDecoder<R, ruzstd::decoding::FrameDecoder>>,
}

impl<R: BufRead> ZstdFrames<R> {
    fn new(inner: R) -> Result<Self, DuetError> {
        let frame = ruzstd::decoding::StreamingDecoder::new(inner)
            .map_err(|e| DuetError::Io(format!("zstd: {e}")))?;
        Ok(Self { frame: Some(frame) })
    }
}

impl<R: BufRead> Read for ZstdFrames<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while let Some(frame) = self.frame.as_mut() {
            let n = frame.read(buf)?;
            if n > 0 || buf.is_empty() {
                return Ok(n);
            }
            // 프레임 끝 — 남은 입력이 있으면 다음 프레임, 없으면 EOF.
            let mut inner = match self.frame.take() {
                Some(done) => done.into_inner(),
                None => break,
            };
            if inner.fill_buf()?.is_empty() {
                return Ok(0);
            }
            let next = ruzstd::decoding::StreamingDecoder::new(inner)
                .map_err(|e| std::io::Error::other(format!("zstd: {e}")))?;
            self.frame = Some(next);
        }
        Ok(0)
    }
}

/// 7z 해제 — sevenz-rust2 (순수 Rust). 암호 아카이브인데 password 없으면 NeedPassword.
fn extract_sevenz(archive: &Path, dest: &Path, password: Option<&str>) -> Result<(), DuetError> {
    let result = match password {
        Some(pw) => sevenz_rust2::decompress_file_with_password(archive, dest, pw.into()),
        None => sevenz_rust2::decompress_file(archive, dest),
    };
    result.map_err(|e| {
        let msg = e.to_string();
        // 라이브러리가 암호 필요/오류를 별도 variant 로 항상 안 주므로 메시지로 판정.
        if msg.to_ascii_lowercase().contains("password") {
            DuetError::NeedPassword
        } else {
            DuetError::Io(format!("7z extract: {msg}"))
        }
    })
}

/// rar 해제 — 공식 unrar 라이브러리 래퍼(읽기 전용).
///
/// 1) 목록 패스로 항목 경로 검증(절대경로/`..` 탈출 거부 — C 라이브러리 추출을
///    신뢰하기 전 자체 rar-slip 방어) 후 2) 처리 패스로 dest 아래 스트리밍 추출.
fn extract_rar(archive: &Path, dest: &Path, password: Option<&str>) -> Result<(), DuetError> {
    let listing = rar_archive(archive, password)?
        .open_for_listing()
        .map_err(map_rar_err)?;
    for item in listing {
        let header = item.map_err(map_rar_err)?;
        let name = &header.filename;
        let unsafe_path = name.is_absolute()
            || name
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir));
        if unsafe_path {
            return Err(DuetError::Io(format!(
                "unsafe path in rar: {}",
                name.display()
            )));
        }
    }
    let mut arch = rar_archive(archive, password)?
        .open_for_processing()
        .map_err(map_rar_err)?;
    while let Some(header) = arch.read_header().map_err(map_rar_err)? {
        arch = if header.entry().is_file() {
            header.extract_with_base(dest).map_err(map_rar_err)?
        } else {
            header.skip().map_err(map_rar_err)?
        };
    }
    Ok(())
}

fn rar_archive<'a>(
    archive: &'a Path,
    password: Option<&'a str>,
) -> Result<unrar::Archive<'a>, DuetError> {
    Ok(match password {
        Some(pw) => unrar::Archive::with_password(archive, pw),
        None => unrar::Archive::new(archive),
    })
}

fn map_rar_err(e: unrar::error::UnrarError) -> DuetError {
    use unrar::error::Code;
    match e.code {
        Code::MissingPassword | Code::BadPassword => DuetError::NeedPassword,
        _ => DuetError::Io(format!("rar: {e}")),
    }
}

/// 암호 zip 해제 — 각 항목을 by_index_decrypt 로 복호화해 zip-slip 안전하게 dest 에 쓴다.
/// (zip crate 의 extract() 는 암호를 못 받으므로 수동.) 암호 틀림은 NeedPassword.
fn extract_zip_with_password(
    zip: &mut zip::ZipArchive<std::fs::File>,
    dest: &Path,
    password: &str,
) -> Result<(), DuetError> {
    for i in 0..zip.len() {
        let mut entry = match zip.by_index_decrypt(i, password.as_bytes()) {
            Ok(e) => e,
            Err(zip::result::ZipError::InvalidPassword) => return Err(DuetError::NeedPassword),
            Err(e) => return Err(DuetError::Io(format!("zip decrypt: {e}"))),
        };
        // enclosed_name = zip-slip 안전 상대경로(.. 탈출 시 None → 건너뜀).
        let out = match entry.enclosed_name() {
            Some(rel) => dest.join(rel),
            None => continue,
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| DuetError::Io(format!("mkdir: {e}")))?;
        } else {
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p).map_err(|e| DuetError::Io(format!("mkdir: {e}")))?;
            }
            let mut f =
                std::fs::File::create(&out).map_err(|e| DuetError::Io(format!("create: {e}")))?;
            std::io::copy(&mut entry, &mut f).map_err(|e| DuetError::Io(format!("write: {e}")))?;
        }
    }
    Ok(())
}

/// 호스트의 unzip/tar 해제 명령 문자열 (인자 shell-escape). 원격은 zip·tar 계열만.
/// `password` 가 있으면 zip 은 `unzip -P`. 암호 zip 인데 password 없으면 `-P ""` 로
/// (대화형 프롬프트 hang 방지 — 틀린 암호로 즉시 실패해 caller 가 NeedPassword 판정).
fn remote_extract_command(
    archive: &Path,
    dest: &Path,
    fmt: ArchiveFormat,
    password: Option<&str>,
) -> Result<String, DuetError> {
    let a = shell_escape_path(archive)?;
    let d = shell_escape_path(dest)?;
    Ok(match fmt.layout() {
        Layout::Zip => {
            let p = shell_escape_str(password.unwrap_or(""))?;
            format!("unzip -P {p} -o {a} -d {d}")
        }
        Layout::Tar(codec) => format!("tar {}-xf {a} -C {d}", tar_codec_flag(codec)),
        Layout::Single(_) | Layout::SevenZ | Layout::Rar => return Err(remote_unsupported()),
    })
}

/// 호스트 tar 의 압축 해제 옵션 (뒤 공백 포함, 무압축은 빈 문자열). GNU tar·bsdtar 공통:
/// `-z` gzip, `-j` bzip2, `-J` xz, `--zstd` zstd (GNU tar 1.31+ / libarchive 3.3.3+).
fn tar_codec_flag(codec: Option<Codec>) -> &'static str {
    match codec {
        None => "",
        Some(Codec::Gzip) => "-z ",
        Some(Codec::Bzip2) => "-j ",
        Some(Codec::Xz) => "-J ",
        Some(Codec::Zstd) => "--zstd ",
    }
}

/// 원격에서 처리하지 않는 포맷의 에러 — 호스트에 7z/unrar 바이너리를 보장 못 하고,
/// 단일 파일 압축은 원격 해제 경로를 두지 않았다.
fn remote_unsupported() -> DuetError {
    DuetError::NotSupported(
        "remote extract supports only zip/tar archives (7z, rar, .gz/.bz2/.xz/.zst are local only)"
            .into(),
    )
}

/// 이 포맷을 원격에서 처리하는 호스트 프로그램 — exit 127(설치 안 됨) 안내용.
fn host_prog(fmt: ArchiveFormat) -> &'static str {
    match fmt.layout() {
        Layout::Zip => "unzip",
        _ => "tar",
    }
}

/// 호스트 셸 명령을 russh exec 로 실행하고 출력 반환 (시스템 ssh X). exit 판정은 caller.
async fn exec_on_host(
    pool: &Arc<ConnectionPool>,
    connection_id: &ConnectionId,
    cmd: &str,
) -> Result<ExecOutput, DuetError> {
    let conn = pool.get(connection_id).await?;
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;
    let handle = session_mutex.lock().await;
    exec(&handle, cmd).await
}

/// 호스트 명령 실패(exit != 0)를 에러로. `prog` 는 이 명령이 요구하는 호스트 프로그램 —
/// 셸 exit 127(command not found)이면 셸 원문 대신 "서버에 설치 안 됨" 으로 안내한다
/// (최소 설치 리눅스엔 unzip/zip 이 없는 경우가 흔하다).
fn host_failure(out: &ExecOutput, prog: &str) -> DuetError {
    if out.exit_status == 127 {
        return DuetError::NotSupported(format!("`{prog}` is not installed on the remote host"));
    }
    DuetError::Ssh(format!(
        "host command failed (exit {}): {}",
        out.exit_status,
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

/// 한 호스트 셸 명령을 실행 (exit!=0 → 에러). `prog` 는 [`host_failure`] 안내용.
async fn run_host_command(
    pool: &Arc<ConnectionPool>,
    connection_id: &ConnectionId,
    cmd: &str,
    prog: &str,
) -> Result<(), DuetError> {
    let out = exec_on_host(pool, connection_id, cmd).await?;
    if out.exit_status != 0 {
        return Err(host_failure(&out, prog));
    }
    Ok(())
}

/// zip 추출용 호스트 명령 실행 — Info-ZIP `unzip` 의 exit 코드를 매핑한다.
/// - 82(bad decryption password) → `NeedPassword` (프론트가 암호를 받아 재시도)
/// - 81(unsupported compression/decryption) → `NotSupported`. 대표적으로 AES 암호 zip —
///   Info-ZIP 6.0 은 AES 를 못 풀어 암호가 맞아도 81("need PK compat. v5.1")이라
///   암호를 다시 묻는 건 소용없다.
///
/// 다른 unzip 구현이 이 코드를 안 쓰면 일반 에러로 폴백(best-effort).
async fn run_unzip_command(
    pool: &Arc<ConnectionPool>,
    connection_id: &ConnectionId,
    cmd: &str,
) -> Result<(), DuetError> {
    let out = exec_on_host(pool, connection_id, cmd).await?;
    match out.exit_status {
        0 => Ok(()),
        82 => Err(DuetError::NeedPassword),
        81 => Err(DuetError::NotSupported(
            "the remote host's unzip cannot extract this zip (AES encryption or an unsupported compression method)"
                .into(),
        )),
        _ => Err(host_failure(&out, "unzip")),
    }
}

/// 아카이브 엔트리가 추출 dest 밖으로 탈출하는지 — 절대경로(`/`·`\\`·드라이브)거나
/// `..` 컴포넌트 포함. zip-slip / 절대경로 덮어쓰기 차단용.
fn entry_escapes(entry: &str) -> bool {
    if entry.starts_with('/') || entry.starts_with('\\') {
        return true;
    }
    // Windows 드라이브 (C:\ 등) — 원격은 POSIX 지만 방어적으로.
    let bytes = entry.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return true;
    }
    entry.split(['/', '\\']).any(|comp| comp == "..")
}

/// 호스트의 아카이브 *목록* 명령 (이름만). 추출 전 검증용.
fn remote_list_command(archive: &Path, fmt: ArchiveFormat) -> Result<String, DuetError> {
    let a = shell_escape_path(archive)?;
    Ok(match fmt.layout() {
        Layout::Zip => format!("unzip -Z1 {a}"),
        Layout::Tar(codec) => format!("tar {}-tf {a}", tar_codec_flag(codec)),
        Layout::Single(_) | Layout::SevenZ | Layout::Rar => return Err(remote_unsupported()),
    })
}

/// 한 호스트 셸 명령을 실행하고 stdout 반환 (exit!=0 → 에러). `prog` 는 [`host_failure`] 안내용.
async fn run_host_command_stdout(
    pool: &Arc<ConnectionPool>,
    connection_id: &ConnectionId,
    cmd: &str,
    prog: &str,
) -> Result<String, DuetError> {
    let out = exec_on_host(pool, connection_id, cmd).await?;
    if out.exit_status != 0 {
        return Err(host_failure(&out, prog));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 원격 추출 전 아카이브 엔트리를 나열해 dest 밖으로 탈출하는 항목을 거부한다.
/// host-side tar/unzip 의 버전별 보호 동작에 의존하지 않고 명시적으로 zip-slip 을 차단.
/// (로컬 경로의 zip crate `enclosed_name` 방어와 의미를 맞춤.)
async fn validate_remote_archive(
    pool: &Arc<ConnectionPool>,
    connection_id: &ConnectionId,
    archive: &Path,
    fmt: ArchiveFormat,
) -> Result<(), DuetError> {
    let list_cmd = remote_list_command(archive, fmt)?;
    let listing = run_host_command_stdout(pool, connection_id, &list_cmd, host_prog(fmt)).await?;
    for entry in listing.lines() {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if entry_escapes(entry) {
            return Err(DuetError::Io(format!(
                "archive contains path-traversal entry (zip-slip), refusing to extract: {entry}"
            )));
        }
    }
    Ok(())
}

/// 원격 아카이브 해제 — 호스트의 unzip/tar 를 exec (dest 는 caller 가 생성).
async fn extract_remote(
    pool: &Arc<ConnectionPool>,
    connection_id: &ConnectionId,
    archive: &Path,
    dest: &Path,
    fmt: ArchiveFormat,
    password: Option<&str>,
) -> Result<(), DuetError> {
    validate_remote_archive(pool, connection_id, archive, fmt).await?;
    let cmd = remote_extract_command(archive, dest, fmt, password)?;
    // zip 은 암호 실패(unzip exit 82)를 NeedPassword 로 — 프론트 재시도.
    match fmt.layout() {
        Layout::Zip => run_unzip_command(pool, connection_id, &cmd).await,
        _ => run_host_command(pool, connection_id, &cmd, host_prog(fmt)).await,
    }
}

// === Browse (투명 임시추출 — 탐색기처럼 내부 열람) ===

/// 아카이브를 임시 위치로 풀고, 그 디렉토리의 `Location` 을 반환.
///
/// 패널이 이 Location 으로 navigate 하면 *실제 폴더* 라서 탐색/미리보기/
/// 복사·이동/DnD/북마크가 전부 그대로 동작 (Location 모델 변경 없음).
///
/// - 로컬: `<temp>/duet-archive/<token>/content/` 로 crate 추출.
/// - 원격(SSH): 호스트의 `~/.duet-tmp/browse-<token>/content/` 로 host-side 추출
///   (unzip/tar exec). **로컬 PC 를 1 바이트도 경유하지 않음** — 같은-호스트 원칙.
///   반환 Location 은 같은 `Ssh{}` source 라 패널이 그대로 원격을 탐색.
///
/// browse-only(비파괴) 라 journal 기록 없음.
///
/// `password` 는 암호 zip 용 — 없거나 틀리면 `NeedPassword` 를 반환하고, 프론트가
/// 암호를 받아 같은 아카이브로 재호출한다(extract 와 동일한 재시도 흐름).
pub async fn open_for_browse(
    archive: EntryRef,
    password: Option<String>,
    pool: &Arc<ConnectionPool>,
) -> Result<Location, DuetError> {
    let format = detect_format(&archive.name)
        .ok_or_else(|| DuetError::Io(format!("unsupported archive: {}", archive.name)))?;
    let archive_path = archive.location.path.join(&archive.name);
    let token = uuid::Uuid::new_v4().to_string();

    match &archive.location.source {
        SourceId::Local => {
            // token 디렉토리째 만들고, 추출 실패(예: NeedPassword) 시 통째로 정리해
            // 빈 temp 가 새지 않게 한다(재시도는 새 token 으로 들어온다).
            let token_dir = local_browse_root().join(&token);
            // 원본 이름을 반복하면 긴 이름 + 내부 경로가 OS 경로 길이 제한에 닿는다.
            let dest = token_dir.join("content");
            tokio::fs::create_dir_all(&dest)
                .await
                .map_err(|e| DuetError::Io(format!("create temp dir: {e}")))?;
            if let Err(e) = extract_local(&archive_path, &dest, format, password).await {
                let _ = tokio::fs::remove_dir_all(&token_dir).await;
                return Err(e);
            }
            Ok(Location {
                source: SourceId::Local,
                path: dest,
            })
        }
        SourceId::Ssh { connection_id, .. } => {
            // 추출 전 zip-slip 검증 (extract_remote 와 동일 가드 — browse 도 호스트에 씀).
            validate_remote_archive(pool, connection_id, &archive_path, format).await?;
            // 호스트 home 아래 임시 디렉토리 — 절대경로로 만들어 shell-escape.
            let conn = pool.get(connection_id).await?;
            let home = SshFs::new(conn).home().await?;
            // posix_join — 반환되어 reap·표시에 쓰이므로 Windows 클라이언트의 `\` 회피(§7).
            let mut dest = crate::fs::posix_join(&home, ".duet-tmp");
            dest = crate::fs::posix_join(&dest, &format!("browse-{token}"));
            let dest = crate::fs::posix_join(&dest, "content");
            // mkdir -p + 추출을 한 호스트 명령으로 (PC 경유 0).
            let cmd = format!(
                "mkdir -p {} && {}",
                shell_escape_path(&dest)?,
                remote_extract_command(&archive_path, &dest, format, password.as_deref())?,
            );
            // zip 은 암호 실패(unzip exit 82)를 NeedPassword 로 — 프론트 재시도.
            match format.layout() {
                Layout::Zip => run_unzip_command(pool, connection_id, &cmd).await?,
                _ => run_host_command(pool, connection_id, &cmd, host_prog(format)).await?,
            }
            Ok(Location {
                source: archive.location.source.clone(),
                path: dest,
            })
        }
    }
}

// === Browse 임시폴더 reap (Phase 2) ===
//
// browse 임시 디렉토리는 *앱 소유 ephemeral 추출물* 이지 사용자 데이터가 아니므로
// CLAUDE.md §3(삭제=휴지통) 의 예외다 — journal 안 쓰고 직접 제거. 로컬은 시작 시
// 전체 정리, 원격은 연결 종료 직전 세션이 살아있을 때 정확한 경로만 reap.

/// 로컬 아카이브 browse 임시 루트 (`<temp>/duet-archive`).
pub fn local_browse_root() -> PathBuf {
    std::env::temp_dir().join("duet-archive")
}

/// 시작 시 호출 — 이전 실행/크래시에서 남은 로컬 browse 임시 디렉토리를 비운다.
/// best-effort: 없으면 no-op, 실패해도 무시. 단일 인스턴스 운용 가정.
pub async fn reap_local_browse_root() {
    let _ = tokio::fs::remove_dir_all(local_browse_root()).await;
}

/// reap 안전 가드: 경로가 `.../.duet-tmp/browse-<...>` 형태인지 (탈출 방지).
fn is_safe_browse_root(root: &Path) -> bool {
    let name_ok = root
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("browse-"));
    let parent_ok = root
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == ".duet-tmp");
    name_ok && parent_ok
}

/// 연결 종료 직전 호출 — 이 연결로 만든 원격 browse 임시 루트들을 host-side 에서
/// 제거 (세션이 살아있는 동안 russh exec, §9). best-effort. `.duet-tmp/browse-*`
/// 형태만 rm 하여 경로 탈출을 막는다. 비의도적 disconnect 면 세션이 죽어 reap 불가
/// → 해당 host temp 는 orphan 으로 남는다(후속 정리/호스트 tmp 정책에 의존).
pub async fn reap_remote_browse_dirs(
    pool: &Arc<ConnectionPool>,
    connection_id: &ConnectionId,
    roots: &[PathBuf],
) {
    for root in roots {
        if !is_safe_browse_root(root) {
            continue;
        }
        let Ok(escaped) = shell_escape_path(root) else {
            continue;
        };
        let _ = run_host_command(pool, connection_id, &format!("rm -rf {escaped}"), "rm").await;
    }
}

// === Compress ===

/// 압축 생성 계획.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CompressPlan {
    pub source: SourceId,
    /// 압축 대상 항목들이 위치한 디렉토리.
    pub src_dir: Location,
    pub item_names: Vec<String>,
    pub format: CompressFormat,
    /// 생성될 아카이브 경로 (`src_dir/<name><ext>`).
    pub dest_path: std::path::PathBuf,
    /// dest_path 가 이미 존재 (execute 시 backup 후 진행).
    pub conflict: bool,
}

/// 압축 대상 검증 + dest 경로/충돌 계산.
pub async fn compress_plan(
    fs: &dyn FileSystem,
    items: Vec<EntryRef>,
    archive_name: String,
    format: CompressFormat,
) -> Result<CompressPlan, DuetError> {
    if items.is_empty() {
        return Err(DuetError::Io("no items".into()));
    }
    let src_dir = items[0].location.clone();
    for it in &items {
        if it.location.path != src_dir.path || it.location.source != src_dir.source {
            return Err(DuetError::Io("items must share directory".into()));
        }
    }
    // 파일명만 허용 — 경로 구분자('/' 또는 Windows '\')가 섞이면 거부.
    // FE 가 잘못된 basename(예: Windows 전체경로)을 보내도 join 이 대상 폴더 밖/
    // 드라이브 절대경로로 새지 않게 하는 방어선.
    if archive_name.is_empty() || archive_name.contains('/') || archive_name.contains('\\') {
        return Err(DuetError::Io(format!("invalid name: {archive_name}")));
    }
    // 확장자 자동 부여 (이미 있으면 중복 안 함).
    let ext = format.extension();
    let file_name = if archive_name.to_ascii_lowercase().ends_with(ext) {
        archive_name
    } else {
        format!("{archive_name}{ext}")
    };
    // fs.join — 원격은 POSIX(Windows 클라이언트의 `\` 회피, §7).
    let dest_path = fs.join(&src_dir.path, &file_name);
    let conflict = fs.metadata(&dest_path).await.is_ok();
    let item_names = items.into_iter().map(|i| i.name).collect();
    Ok(CompressPlan {
        source: src_dir.source.clone(),
        src_dir,
        item_names,
        format,
        dest_path,
        conflict,
    })
}

pub async fn compress_execute(
    fs: &dyn FileSystem,
    plan: CompressPlan,
    ctx: &OpCtx,
    cancel_token: CancellationToken,
) -> Result<JournalEntry, DuetError> {
    // dest 충돌 → backup.
    let mut backups = Vec::new();
    if fs.metadata(&plan.dest_path).await.is_ok() {
        let parent = plan
            .dest_path
            .parent()
            .unwrap_or(plan.src_dir.path.as_path());
        let name = plan
            .dest_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("archive");
        let backup = ops::pick_backup_path(fs, parent, name).await?;
        fs.rename(&plan.dest_path, &backup).await?;
        backups.push(BackupRestore {
            backup_path: backup,
            original_path: plan.dest_path.clone(),
        });
    }

    if cancel_token.is_cancelled() {
        return Err(DuetError::Cancelled);
    }

    match &plan.source {
        SourceId::Local => {
            compress_local(
                &plan.src_dir.path,
                &plan.item_names,
                &plan.dest_path,
                plan.format,
            )
            .await?
        }
        SourceId::Ssh { connection_id, .. } => {
            compress_remote(
                ctx,
                connection_id,
                &plan.src_dir.path,
                &plan.item_names,
                &plan.dest_path,
                plan.format,
            )
            .await?
        }
    }

    // 압축 결과물 재생성은 원본 항목 목록만으론 불충분 — redo 미지원(src 생략).
    let undo = UndoAction::UndoCopy {
        target_source: plan.source.clone(),
        copied: vec![plan.dest_path.clone()],
        backups_to_restore: backups,
        src_source: None,
        copied_from: Vec::new(),
    };
    let op = OpKind::Compress {
        count: plan.item_names.len() as u32,
        dst: Location {
            source: plan.source.clone(),
            path: plan.dest_path,
        },
    };
    ctx.journal.push(op, undo).await
}

/// 아카이브 browse 세션을 원본 아카이브로 다시 묶는 계획 (Phase 3 — repack).
///
/// `browse_root`(임시 추출 폴더)의 top-level 항목들을 원본 아카이브 경로로 재압축
/// 하는 `CompressPlan` 을 만든다 — 실행은 `compress_execute` 를 그대로 재사용.
/// 원본 아카이브는 dest 충돌로 처리돼 `.bak.<ts>` 로 보존되고 Ctrl+Z(UndoCopy)로
/// 복원된다(§4 — 모든 OS 에서 reliable. macOS 로컬 trash-restore 미지원 회피).
///
/// 원본이 zip·tar.gz 가 아니면 같은 포맷으로 다시 만들 수 없어 `NotSupported`
/// (사용자 파일 포맷을 임의로 바꾸지 않음). 원격은 host-side 압축(PC 경유 0).
pub async fn repack_plan(
    fs: &dyn FileSystem,
    browse_root: Location,
    original_archive: EntryRef,
) -> Result<CompressPlan, DuetError> {
    // 같은 source(같은 호스트/로컬)여야 host-side 재압축이 성립.
    if browse_root.source != original_archive.location.source {
        return Err(DuetError::Io(
            "repack: browse folder and archive must be on the same source".into(),
        ));
    }
    let fmt = detect_format(&original_archive.name)
        .ok_or_else(|| DuetError::Io(format!("not an archive: {}", original_archive.name)))?;
    // .tar/.tar.xz/.gz 등은 생성 포맷이 없고, 7z/rar 는 읽기 전용(rar 는 라이선스상 생성 불가).
    let format = fmt.repack_format().ok_or_else(|| {
        DuetError::NotSupported(format!(
            "repack into {} is not supported (only .zip / .tar.gz)",
            original_archive.name
        ))
    })?;
    let entries = fs.list(&browse_root.path).await?;
    if entries.is_empty() {
        return Err(DuetError::Io("nothing to repack (folder is empty)".into()));
    }
    let item_names: Vec<String> = entries.into_iter().map(|e| e.name).collect();
    let dest_path = original_archive.location.path.join(&original_archive.name);
    let conflict = fs.metadata(&dest_path).await.is_ok();
    Ok(CompressPlan {
        source: browse_root.source.clone(),
        src_dir: browse_root,
        item_names,
        format,
        dest_path,
        conflict,
    })
}

/// 로컬 압축 — blocking IO 라 spawn_blocking.
async fn compress_local(
    src_dir: &Path,
    names: &[String],
    dest: &Path,
    fmt: CompressFormat,
) -> Result<(), DuetError> {
    let src_dir = src_dir.to_path_buf();
    let names = names.to_vec();
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || compress_local_blocking(&src_dir, &names, &dest, fmt))
        .await
        .map_err(|e| DuetError::Io(format!("compress task join: {e}")))?
}

fn compress_local_blocking(
    src_dir: &Path,
    names: &[String],
    dest: &Path,
    fmt: CompressFormat,
) -> Result<(), DuetError> {
    let out =
        std::fs::File::create(dest).map_err(|e| DuetError::Io(format!("create archive: {e}")))?;
    match fmt {
        CompressFormat::Zip => {
            let mut zip = zip::ZipWriter::new(out);
            let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for name in names {
                add_to_zip(&mut zip, src_dir, Path::new(name), name, &opts)?;
            }
            zip.finish()
                .map_err(|e| DuetError::Io(format!("zip finish: {e}")))?;
        }
        CompressFormat::TarGz => {
            let enc = flate2::write::GzEncoder::new(out, flate2::Compression::default());
            let mut tar = tar::Builder::new(enc);
            for name in names {
                let full = src_dir.join(name);
                let meta = std::fs::metadata(&full)
                    .map_err(|e| DuetError::Io(format!("stat {name}: {e}")))?;
                if meta.is_dir() {
                    tar.append_dir_all(name, &full)
                        .map_err(|e| DuetError::Io(format!("tar add dir {name}: {e}")))?;
                } else {
                    let mut f = std::fs::File::open(&full)
                        .map_err(|e| DuetError::Io(format!("open {name}: {e}")))?;
                    tar.append_file(name, &mut f)
                        .map_err(|e| DuetError::Io(format!("tar add {name}: {e}")))?;
                }
            }
            let enc = tar
                .into_inner()
                .map_err(|e| DuetError::Io(format!("tar finish: {e}")))?;
            enc.finish()
                .map_err(|e| DuetError::Io(format!("gz finish: {e}")))?;
        }
    }
    Ok(())
}

/// zip 에 파일/디렉토리 재귀 추가. `rel` 은 아카이브 내부 경로.
fn add_to_zip<W: std::io::Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    src_dir: &Path,
    rel: &Path,
    rel_str: &str,
    opts: &zip::write::FileOptions<()>,
) -> Result<(), DuetError> {
    let full = src_dir.join(rel);
    let meta =
        std::fs::metadata(&full).map_err(|e| DuetError::Io(format!("stat {rel_str}: {e}")))?;
    if meta.is_dir() {
        zip.add_directory(rel_str, *opts)
            .map_err(|e| DuetError::Io(format!("zip add dir {rel_str}: {e}")))?;
        for entry in std::fs::read_dir(&full)
            .map_err(|e| DuetError::Io(format!("read dir {rel_str}: {e}")))?
        {
            let entry = entry.map_err(|e| DuetError::Io(format!("dir entry: {e}")))?;
            let child_name = entry.file_name();
            let child_name = child_name.to_string_lossy();
            let child_rel = rel.join(child_name.as_ref());
            let child_rel_str = format!("{rel_str}/{child_name}");
            add_to_zip(zip, src_dir, &child_rel, &child_rel_str, opts)?;
        }
    } else {
        zip.start_file(rel_str, *opts)
            .map_err(|e| DuetError::Io(format!("zip start {rel_str}: {e}")))?;
        let mut f = std::fs::File::open(&full)
            .map_err(|e| DuetError::Io(format!("open {rel_str}: {e}")))?;
        std::io::copy(&mut f, zip)
            .map_err(|e| DuetError::Io(format!("zip write {rel_str}: {e}")))?;
    }
    Ok(())
}

/// 원격 압축 — 호스트의 zip/tar 를 exec. `cd <dir>` 로 상대 경로 보장.
async fn compress_remote(
    ctx: &OpCtx,
    connection_id: &ConnectionId,
    src_dir: &Path,
    names: &[String],
    dest: &Path,
    fmt: CompressFormat,
) -> Result<(), DuetError> {
    let pool = ctx
        .pool
        .as_ref()
        .ok_or_else(|| DuetError::Io("OpCtx.pool required for remote compress".into()))?;

    let dir = shell_escape_path(src_dir)?;
    let dest_arg = shell_escape_path(dest)?;
    // 항목들을 각각 quote — 이름은 상대 경로로 cd 후 전달.
    let mut name_args = String::new();
    for n in names {
        name_args.push(' ');
        name_args.push_str(&shell_escape_path(Path::new(n))?);
    }
    // prog = 호스트에 필요한 프로그램 — 없으면(exit 127) "설치 안 됨" 으로 안내.
    let (cmd, prog) = match fmt {
        CompressFormat::Zip => (
            format!("cd {dir} && zip -r -q {dest_arg} --{name_args}"),
            "zip",
        ),
        CompressFormat::TarGz => (
            format!("cd {dir} && tar -czf {dest_arg} --{name_args}"),
            "tar",
        ),
    };
    run_host_command(pool, connection_id, &cmd, prog).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn is_safe_browse_root_only_matches_duet_tmp_browse() {
        // 정확히 `.../.duet-tmp/browse-<...>` 만 reap 허용 (rm 경로 탈출 방지).
        assert!(is_safe_browse_root(Path::new(
            "/home/u/.duet-tmp/browse-abc123"
        )));
        assert!(!is_safe_browse_root(Path::new("/home/u/.duet-tmp/other")));
        assert!(!is_safe_browse_root(Path::new(
            "/home/u/important/browse-abc"
        )));
        assert!(!is_safe_browse_root(Path::new("/home/u/.duet-tmp")));
        assert!(!is_safe_browse_root(Path::new("/")));
    }

    #[test]
    fn local_browse_root_is_under_temp() {
        assert!(local_browse_root().ends_with("duet-archive"));
        assert!(local_browse_root().starts_with(std::env::temp_dir()));
    }

    #[test]
    fn entry_escapes_detects_traversal() {
        // 탈출 — 거부 대상
        assert!(entry_escapes("../evil"));
        assert!(entry_escapes("a/../../etc/passwd"));
        assert!(entry_escapes("foo/.."));
        assert!(entry_escapes("/etc/passwd"));
        assert!(entry_escapes("\\windows\\system32"));
        assert!(entry_escapes("C:\\x"));
        // 안전 — 허용
        assert!(!entry_escapes("safe/dir/file.txt"));
        assert!(!entry_escapes("file.txt"));
        assert!(!entry_escapes("a/b/c"));
        assert!(!entry_escapes("..foo/bar")); // ".." 가 컴포넌트가 아님
        assert!(!entry_escapes("foo..bar"));
    }

    #[test]
    fn detect_format_by_extension() {
        assert_eq!(detect_format("a.zip"), Some(ArchiveFormat::Zip));
        assert_eq!(detect_format("a.tar"), Some(ArchiveFormat::Tar));
        assert_eq!(detect_format("a.tar.gz"), Some(ArchiveFormat::TarGz));
        assert_eq!(detect_format("a.TGZ"), Some(ArchiveFormat::TarGz));
        assert_eq!(detect_format("a.tar.bz2"), Some(ArchiveFormat::TarBz2));
        assert_eq!(detect_format("a.tbz2"), Some(ArchiveFormat::TarBz2));
        assert_eq!(detect_format("a.tbz"), Some(ArchiveFormat::TarBz2));
        assert_eq!(detect_format("a.Tar.Xz"), Some(ArchiveFormat::TarXz));
        assert_eq!(detect_format("a.txz"), Some(ArchiveFormat::TarXz));
        assert_eq!(detect_format("a.tar.zst"), Some(ArchiveFormat::TarZst));
        assert_eq!(detect_format("a.tzst"), Some(ArchiveFormat::TarZst));
        assert_eq!(detect_format("a.txt.gz"), Some(ArchiveFormat::Gz));
        assert_eq!(detect_format("a.txt.bz2"), Some(ArchiveFormat::Bz2));
        assert_eq!(detect_format("a.txt.xz"), Some(ArchiveFormat::Xz));
        assert_eq!(detect_format("a.txt.zst"), Some(ArchiveFormat::Zst));
        assert_eq!(detect_format("a.7z"), Some(ArchiveFormat::SevenZ));
        assert_eq!(detect_format("A.RAR"), Some(ArchiveFormat::Rar));
        assert_eq!(detect_format("notes.txt"), None);
        assert_eq!(detect_format("noext"), None);
    }

    #[test]
    fn archive_stem_strips_known_suffixes() {
        assert_eq!(archive_stem("data.zip"), "data");
        assert_eq!(archive_stem("data.tar.gz"), "data");
        assert_eq!(archive_stem("data.tgz"), "data");
        assert_eq!(archive_stem("file.txt.gz"), "file.txt");
        assert_eq!(archive_stem("data.7z"), "data");
        assert_eq!(archive_stem("data.rar"), "data");
        assert_eq!(archive_stem("data.tar.xz"), "data");
        assert_eq!(archive_stem("Data.TBZ2"), "Data");
        assert_eq!(archive_stem("log.txt.zst"), "log.txt");
        assert_eq!(archive_stem(".zip"), ".zip.extracted");
        assert_eq!(archive_stem("plain"), "plain.extracted");
    }

    /// 7z 생성(sevenz-rust2 compress) → extract_local_blocking 해제 round-trip.
    #[test]
    fn sevenz_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), b"hello 7z").unwrap();
        std::fs::write(src.join("sub/b.bin"), vec![7u8; 1024]).unwrap();
        let archive = dir.path().join("t.7z");
        sevenz_rust2::compress_to_path(&src, &archive).unwrap();

        let dest = dir.path().join("out");
        extract_local_blocking(&archive, &dest, ArchiveFormat::SevenZ, None).unwrap();
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"hello 7z");
        assert_eq!(
            std::fs::read(dest.join("sub/b.bin")).unwrap(),
            vec![7u8; 1024]
        );
    }

    /// rar 는 생성이 불가(라이선스)라 round-trip 불가 — 없는 파일 열기 에러 경로만.
    #[test]
    fn rar_open_missing_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        let err = extract_local_blocking(
            &dir.path().join("no.rar"),
            &dir.path().join("out"),
            ArchiveFormat::Rar,
            None,
        );
        assert!(err.is_err());
    }

    /// zip 생성(crate writer) → 해제 round-trip — extract_local_blocking 검증.
    #[test]
    fn zip_roundtrip_local() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("a.zip");
        {
            let f = std::fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
            w.start_file("hello.txt", opts).unwrap();
            w.write_all(b"hi there").unwrap();
            w.add_directory("sub/", opts).unwrap();
            w.start_file("sub/nested.txt", opts).unwrap();
            w.write_all(b"nested").unwrap();
            w.finish().unwrap();
        }
        let dest = dir.path().join("out");
        std::fs::create_dir(&dest).unwrap();
        extract_local_blocking(&zip_path, &dest, ArchiveFormat::Zip, None).unwrap();
        assert_eq!(std::fs::read(dest.join("hello.txt")).unwrap(), b"hi there");
        assert_eq!(
            std::fs::read(dest.join("sub/nested.txt")).unwrap(),
            b"nested"
        );
    }

    /// 복잡한 외부/내부 파일명도 실제 탐색용 추출 경로에서 보존된다.
    #[test]
    fn browse_zip_with_complex_names() {
        let dir = tempfile::tempdir().unwrap();
        let names = [
            "[한글] 자료 (최종) #1 & '확인' + 100%.ZIP".to_string(),
            "보고서.2026.10.13 — café 😀.zip".to_string(),
            format!("{}.zip", "가".repeat(80)),
        ];
        let member = "[내부 폴더] 자료/최종 (1) #100% & '확인'.txt";
        for (i, name) in names.iter().enumerate() {
            let archive = dir.path().join(name);
            let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
            writer
                .start_file(member, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"preserved").unwrap();
            writer.finish().unwrap();
            let dest = dir.path().join(i.to_string()).join(archive_stem(name));
            std::fs::create_dir_all(&dest).unwrap();
            let format = detect_format(name).unwrap();
            extract_local_blocking(&archive, &dest, format, None).unwrap();
            assert_eq!(std::fs::read(dest.join(member)).unwrap(), b"preserved");
        }
    }

    /// 암호(AES) zip → 올바른 암호로 해제 성공 / 없거나 틀린 암호는 NeedPassword.
    #[test]
    fn encrypted_zip_password_paths() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("secret.zip");
        {
            let f = std::fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default()
                .with_aes_encryption(zip::AesMode::Aes256, "s3cret");
            w.start_file("msg.txt", opts).unwrap();
            w.write_all(b"top secret").unwrap();
            w.finish().unwrap();
        }

        // 올바른 암호 → 성공.
        let ok = dir.path().join("ok");
        std::fs::create_dir(&ok).unwrap();
        extract_local_blocking(&zip_path, &ok, ArchiveFormat::Zip, Some("s3cret")).unwrap();
        assert_eq!(std::fs::read(ok.join("msg.txt")).unwrap(), b"top secret");

        // 암호 없음 → NeedPassword (프론트가 암호 입력 UI 를 띄움).
        let nopw = dir.path().join("nopw");
        std::fs::create_dir(&nopw).unwrap();
        assert!(matches!(
            extract_local_blocking(&zip_path, &nopw, ArchiveFormat::Zip, None),
            Err(DuetError::NeedPassword)
        ));

        // 틀린 암호 → NeedPassword (재입력).
        let wrong = dir.path().join("wrong");
        std::fs::create_dir(&wrong).unwrap();
        assert!(matches!(
            extract_local_blocking(&zip_path, &wrong, ArchiveFormat::Zip, Some("nope")),
            Err(DuetError::NeedPassword)
        ));
    }

    /// extract_execute 가 NeedPassword 로 실패하면 잔재를 남기지 않는지 —
    /// ① 새로 만든 dest 폴더 제거, ② 충돌로 backup 에 옮겨둔 기존 폴더 원위치 복원.
    #[tokio::test]
    async fn extract_execute_need_password_rolls_back_dest() {
        use crate::fs::LocalFs;

        let root = tempfile::tempdir().unwrap();
        // ctx 파일(s.toml/j.jsonl)과 섞이지 않게 작업 폴더 분리 — 잔재 검사 정확성.
        let work = root.path().join("work");
        std::fs::create_dir(&work).unwrap();
        let zip_path = work.join("secret.zip");
        {
            let f = std::fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default()
                .with_aes_encryption(zip::AesMode::Aes256, "s3cret");
            w.start_file("msg.txt", opts).unwrap();
            w.write_all(b"top secret").unwrap();
            w.finish().unwrap();
        }

        let settings =
            crate::services::settings::SettingsStore::load_from(&root.path().join("s.toml"))
                .await
                .unwrap();
        let journal = crate::services::journal::Journal::load_from(&root.path().join("j.jsonl"))
            .await
            .unwrap();
        let ctx = OpCtx {
            settings,
            journal,
            pool: None,
            app: None,
        };
        let local = LocalFs::new();
        let entry = EntryRef {
            location: Location {
                source: SourceId::Local,
                path: work.clone(),
            },
            name: "secret.zip".into(),
        };
        let work_entries = || {
            let mut names: Vec<String> = std::fs::read_dir(&work)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        };

        // ① 충돌 없음 — 실패 후 dest 폴더가 아예 없어야 한다 ("빈 폴더만 생김" 방지).
        let plan = extract_plan(&local, entry.clone()).await.unwrap();
        let dest = plan.dest_dir.clone();
        let err = extract_execute(&local, plan, None, &ctx, CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(err, DuetError::NeedPassword));
        assert!(!dest.exists());
        assert_eq!(work_entries(), vec!["secret.zip"]);

        // ② dest 와 같은 이름의 기존 폴더 — 실패 후 내용 그대로 복원, backup 잔재 없음.
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("keep.txt"), b"keep").unwrap();
        let plan = extract_plan(&local, entry).await.unwrap();
        let err = extract_execute(&local, plan, None, &ctx, CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(err, DuetError::NeedPassword));
        assert_eq!(std::fs::read(dest.join("keep.txt")).unwrap(), b"keep");
        assert_eq!(work_entries(), vec!["secret", "secret.zip"]);
    }

    /// tar.gz 압축 → 해제 round-trip — compress_local_blocking + extract 검증.
    #[test]
    fn targz_roundtrip_local() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir(&src).unwrap();
        std::fs::write(src.join("a.txt"), b"alpha").unwrap();
        std::fs::create_dir(src.join("d")).unwrap();
        std::fs::write(src.join("d/b.txt"), b"beta").unwrap();

        let archive = dir.path().join("out.tar.gz");
        compress_local_blocking(
            &src,
            &["a.txt".into(), "d".into()],
            &archive,
            CompressFormat::TarGz,
        )
        .unwrap();
        assert!(archive.exists());

        let dest = dir.path().join("unpacked");
        std::fs::create_dir(&dest).unwrap();
        extract_local_blocking(&archive, &dest, ArchiveFormat::TarGz, None).unwrap();
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(std::fs::read(dest.join("d/b.txt")).unwrap(), b"beta");
    }

    /// open_for_browse(로컬) — zip 을 임시 위치로 풀고 그 디렉토리에 내용이 있는지.
    #[tokio::test]
    async fn open_for_browse_local_extracts_to_temp() {
        let dir = tempfile::tempdir().unwrap();
        let name = format!("[최종] {} (1) #100% & '확인'.zip", "가".repeat(65));
        let zip_path = dir.path().join(&name);
        {
            let f = std::fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
            w.start_file("a.txt", opts).unwrap();
            std::io::Write::write_all(&mut w, b"alpha").unwrap();
            w.finish().unwrap();
        }
        let archive = EntryRef {
            location: Location {
                source: SourceId::Local,
                path: dir.path().to_path_buf(),
            },
            name,
        };
        let pool = crate::services::connection_pool::ConnectionPool::new();
        let loc = open_for_browse(archive, None, &pool).await.unwrap();

        assert_eq!(loc.source, SourceId::Local);
        // 원본 이름 길이와 무관하게 짧은 임시 경로를 사용한다.
        assert_eq!(loc.path.file_name().unwrap(), "content");
        assert_eq!(std::fs::read(loc.path.join("a.txt")).unwrap(), b"alpha");

        // 임시 잔여물 정리 (temp/duet-archive/<token>/).
        if let Some(token_dir) = loc.path.parent() {
            let _ = std::fs::remove_dir_all(token_dir);
        }
    }

    /// zip 압축 → 해제 round-trip (디렉토리 재귀 add_to_zip 검증).
    #[test]
    fn zip_roundtrip_with_dir() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir(&src).unwrap();
        std::fs::write(src.join("top.txt"), b"top").unwrap();
        std::fs::create_dir(src.join("inner")).unwrap();
        std::fs::write(src.join("inner/leaf.txt"), b"leaf").unwrap();

        let archive = dir.path().join("out.zip");
        compress_local_blocking(
            &src,
            &["top.txt".into(), "inner".into()],
            &archive,
            CompressFormat::Zip,
        )
        .unwrap();

        let dest = dir.path().join("unpacked");
        std::fs::create_dir(&dest).unwrap();
        extract_local_blocking(&archive, &dest, ArchiveFormat::Zip, None).unwrap();
        assert_eq!(std::fs::read(dest.join("top.txt")).unwrap(), b"top");
        assert_eq!(std::fs::read(dest.join("inner/leaf.txt")).unwrap(), b"leaf");
    }

    /// compress_plan 은 파일명만 받아야 한다 — 경로 구분자('/'·Windows '\')가 섞인
    /// 이름은 거부(FE 가 전체경로를 basename 으로 잘못 보낸 경우의 방어선).
    #[tokio::test]
    async fn compress_plan_rejects_path_separator_names() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"a").unwrap();
        let fs = crate::fs::LocalFs::new();
        let items = vec![EntryRef {
            location: Location {
                source: SourceId::Local,
                path: dir.path().to_path_buf(),
            },
            name: "a.txt".into(),
        }];
        // Windows 전체경로/하위경로/빈 이름은 모두 거부.
        for bad in ["D:\\test\\test1\\test2", "sub/name", "a\\b", ""] {
            let r = compress_plan(&fs, items.clone(), bad.to_string(), CompressFormat::Zip).await;
            assert!(r.is_err(), "name {bad:?} should be rejected");
        }
        // 정상 이름은 통과.
        let ok = compress_plan(&fs, items.clone(), "archive".into(), CompressFormat::Zip).await;
        assert!(ok.is_ok(), "plain name should be accepted");
    }

    #[tokio::test]
    async fn repack_plan_maps_format_and_targets_original() {
        let dir = tempfile::tempdir().unwrap();
        // browse 추출 폴더.
        let browse = dir.path().join("browse").join("data");
        std::fs::create_dir_all(&browse).unwrap();
        std::fs::write(browse.join("a.txt"), b"a").unwrap();
        std::fs::write(browse.join("b.txt"), b"b").unwrap();
        // 원본 아카이브.
        let archive_dir = dir.path().join("dl");
        std::fs::create_dir_all(&archive_dir).unwrap();
        std::fs::write(archive_dir.join("data.zip"), b"old").unwrap();

        let fs = crate::fs::LocalFs::new();
        let browse_root = Location {
            source: SourceId::Local,
            path: browse.clone(),
        };
        let original = EntryRef {
            location: Location {
                source: SourceId::Local,
                path: archive_dir.clone(),
            },
            name: "data.zip".into(),
        };
        let plan = repack_plan(&fs, browse_root, original).await.unwrap();
        assert_eq!(plan.format, CompressFormat::Zip);
        assert_eq!(plan.dest_path, archive_dir.join("data.zip"));
        assert!(plan.conflict, "original archive exists → conflict(backup)");
        assert_eq!(plan.item_names.len(), 2);
        assert!(plan.item_names.contains(&"a.txt".to_string()));
    }

    #[tokio::test]
    async fn repack_plan_rejects_formats_it_cannot_recreate() {
        let dir = tempfile::tempdir().unwrap();
        let browse = dir.path().join("b");
        std::fs::create_dir_all(&browse).unwrap();
        std::fs::write(browse.join("x"), b"x").unwrap();
        let fs = crate::fs::LocalFs::new();
        for name in [
            "data.tar",
            "log.txt.gz",
            "data.tar.xz",
            "data.7z",
            "data.rar",
        ] {
            let browse_root = Location {
                source: SourceId::Local,
                path: browse.clone(),
            };
            let original = EntryRef {
                location: Location {
                    source: SourceId::Local,
                    path: dir.path().to_path_buf(),
                },
                name: name.into(),
            };
            let r = repack_plan(&fs, browse_root, original).await;
            assert!(
                matches!(r, Err(DuetError::NotSupported(_))),
                "{name} should be NotSupported"
            );
        }
    }

    /// 테스트 아카이브 경로 (생성 방법은 `tests/fixtures/archive/README.md`).
    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/archive")
            .join(name)
    }

    /// CLI(bzip2/xz/zstd)로 만든 tar.bz2 / tar.xz / tar.zst 를 로컬 crate 로 해제.
    #[test]
    fn tar_codec_fixtures_extract_locally() {
        for (name, fmt) in [
            ("sample.tar.bz2", ArchiveFormat::TarBz2),
            ("sample.tar.xz", ArchiveFormat::TarXz),
            ("sample.tar.zst", ArchiveFormat::TarZst),
        ] {
            let dest = tempfile::tempdir().unwrap();
            extract_local_blocking(&fixture(name), dest.path(), fmt, None)
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            let a = std::fs::read_to_string(dest.path().join("a.txt")).unwrap();
            assert_eq!(a, "alpha\n".repeat(400), "{name}");
            let b = std::fs::read_to_string(dest.path().join("sub/b.txt")).unwrap();
            assert_eq!(b, "beta", "{name}");
        }
    }

    /// 단일 파일 압축 — 따로 압축해 이어 붙인 멤버·스트림·프레임 2개를 끝까지 푼다
    /// (`gzip -d` 등과 같은 의미). 결과는 dest/<압축 확장자 뗀 이름>.
    #[test]
    fn single_file_codecs_decode_every_member() {
        for (name, fmt) in [
            ("two.txt.gz", ArchiveFormat::Gz),
            ("two.txt.bz2", ArchiveFormat::Bz2),
            ("two.txt.xz", ArchiveFormat::Xz),
            ("two.txt.zst", ArchiveFormat::Zst),
        ] {
            let dest = tempfile::tempdir().unwrap();
            extract_local_blocking(&fixture(name), dest.path(), fmt, None)
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            let out = std::fs::read_to_string(dest.path().join("two.txt")).unwrap();
            assert_eq!(out, "first\nsecond\n", "{name}");
        }
    }

    /// Deflate64 방식 zip (7-Zip `-mm=Deflate64` 로 생성 — Windows 가 큰 파일에 쓰는 방식).
    #[test]
    fn deflate64_zip_extracts_locally() {
        let dest = tempfile::tempdir().unwrap();
        extract_local_blocking(&fixture("d64.zip"), dest.path(), ArchiveFormat::Zip, None).unwrap();
        let a = std::fs::read_to_string(dest.path().join("a.txt")).unwrap();
        assert_eq!(a, "alpha\n".repeat(400));
        let b = std::fs::read_to_string(dest.path().join("sub/b.txt")).unwrap();
        assert_eq!(b, "beta");
    }

    /// 단일 파일 압축 해제는 폴더 없이 `<stem>` 파일로 바로 풀린다 (`two.txt/two.txt` 아님).
    #[tokio::test]
    async fn extract_execute_single_file_writes_file_directly() {
        use crate::fs::LocalFs;

        let root = tempfile::tempdir().unwrap();
        let work = root.path().join("work");
        std::fs::create_dir(&work).unwrap();
        std::fs::copy(fixture("two.txt.gz"), work.join("two.txt.gz")).unwrap();
        let settings =
            crate::services::settings::SettingsStore::load_from(&root.path().join("s.toml"))
                .await
                .unwrap();
        let journal = crate::services::journal::Journal::load_from(&root.path().join("j.jsonl"))
            .await
            .unwrap();
        let ctx = OpCtx {
            settings,
            journal,
            pool: None,
            app: None,
        };
        let local = LocalFs::new();
        let entry = EntryRef {
            location: Location {
                source: SourceId::Local,
                path: work.clone(),
            },
            name: "two.txt.gz".into(),
        };
        let plan = extract_plan(&local, entry).await.unwrap();
        assert_eq!(plan.dest_dir, work.join("two.txt"));
        extract_execute(&local, plan, None, &ctx, CancellationToken::new())
            .await
            .unwrap();
        let out = work.join("two.txt");
        assert!(out.is_file(), "should be a file, not a folder");
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "first\nsecond\n");
    }

    /// 원격 위치의 로컬 전용 포맷(7z/rar/단일 파일)은 plan 단계에서 거부 — 충돌 백업 등
    /// 아무것도 건드리지 않는다.
    #[tokio::test]
    async fn extract_plan_rejects_local_only_formats_on_remote() {
        let fs = crate::fs::LocalFs::new();
        let ssh = SourceId::Ssh {
            connection_id: ConnectionId("c1".into()),
            host_ip: std::net::IpAddr::from([127, 0, 0, 1]),
            user: "u".into(),
        };
        for name in ["a.7z", "a.rar", "log.txt.gz", "log.txt.zst"] {
            let entry = EntryRef {
                location: Location {
                    source: ssh.clone(),
                    path: PathBuf::from("/srv"),
                },
                name: name.into(),
            };
            let r = extract_plan(&fs, entry).await;
            assert!(matches!(r, Err(DuetError::NotSupported(_))), "{name}");
        }
    }

    /// 원격 tar 명령은 코덱별 옵션(-z/-j/-J/--zstd)을 쓴다 — 로컬 bsdtar 로 네 옵션의
    /// 목록·해제를 확인했고, GNU tar 도 같은 옵션(--zstd 는 1.31+).
    #[test]
    fn remote_tar_commands_use_codec_flags() {
        let src = Path::new("/srv/x.tar.zst");
        let dest = Path::new("/srv/x");
        assert_eq!(
            remote_extract_command(src, dest, ArchiveFormat::TarZst, None).unwrap(),
            "tar --zstd -xf '/srv/x.tar.zst' -C '/srv/x'"
        );
        assert_eq!(
            remote_extract_command(src, dest, ArchiveFormat::TarGz, None).unwrap(),
            "tar -z -xf '/srv/x.tar.zst' -C '/srv/x'"
        );
        let list = |p: &str, fmt| remote_list_command(Path::new(p), fmt).unwrap();
        assert_eq!(list("/a.tar", ArchiveFormat::Tar), "tar -tf '/a.tar'");
        assert_eq!(
            list("/a.tbz2", ArchiveFormat::TarBz2),
            "tar -j -tf '/a.tbz2'"
        );
        assert_eq!(list("/a.txz", ArchiveFormat::TarXz), "tar -J -tf '/a.txz'");
        for fmt in [
            ArchiveFormat::SevenZ,
            ArchiveFormat::Rar,
            ArchiveFormat::Gz,
            ArchiveFormat::Zst,
        ] {
            assert!(!fmt.supports_remote(), "{fmt:?}");
            assert!(matches!(
                remote_extract_command(src, dest, fmt, None),
                Err(DuetError::NotSupported(_))
            ));
            assert!(matches!(
                remote_list_command(src, fmt),
                Err(DuetError::NotSupported(_))
            ));
        }
    }

    /// 호스트에 프로그램이 없으면(exit 127) 셸 원문 대신 설치 안내, 그 외 실패는 Ssh 에러.
    #[test]
    fn host_failure_explains_missing_program() {
        let out = |exit_status| ExecOutput {
            exit_status,
            stdout: Vec::new(),
            stderr: b"sh: 1: unzip: not found".to_vec(),
        };
        match host_failure(&out(127), "unzip") {
            DuetError::NotSupported(m) => assert!(m.contains("`unzip`"), "{m}"),
            other => panic!("expected NotSupported, got {other}"),
        }
        assert!(matches!(host_failure(&out(2), "tar"), DuetError::Ssh(_)));
    }

    /// 프론트 `src/lib/archive.ts` 의 접미사 목록이 백엔드 표·능력과 같은지 — 메뉴 노출
    /// (해제·원격·repack)이 실제 지원과 어긋나지 않게 한다. 한쪽만 고치면 여기서 깨진다.
    #[test]
    fn frontend_archive_lists_match_backend() {
        use std::collections::BTreeSet;
        let ts = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/archive.ts"),
        )
        .unwrap();
        // `const NAME = [ "…", … ]` 안의 따옴표 문자열들.
        let ts_list = |name: &str| -> BTreeSet<String> {
            let head = format!("const {name} = [");
            let start = ts
                .find(&head)
                .unwrap_or_else(|| panic!("{name} not found in archive.ts"))
                + head.len();
            let body = &ts[start..];
            let body = &body[..body.find(']').unwrap()];
            body.split('"')
                .skip(1)
                .step_by(2)
                .map(str::to_string)
                .collect()
        };
        let backend = |keep: fn(ArchiveFormat) -> bool| -> BTreeSet<String> {
            SUFFIXES
                .iter()
                .filter(|(_, f)| keep(*f))
                .map(|(s, _)| s.to_string())
                .collect()
        };
        assert_eq!(ts_list("REMOTE_SUFFIXES"), backend(|f| f.supports_remote()));
        assert_eq!(
            ts_list("LOCAL_ONLY_SUFFIXES"),
            backend(|f| !f.supports_remote())
        );
        assert_eq!(
            ts_list("REPACK_SUFFIXES"),
            backend(|f| f.repack_format().is_some())
        );
    }
}
