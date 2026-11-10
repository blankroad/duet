//! 진짜 "여기에 압축 풀기" — 아카이브 내용을 아카이브가 있는 폴더에 바로 푼다.
//!
//! 사용자 폴더에 바로 풀면 같은 이름의 기존 항목과 부딪힌다. 그래서 두 단계로 한다:
//!
//! 1. **준비(staging)** — 같은 폴더(같은 볼륨이라 이동이 싸다)에 `.duet-extract-<uuid>` 를
//!    만들고 기존 엔진(`archive::extract_local`)으로 거기에 푼다. 암호·손상·취소로 여기서
//!    실패하면 사용자 폴더에는 아무것도 놓이지 않는다.
//! 2. **배치(placement)** — 준비된 맨 위 항목을 하나씩 사용자 폴더로 옮긴다. 이름은 먼저
//!    `mkdir` / `create_new_file`(이미 있으면 실패하는 생성)로 예약한 뒤 채운다
//!    (`archive_names::try_reserve`).
//!    - 폴더 ↔ 기존 **진짜** 폴더(lstat, 링크는 따라가지 않음) → 병합(안으로 내려감).
//!    - 그 밖의 충돌 → 일괄당 하나의 정책 [`ExtractConflict`]:
//!      `KeepBoth`(기본, `이름 (2)` 예약) / `Replace`(기존을 `.bak` 으로 옮기고 Ctrl+Z 복원,
//!      예약이 그래도 실패하면 KeepBoth) / `Skip`.
//!    - 원본 아카이브(와 같은 일괄의 다른 아카이브)는 Replace 대상에서 빠진다 — 원본은
//!      옮기거나 이름을 바꾸거나 지우지 않는다.
//!
//! 이 작업이 만든 맨 위 경로와 백업은 journal 하나(`UndoCopy`)로 남는다 — 배치가 도중에
//! 멈춰도 그때까지 놓은 것은 기록한 뒤 에러를 돌려준다(CLAUDE.md §4). 준비 폴더에 남은
//! 것(건너뛴 항목·못 옮긴 항목)은 휴지통으로 보낸다(§3 — 영구 삭제하지 않음). 비었으면
//! 빈 폴더만 지운다. 휴지통도 실패하면 그 자리에 두고 경로를 알린다.
//!
//! ## 보장하는 것 / 아닌 것
//!
//! - **보장**: 예약 시점에 이미 있던 항목은 KeepBoth·Skip 에서 바꾸거나 덮지 않는다.
//!   Replace 는 사용자가 고른 경우에만, 백업(`.bak`)으로 옮긴 뒤 놓는다(Ctrl+Z 복원).
//!   원본 아카이브(같은 일괄 포함)는 Replace 로도 옮기지 않는다.
//! - **협력하는 duet 작업끼리**: 같은 호스트의 작업은 `TaskQueue` 가 한 줄로 세워 서로
//!   끼어들지 않는다.
//! - **최선 노력(보장 아님)**: 예약 *뒤에* 외부 프로그램이 같은 자리에 쓰는 경우.
//!   파일은 rename 직전에 그 자리가 아직 우리 0바이트 자리인지 다시 확인하고, 아니면
//!   덮지 않고 건너뛴다 — 확인과 rename 사이의 짧은 틈은 남는다. 새로 만든 폴더 안으로
//!   자식을 옮길 때는 충돌을 다시 확인하지 않는다(방금 만든 빈 폴더라는 가정). 예약 뒤
//!   상위 폴더가 링크로 바뀌는 경우도 막지 않는다.
//!
//! 원격(SSH)은 이번 범위에서 지원하지 않는다 — SFTP rename 이 우리가 만든 빈 자리를
//! 덮는 동작(OpenSSH 는 link/unlink 라 EEXIST)이 실제 서버에서 검증되지 않았다.

use crate::core::archive;
use crate::core::archive_names::{reserve_free, try_reserve, Reserve};
use crate::core::ops::{self, OpCtx};
use crate::core::tar_unpack::UnpackReport;
use crate::fs::FileSystem;
use crate::services::journal::{BackupRestore, JournalEntry, OpKind, UndoAction};
use crate::types::{DuetError, EntryKind, EntryRef, Location, SourceId};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

