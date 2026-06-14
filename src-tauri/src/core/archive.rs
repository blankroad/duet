//! 아카이브 압축 해제 / 생성.
//!
//! 로컬은 Rust crate (`zip`/`tar`/`flate2`) 로, 원격(SSH)은 호스트의
//! `unzip`/`tar`/`zip` 을 russh exec 로 실행 (시스템 ssh 호출 X — CLAUDE.md §9).
//! 같은-호스트 원칙: 원격 아카이브는 로컬 PC 를 경유하지 않고 호스트에서 직접 처리.
//!
//! plan/execute 두 단계 (CLAUDE.md §3/§4). execute 는 journal 에 기록하여
//! Ctrl+Z 되돌리기 가능 — 생성물(해제 디렉토리 / 압축 파일)을 제거하는 형태.

use crate::core::copy_strategy::shell_escape_path;
use crate::core::ops::{self, OpCtx};
use crate::fs::{FileSystem, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::{BackupRestore, JournalEntry, OpKind, UndoAction};
use crate::ssh::remote_exec::exec;
use crate::types::{ConnectionId, DuetError, EntryKind, EntryRef, Location, SourceId};
use serde::{Deserialize, Serialize};
use specta::Type;
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
    /// 단일 파일 gzip (`file.txt.gz`).
    Gz,
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

/// 파일 이름 확장자로 아카이브 포맷 판정. 아카이브가 아니면 None.
pub fn detect_format(name: &str) -> Option<ArchiveFormat> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        Some(ArchiveFormat::TarGz)
    } else if lower.ends_with(".tar") {
        Some(ArchiveFormat::Tar)
    } else if lower.ends_with(".zip") {
        Some(ArchiveFormat::Zip)
    } else if lower.ends_with(".gz") {
        Some(ArchiveFormat::Gz)
    } else {
        None
    }
}

/// 아카이브 이름에서 해제 디렉토리 이름 도출 (`data.tar.gz` → `data`).
/// 알려진 확장자가 없거나 결과가 비면 `<name>.extracted`.
pub fn archive_stem(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    for suf in [".tar.gz", ".tgz", ".tar", ".zip", ".gz"] {
        if lower.ends_with(suf) {
            let stem = &name[..name.len() - suf.len()];
            if !stem.is_empty() {
                return stem.to_string();
            }
        }
    }
    format!("{name}.extracted")
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
    /// 해제 결과가 들어갈 디렉토리 (`archive_dir/<stem>`).
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
    let archive_path = archive.location.path.join(&archive.name);
    let meta = fs.metadata(&archive_path).await?;
    if meta.kind != EntryKind::File {
        return Err(DuetError::Io("not a regular file".into()));
    }
    let stem = archive_stem(&archive.name);
    let dest_dir = archive.location.path.join(&stem);
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
    ctx: &OpCtx,
    cancel_token: CancellationToken,
) -> Result<JournalEntry, DuetError> {
    let archive_path = plan.archive_dir.path.join(&plan.archive_name);

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
    fs.mkdir(&plan.dest_dir).await?;

    if cancel_token.is_cancelled() {
        return Err(DuetError::Cancelled);
    }

    match &plan.source {
        SourceId::Local => extract_local(&archive_path, &plan.dest_dir, plan.format).await?,
        SourceId::Ssh { connection_id, .. } => {
            let pool = ctx
                .pool
                .as_ref()
                .ok_or_else(|| DuetError::Io("OpCtx.pool required for remote extract".into()))?;
            extract_remote(
                pool,
                connection_id,
                &archive_path,
                &plan.dest_dir,
                plan.format,
            )
            .await?
        }
    }

    // undo = 생성된 dest_dir 제거 + backup 복원 (UndoCopy 재사용).
    let undo = UndoAction::UndoCopy {
        target_source: plan.source.clone(),
        copied: vec![plan.dest_dir.clone()],
        backups_to_restore: backups,
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

/// 로컬 아카이브 해제 — blocking IO 라 spawn_blocking.
async fn extract_local(archive: &Path, dest: &Path, fmt: ArchiveFormat) -> Result<(), DuetError> {
    let archive = archive.to_path_buf();
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || extract_local_blocking(&archive, &dest, fmt))
        .await
        .map_err(|e| DuetError::Io(format!("extract task join: {e}")))?
}

fn extract_local_blocking(
    archive: &Path,
    dest: &Path,
    fmt: ArchiveFormat,
) -> Result<(), DuetError> {
    let file =
        std::fs::File::open(archive).map_err(|e| DuetError::Io(format!("open archive: {e}")))?;
    match fmt {
        ArchiveFormat::Zip => {
            let mut zip =
                zip::ZipArchive::new(file).map_err(|e| DuetError::Io(format!("zip open: {e}")))?;
            // zip crate 의 extract 는 enclosed_name 으로 zip-slip 방지.
            zip.extract(dest)
                .map_err(|e| DuetError::Io(format!("zip extract: {e}")))?;
        }
        ArchiveFormat::Tar => {
            let mut tar = tar::Archive::new(file);
            tar.unpack(dest)
                .map_err(|e| DuetError::Io(format!("tar extract: {e}")))?;
        }
        ArchiveFormat::TarGz => {
            let gz = flate2::read::GzDecoder::new(file);
            let mut tar = tar::Archive::new(gz);
            tar.unpack(dest)
                .map_err(|e| DuetError::Io(format!("tar.gz extract: {e}")))?;
        }
        ArchiveFormat::Gz => {
            // 단일 파일 gzip → dest/<.gz 제거한 이름>.
            let mut gz = flate2::read::GzDecoder::new(file);
            let out_name = archive
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| DuetError::Io("invalid gz name".into()))?;
            let out_path = dest.join(out_name);
            let mut out = std::fs::File::create(&out_path)
                .map_err(|e| DuetError::Io(format!("create output: {e}")))?;
            std::io::copy(&mut gz, &mut out)
                .map_err(|e| DuetError::Io(format!("gz decompress: {e}")))?;
        }
    }
    Ok(())
}