/// 준비 폴더 이름 접두사 (`<archive_dir>/.duet-extract-<uuid>`).
pub const STAGING_PREFIX: &str = ".duet-extract-";

/// 이미 있는 항목과 부딪혔을 때 — 일괄당 하나, 프론트 다이얼로그에서 고른다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ExtractConflict {
    /// 새 항목을 `이름 (2)` 로 — 아무것도 바꾸지 않는다.
    #[default]
    KeepBoth,
    /// 기존 항목을 `.bak` 으로 옮기고 그 자리에 둔다 (Ctrl+Z 로 복원). 폴더끼리는 늘 병합.
    Replace,
    /// 새 항목을 놓지 않는다.
    Skip,
}

/// 이름을 바꿔 놓은 항목 (`dir` 안의 `from` → `to`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RenamedItem {
    pub dir: PathBuf,
    pub from: String,
    pub to: String,
}

/// 기존 항목을 백업하고 그 자리에 놓은 항목.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ReplacedItem {
    pub dir: PathBuf,
    pub name: String,
    pub backup: PathBuf,
}

/// 건너뛴 항목 (`dir` 안의 `name`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SkippedItem {
    pub dir: PathBuf,
    pub name: String,
}

/// 한 아카이브의 "여기에 풀기" 결과 — 프론트가 일괄당 알림 하나로 모아 보여준다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ExtractHereSummary {
    pub archive_name: String,
    /// 새로 놓은 항목 수 (병합 안쪽 파일 포함).
    pub placed: u32,
    pub renamed: Vec<RenamedItem>,
    pub replaced: Vec<ReplacedItem>,
    pub skipped: Vec<SkippedItem>,
    /// 휴지통으로도 못 보내 남은 준비 폴더.
    pub leftover_staging: Option<PathBuf>,
}

impl ExtractHereSummary {
    /// 사용자에게 알릴 것이 있는가 (이름 바꿈·교체·건너뜀·남은 준비 폴더).
    pub fn is_notable(&self) -> bool {
        !self.renamed.is_empty()
            || !self.replaced.is_empty()
            || !self.skipped.is_empty()
            || self.leftover_staging.is_some()
    }
}

/// 이 아카이브를 여기에 풀 수 있는지 (작업을 걸기 전 검사) — 로컬이고 풀 수 있는 아카이브.
pub async fn check_extract_here(fs: &dyn FileSystem, archive: &EntryRef) -> Result<(), DuetError> {
    check_here(fs, archive).await.map(|_| ())
}

async fn check_here(
    fs: &dyn FileSystem,
    archive: &EntryRef,
) -> Result<archive::ArchiveFormat, DuetError> {
    if !matches!(archive.location.source, SourceId::Local) {
        return Err(DuetError::NotSupported(
            "extract here is available for archives on this computer only".into(),
        ));
    }
    archive::check_extractable(fs, archive).await
}

/// Replace 에서 보호할 원본 아카이브 경로 — `batch` 중 `archive` 와 같은 위치(같은 source·
/// 같은 폴더)에 지금 일반 파일로 있는 것만. 프론트가 넘긴 목록을 그대로 믿지 않고 다시
/// 확인한다. 암호 재시도도 처음 일괄 목록을 넘겨 형제 원본을 계속 보호한다.
pub async fn protected_sources(
    fs: &dyn FileSystem,
    archive: &EntryRef,
    batch: &[EntryRef],
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for b in batch {
        if b.location.source != archive.location.source || b.location.path != archive.location.path
        {
            continue;
        }
        let path = fs.join(&b.location.path, &b.name);
        if matches!(fs.symlink_metadata(&path).await, Ok(m) if m.kind == EntryKind::File) {
            out.push(path);
        }
    }
    out
}

/// 아카이브 하나를 그 폴더에 바로 푼다. `protect` = Replace 로도 건드리지 않을 경로
/// (같은 일괄의 다른 아카이브). 이 아카이브 자신은 늘 보호된다.
pub async fn extract_here_execute(
    fs: &dyn FileSystem,
    archive: EntryRef,
    policy: ExtractConflict,
    password: Option<String>,
    protect: &[PathBuf],
    ctx: &OpCtx,
    cancel: CancellationToken,
) -> Result<(JournalEntry, UnpackReport, ExtractHereSummary), DuetError> {
    let format = check_here(fs, &archive).await?;
    let dir = archive.location.path.clone();
    let archive_path = fs.join(&dir, &archive.name);
    let staging = fs.join(
        &dir,
        &format!("{STAGING_PREFIX}{}", uuid::Uuid::new_v4().simple()),
    );
    fs.mkdir(&staging).await?;

    // 1. 준비 — 여기서 실패하면 사용자 폴더엔 아무것도 없다.
    let unpacked = if cancel.is_cancelled() {
        Err(DuetError::Cancelled)
    } else {
        archive::extract_local(&archive_path, &staging, format, password, None).await
    };
    let report = match unpacked {
        Ok(r) => r,
        Err(e) => {
            let leftover = cleanup_staging(fs, &staging, &[]).await;
            return Err(with_leftover(e, leftover.as_deref()));
        }
    };

    // 2. 배치.
    let mut protected: Vec<PathBuf> = protect.to_vec();
    protected.push(archive_path.clone());
    let mut placer = Placer {
        fs,
        policy,
        cancel: &cancel,
        protected,
        created: Vec::new(),
        backups: Vec::new(),
        merged: Vec::new(),
        summary: ExtractHereSummary {
            archive_name: archive.name.clone(),
            ..ExtractHereSummary::default()
        },
    };
    let placed = placer.run(&staging, &dir).await;

    // 4. 준비 폴더 정리 (3 의 journal 보다 먼저 — 남은 경로를 요약에 싣는다).
    let leftover = cleanup_staging(fs, &staging, &placer.merged).await;
    placer.summary.leftover_staging = leftover.clone();

    // 3. journal — 도중에 멈췄어도 놓은 것이 있으면 기록한 뒤 에러.
    if let Err(e) = &placed {
        if placer.created.is_empty() && placer.backups.is_empty() {
            return Err(with_leftover(e.clone(), leftover.as_deref()));
        }
    }
    let source = archive.location.source.clone();
    let copied_stamps = crate::core::stamp::stamp_all(fs, &placer.created).await;
    let undo = UndoAction::UndoCopy {
        target_source: source.clone(),
        copied: placer.created,
        backups_to_restore: placer.backups,
        src_source: None,
        copied_from: Vec::new(),
        copied_stamps,
    };
    let op = OpKind::Extract {
        archive: Location {
            source: source.clone(),
            path: archive_path,
        },
        dest: Location { source, path: dir },
    };
    let entry = ctx.journal.push(op, undo).await?;
    match placed {
        Ok(()) => Ok((entry, report, placer.summary)),
        Err(e) => Err(with_leftover(e, leftover.as_deref())),
    }
}

/// 옮길 것 하나 — 준비 폴더의 `staged` 를 `parent` 안 `name` 으로.
struct Job {
    staged: PathBuf,
    parent: PathBuf,
    name: String,
}

struct Placer<'a> {
    fs: &'a dyn FileSystem,
    policy: ExtractConflict,
    cancel: &'a CancellationToken,
    /// Replace 로도 옮기지 않을 경로 (원본 아카이브들).
    protected: Vec<PathBuf>,
    /// 이 작업이 새로 만든 맨 위 경로 — undo 가 (지문이 같을 때) 휴지통으로.
    created: Vec<PathBuf>,
    backups: Vec<BackupRestore>,
    /// 기존 폴더로 병합한 준비 쪽 폴더 (부모 먼저) — 끝나고 비었으면 지운다.
    merged: Vec<PathBuf>,
    summary: ExtractHereSummary,
}