/// 호스트의 unzip/tar 해제 명령 문자열 (인자 shell-escape). Gz 는 미지원.
fn remote_extract_command(
    archive: &Path,
    dest: &Path,
    fmt: ArchiveFormat,
) -> Result<String, DuetError> {
    let a = shell_escape_path(archive)?;
    let d = shell_escape_path(dest)?;
    Ok(match fmt {
        ArchiveFormat::Zip => format!("unzip -o {a} -d {d}"),
        ArchiveFormat::Tar => format!("tar -xf {a} -C {d}"),
        ArchiveFormat::TarGz => format!("tar -xzf {a} -C {d}"),
        ArchiveFormat::Gz => {
            return Err(DuetError::NotSupported(
                "remote single-file .gz extract".into(),
            ))
        }
    })
}

/// 한 호스트 셸 명령을 russh exec 로 실행 (시스템 ssh X). exit!=0 → Ssh 에러.
async fn run_host_command(
    pool: &Arc<ConnectionPool>,
    connection_id: &ConnectionId,
    cmd: &str,
) -> Result<(), DuetError> {
    let conn = pool.get(connection_id).await?;
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;
    let handle = session_mutex.lock().await;
    let out = exec(&handle, cmd).await?;
    if out.exit_status != 0 {
        return Err(DuetError::Ssh(format!(
            "host command failed (exit {}): {}",
            out.exit_status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
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
) -> Result<(), DuetError> {
    let cmd = remote_extract_command(archive, dest, fmt)?;
    run_host_command(pool, connection_id, &cmd).await
}

// === Browse (투명 임시추출 — 탐색기처럼 내부 열람) ===

/// 아카이브를 임시 위치로 풀고, 그 디렉토리의 `Location` 을 반환.
///
/// 패널이 이 Location 으로 navigate 하면 *실제 폴더* 라서 탐색/미리보기/
/// 복사·이동/DnD/북마크가 전부 그대로 동작 (Location 모델 변경 없음).
///
/// - 로컬: `<temp>/duet-archive/<token>/<stem>/` 로 crate 추출.
/// - 원격(SSH): 호스트의 `~/.duet-tmp/browse-<token>/<stem>/` 로 host-side 추출
///   (unzip/tar exec). **로컬 PC 를 1 바이트도 경유하지 않음** — 같은-호스트 원칙.
///   반환 Location 은 같은 `Ssh{}` source 라 패널이 그대로 원격을 탐색.
///
/// browse-only(비파괴) 라 journal 기록 없음.
pub async fn open_for_browse(
    archive: EntryRef,
    pool: &Arc<ConnectionPool>,
) -> Result<Location, DuetError> {
    let format = detect_format(&archive.name)
        .ok_or_else(|| DuetError::Io(format!("unsupported archive: {}", archive.name)))?;
    let archive_path = archive.location.path.join(&archive.name);
    let stem = archive_stem(&archive.name);
    let token = uuid::Uuid::new_v4().to_string();

    match &archive.location.source {
        SourceId::Local => {
            let dest = local_browse_root().join(&token).join(&stem);
            tokio::fs::create_dir_all(&dest)
                .await
                .map_err(|e| DuetError::Io(format!("create temp dir: {e}")))?;
            extract_local(&archive_path, &dest, format).await?;
            Ok(Location {
                source: SourceId::Local,
                path: dest,
            })
        }
        SourceId::Ssh { connection_id, .. } => {
            // 호스트 home 아래 임시 디렉토리 — 절대경로로 만들어 shell-escape.
            let conn = pool.get(connection_id).await?;
            let home = SshFs::new(conn).home().await?;
            let dest = home
                .join(".duet-tmp")
                .join(format!("browse-{token}"))
                .join(&stem);
            // mkdir -p + 추출을 한 호스트 명령으로 (PC 경유 0).
            let cmd = format!(
                "mkdir -p {} && {}",
                shell_escape_path(&dest)?,
                remote_extract_command(&archive_path, &dest, format)?,
            );
            run_host_command(pool, connection_id, &cmd).await?;
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
        let _ = run_host_command(pool, connection_id, &format!("rm -rf {escaped}")).await;
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
    if archive_name.contains('/') || archive_name.is_empty() {
        return Err(DuetError::Io(format!("invalid name: {archive_name}")));
    }
    // 확장자 자동 부여 (이미 있으면 중복 안 함).
    let ext = format.extension();
    let file_name = if archive_name.to_ascii_lowercase().ends_with(ext) {
        archive_name
    } else {
        format!("{archive_name}{ext}")
    };
    let dest_path = src_dir.path.join(&file_name);
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

    let undo = UndoAction::UndoCopy {
        target_source: plan.source.clone(),
        copied: vec![plan.dest_path.clone()],
        backups_to_restore: backups,
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
/// 원본이 `.tar`/`.gz` 면 `CompressFormat` 으로 매핑 불가 → `NotSupported`
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
    let format = match fmt {
        ArchiveFormat::Zip => CompressFormat::Zip,
        ArchiveFormat::TarGz => CompressFormat::TarGz,
        ArchiveFormat::Tar => {
            return Err(DuetError::NotSupported(
                "repack into .tar is not supported (only .zip / .tar.gz)".into(),
            ))
        }
        ArchiveFormat::Gz => {
            return Err(DuetError::NotSupported(
                "repack into .gz is not supported (only .zip / .tar.gz)".into(),
            ))
        }
    };
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
    let conn = pool.get(connection_id).await?;
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;

    let dir = shell_escape_path(src_dir)?;
    let dest_arg = shell_escape_path(dest)?;
    // 항목들을 각각 quote — 이름은 상대 경로로 cd 후 전달.
    let mut name_args = String::new();
    for n in names {
        name_args.push(' ');
        name_args.push_str(&shell_escape_path(Path::new(n))?);
    }
    let cmd = match fmt {
        CompressFormat::Zip => {
            format!("cd {dir} && zip -r -q {dest_arg} --{name_args}")
        }
        CompressFormat::TarGz => {
            format!("cd {dir} && tar -czf {dest_arg} --{name_args}")
        }
    };

    let handle = session_mutex.lock().await;
    let out = exec(&handle, &cmd).await?;
    if out.exit_status != 0 {
        return Err(DuetError::Ssh(format!(
            "compress failed (exit {}): {}",
            out.exit_status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
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
    fn detect_format_by_extension() {
        assert_eq!(detect_format("a.zip"), Some(ArchiveFormat::Zip));
        assert_eq!(detect_format("a.tar"), Some(ArchiveFormat::Tar));
        assert_eq!(detect_format("a.tar.gz"), Some(ArchiveFormat::TarGz));
        assert_eq!(detect_format("a.TGZ"), Some(ArchiveFormat::TarGz));
        assert_eq!(detect_format("a.txt.gz"), Some(ArchiveFormat::Gz));
        assert_eq!(detect_format("notes.txt"), None);
        assert_eq!(detect_format("noext"), None);
    }

    #[test]
    fn archive_stem_strips_known_suffixes() {
        assert_eq!(archive_stem("data.zip"), "data");
        assert_eq!(archive_stem("data.tar.gz"), "data");
        assert_eq!(archive_stem("data.tgz"), "data");
        assert_eq!(archive_stem("file.txt.gz"), "file.txt");
        assert_eq!(archive_stem(".zip"), ".zip.extracted");
        assert_eq!(archive_stem("plain"), "plain.extracted");
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
        extract_local_blocking(&zip_path, &dest, ArchiveFormat::Zip).unwrap();
        assert_eq!(std::fs::read(dest.join("hello.txt")).unwrap(), b"hi there");
        assert_eq!(
            std::fs::read(dest.join("sub/nested.txt")).unwrap(),
            b"nested"
        );
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
        extract_local_blocking(&archive, &dest, ArchiveFormat::TarGz).unwrap();
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(std::fs::read(dest.join("d/b.txt")).unwrap(), b"beta");
    }

    /// open_for_browse(로컬) — zip 을 임시 위치로 풀고 그 디렉토리에 내용이 있는지.
    #[tokio::test]
    async fn open_for_browse_local_extracts_to_temp() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("pkg.zip");
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
            name: "pkg.zip".into(),
        };
        let pool = crate::services::connection_pool::ConnectionPool::new();
        let loc = open_for_browse(archive, &pool).await.unwrap();

        assert_eq!(loc.source, SourceId::Local);
        // 반환 경로 leaf 는 stem("pkg"), 내부에 a.txt 존재.
        assert_eq!(loc.path.file_name().unwrap(), "pkg");
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
        extract_local_blocking(&archive, &dest, ArchiveFormat::Zip).unwrap();
        assert_eq!(std::fs::read(dest.join("top.txt")).unwrap(), b"top");
        assert_eq!(std::fs::read(dest.join("inner/leaf.txt")).unwrap(), b"leaf");
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
    async fn repack_plan_rejects_tar_and_gz() {
        let dir = tempfile::tempdir().unwrap();
        let browse = dir.path().join("b");
        std::fs::create_dir_all(&browse).unwrap();
        std::fs::write(browse.join("x"), b"x").unwrap();
        let fs = crate::fs::LocalFs::new();
        for name in ["data.tar", "log.txt.gz"] {
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
}