impl Placer<'_> {
    /// 준비 폴더의 맨 위 항목부터 차례로 놓는다. 병합은 재귀 대신 작업 더미로.
    async fn run(&mut self, staging: &Path, dir: &Path) -> Result<(), DuetError> {
        let mut stack = self.children(staging, dir).await?;
        while let Some(job) = stack.pop() {
            if self.cancel.is_cancelled() {
                return Err(DuetError::Cancelled);
            }
            self.place(job, &mut stack).await?;
        }
        Ok(())
    }

    /// `staged_dir` 의 자식들을 `parent` 로 옮길 작업 — 이름 오름차순으로 꺼내지게 뒤집어 둔다.
    async fn children(&self, staged_dir: &Path, parent: &Path) -> Result<Vec<Job>, DuetError> {
        let mut names: Vec<String> = self
            .fs
            .list(staged_dir)
            .await?
            .into_iter()
            .map(|e| e.name)
            .collect();
        names.sort_by(|a, b| b.cmp(a));
        Ok(names
            .into_iter()
            .map(|name| Job {
                staged: self.fs.join(staged_dir, &name),
                parent: parent.to_path_buf(),
                name,
            })
            .collect())
    }

    async fn place(&mut self, job: Job, stack: &mut Vec<Job>) -> Result<(), DuetError> {
        // 준비 쪽 종류는 lstat — 링크는 링크로 옮긴다(대상 트리로 들어가지 않음).
        let is_dir = self.fs.symlink_metadata(&job.staged).await?.kind == EntryKind::Dir;
        let kind = if is_dir { Reserve::Dir } else { Reserve::File };
        let target = self.fs.join(&job.parent, &job.name);
        if try_reserve(self.fs, &target, kind).await? {
            return self.fill(&job.staged, &target, is_dir).await;
        }
        // 폴더 ↔ 기존 진짜 폴더 → 병합. 링크(폴더를 가리켜도)는 따라가지 않고 충돌로 본다.
        if is_dir {
            if let Ok(m) = self.fs.symlink_metadata(&target).await {
                if m.kind == EntryKind::Dir {
                    self.merged.push(job.staged.clone());
                    let kids = self.children(&job.staged, &target).await?;
                    stack.extend(kids);
                    return Ok(());
                }
            }
        }
        self.conflict(job, target, kind).await
    }

    async fn conflict(
        &mut self,
        job: Job,
        target: PathBuf,
        kind: Reserve,
    ) -> Result<(), DuetError> {
        let policy = if self.policy == ExtractConflict::Replace && self.is_protected(&target) {
            // 원본 아카이브는 옮기지 않는다 — 이 항목만 둘 다 유지로.
            ExtractConflict::KeepBoth
        } else {
            self.policy
        };
        match policy {
            ExtractConflict::Skip => {
                self.summary.skipped.push(SkippedItem {
                    dir: job.parent,
                    name: job.name,
                });
                Ok(())
            }
            ExtractConflict::KeepBoth => self.keep_both(job, kind).await,
            ExtractConflict::Replace => {
                let backup = ops::pick_backup_path(self.fs, &job.parent, &job.name).await?;
                self.fs.rename(&target, &backup).await?;
                self.backups.push(BackupRestore {
                    backup_path: backup.clone(),
                    original_path: target.clone(),
                    applied: None,
                });
                if try_reserve(self.fs, &target, kind).await? {
                    self.summary.replaced.push(ReplacedItem {
                        dir: job.parent.clone(),
                        name: job.name.clone(),
                        backup,
                    });
                    self.fill(&job.staged, &target, kind == Reserve::Dir).await
                } else {
                    // 백업과 예약 사이에 다른 것이 생김 — 그것도 덮지 않고 새 이름으로.
                    self.keep_both(job, kind).await
                }
            }
        }
    }

    async fn keep_both(&mut self, job: Job, kind: Reserve) -> Result<(), DuetError> {
        let (path, to) = reserve_free(self.fs, &job.parent, &job.name, kind, None).await?;
        self.summary.renamed.push(RenamedItem {
            dir: job.parent.clone(),
            from: job.name.clone(),
            to,
        });
        self.fill(&job.staged, &path, kind == Reserve::Dir).await
    }

    /// 방금 예약한 `target` 을 `staged` 로 채운다.
    async fn fill(&mut self, staged: &Path, target: &Path, is_dir: bool) -> Result<(), DuetError> {
        if is_dir {
            // 먼저 기록 — 자식 이동이 도중에 실패해도 옮긴 만큼은 Ctrl+Z 대상이다.
            self.created.push(target.to_path_buf());
            self.summary.placed += 1;
            // 방금 만든 빈 폴더라 자식 이름이 부딪히지 않는다고 본다 — 그 사이 외부 프로그램이
            // 이 폴더에 쓰는 경우는 다시 확인하지 않는다(최선 노력, 모듈 문서 참조).
            for e in self.fs.list(staged).await? {
                let from = self.fs.join(staged, &e.name);
                let to = self.fs.join(target, &e.name);
                self.fs.rename(&from, &to).await?;
            }
            // 비었으면 지운다. 실패해도 준비 폴더 정리가 처리한다.
            let _ = self.fs.remove_empty_dir(staged).await;
            return Ok(());
        }
        // 파일·링크 — 우리가 만든 빈 자리 위로 rename. 그 사이 다른 프로그램이 그 자리에
        // 썼으면(더는 0바이트 일반 파일이 아님) 덮지 않고 건너뛴다. 이 확인과 rename 사이의
        // 짧은 틈은 남는다(최선 노력).
        if !self.still_placeholder(target).await {
            self.summary.skipped.push(SkippedItem {
                dir: target.parent().map(Path::to_path_buf).unwrap_or_default(),
                name: target
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            });
            return Ok(());
        }
        match self.fs.rename(staged, target).await {
            Ok(()) => {
                self.created.push(target.to_path_buf());
                self.summary.placed += 1;
                Ok(())
            }
            Err(e) => {
                // 빈 자리는 지우지 않는다(§3) — journal 에 실어 Ctrl+Z 가 (지문이 그대로면)
                // 휴지통으로 보낸다. 에러에 그 자리를 알린다.
                self.created.push(target.to_path_buf());
                Err(with_placeholder(e, target))
            }
        }
    }

    /// `target` 이 아직 우리가 예약한 빈 자리(0바이트 일반 파일)인가.
    async fn still_placeholder(&self, target: &Path) -> bool {
        matches!(
            self.fs.symlink_metadata(target).await,
            Ok(m) if m.kind == EntryKind::File && m.size == Some(0)
        )
    }

    /// 대소문자 무시 비교 — 대소문자 구분 없는 볼륨에서 다른 표기로 원본을 가리켜도 보호.
    fn is_protected(&self, target: &Path) -> bool {
        let t = target.to_string_lossy().to_lowercase();
        self.protected
            .iter()
            .any(|p| p.to_string_lossy().to_lowercase() == t)
    }
}

/// 준비 폴더 정리 — 병합하고 비은 하위 폴더를 지우고, 준비 폴더가 비었으면 지운다.
/// 남은 것이 있으면 휴지통으로(§3). 휴지통도 실패하면 그 경로를 돌려준다.
async fn cleanup_staging(
    fs: &dyn FileSystem,
    staging: &Path,
    merged: &[PathBuf],
) -> Option<PathBuf> {
    for d in merged.iter().rev() {
        let _ = fs.remove_empty_dir(d).await;
    }
    if fs.remove_empty_dir(staging).await.is_ok() {
        return None;
    }
    if fs.symlink_metadata(staging).await.is_err() {
        return None;
    }
    let batch_id = crate::services::trash::new_batch_id();
    match fs.trash(staging, &batch_id).await {
        Ok(_) => None,
        Err(e) => {
            tracing::warn!(error = %e, "extract-here: staging folder left in place");
            Some(staging.to_path_buf())
        }
    }
}

/// rename 실패로 남은 빈 자리를 메시지에 덧붙인다 (종류는 유지).
fn with_placeholder(e: DuetError, placeholder: &Path) -> DuetError {
    match e {
        DuetError::Io(msg) => DuetError::Io(format!(
            "{msg} (an empty placeholder was left at {}; Ctrl+Z removes it)",
            placeholder.display()
        )),
        e => e,
    }
}

/// 준비 폴더가 남았으면 메시지에 덧붙인다. 종류(NeedPassword 등)는 바꾸지 않는다 —
/// 프론트가 종류로 암호 재시도를 판단한다.
fn with_leftover(e: DuetError, leftover: Option<&Path>) -> DuetError {
    match (e, leftover) {
        (DuetError::Io(msg), Some(p)) => {
            DuetError::Io(format!("{msg} (unplaced files left in {})", p.display()))
        }
        (e, _) => e,
    }
}

#[cfg(test)]
#[path = "archive_here_tests.rs"]
mod tests;
