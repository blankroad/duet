//! 파괴적 작업 로그 + undo 데이터.
//!
//! `<config_dir>/duet/journal.jsonl` append-only. 세션 시작 시 tail N 로드해
//! 메모리 캐시 (VecDeque) 복원. push/pop 은 메모리 우선 + 디스크 동기.

use crate::fs::persist;
use crate::services::settings::duet_config_dir;
use crate::services::startup_notices::{StartupNotice, StartupNoticeKind};
use crate::types::{DuetError, Location, SourceId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use uuid::Uuid;

const TAIL_LOAD_LIMIT: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct JournalId(pub Uuid);

impl JournalId {
    pub fn new() -> Self {
        // uuid v7 — 시간순 정렬 가능 (ULID 와 같은 특성)
        Self(Uuid::now_v7())
    }
}

impl Default for JournalId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct JournalEntry {
    pub id: JournalId,
    pub timestamp: DateTime<Utc>,
    pub op: OpKind,
    pub undo: UndoAction,
    pub undone: bool,
}

/// 표시용 op 요약.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpKind {
    Trash {
        count: u32,
        location: Location,
    },
    PermanentDelete {
        count: u32,
        location: Location,
    },
    Copy {
        count: u32,
        src: Location,
        dst: Location,
    },
    Move {
        count: u32,
        src: Location,
        dst: Location,
    },
    Rename {
        from: PathBuf,
        to: PathBuf,
        source: SourceId,
    },
    BatchRename {
        count: u32,
        location: Location,
    },
    Mkdir {
        path: PathBuf,
        source: SourceId,
    },
    Extract {
        archive: Location,
        dest: Location,
    },
    Compress {
        count: u32,
        dst: Location,
    },
    Sync {
        count: u32,
        /// prune 로 휴지통으로 보낸(삭제 전파) 개수.
        pruned: u32,
        src: Location,
        dst: Location,
    },
    /// 양방향 머지 — 한쪽에만 있던 파일을 반대편으로 복사(양쪽 모두). 충돌은 건드리지 않음.
    Merge {
        left: Location,
        right: Location,
        /// 오른쪽→왼쪽으로 복사한 개수 / 왼쪽→오른쪽으로 복사한 개수.
        to_left: u32,
        to_right: u32,
    },
    /// 비교창에서 행별 방향을 골라 적용 — 생성 + 덮어쓰기(백업 후) 혼합.
    CompareApply {
        left: Location,
        right: Location,
        /// 실제 복사한 항목 수 / 그중 덮어쓰기(백업 생성)한 수.
        applied: u32,
        overwritten: u32,
    },
    /// 3-way 자동 해결 적용 — base 대비 한쪽 변경/추가/삭제를 반대편에 반영.
    ThreeWayApply {
        base: Location,
        left: Location,
        right: Location,
        /// 자동 적용한 항목 수 / 건너뛴 충돌 수.
        applied: u32,
        conflicts: u32,
    },
    /// 권한(chmod) 변경 — 비재귀는 undo 가능(이전 mode 기록), 재귀는 Irreversible.
    Chmod {
        count: u32,
        mode: u32,
        recursive: bool,
        location: Location,
    },
    /// 소유자(chown) 변경 — 원격 전용. 이전 소유자 기록이 없어 Irreversible.
    Chown {
        count: u32,
        spec: String,
        recursive: bool,
        location: Location,
    },
    /// 심볼릭 링크 생성.
    Symlink {
        path: PathBuf,
        source: SourceId,
    },
    /// 빈 파일 생성.
    NewFile {
        path: PathBuf,
        source: SourceId,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UndoAction {
    RestoreFromTrash {
        source: SourceId,
        items: Vec<TrashItem>,
    },
    UndoCopy {
        target_source: SourceId,
        copied: Vec<PathBuf>,
        backups_to_restore: Vec<BackupRestore>,
        /// redo 용 원본 소스 — 구버전 journal 라인엔 없음(default → redo 불가).
        #[serde(default)]
        src_source: Option<SourceId>,
        /// `copied[i]` 의 원본 경로(병렬 배열). 구버전/아카이브 추출은 빈 벡터.
        #[serde(default)]
        copied_from: Vec<PathBuf>,
    },
    UndoMove {
        src_source: SourceId,
        dst_source: SourceId,
        moved: Vec<MoveItem>,
        backups_to_restore: Vec<BackupRestore>,
    },
    UndoRename {
        source: SourceId,
        current: PathBuf,
        original: PathBuf,
    },
    UndoBatchRename {
        source: SourceId,
        /// 모든 항목을 한 번에 되돌리기 위한 (현재 → 원본) 쌍 목록.
        pairs: Vec<RenamePair>,
    },
    UndoMkdir {
        source: SourceId,
        path: PathBuf,
    },
    /// 양방향 머지 되돌리기 — 양쪽에 새로 복사된 파일들을 제거(충돌은 안 건드렸으므로 복원할 백업 없음).
    UndoBidirMerge {
        left_source: SourceId,
        left_created: Vec<PathBuf>,
        right_source: SourceId,
        right_created: Vec<PathBuf>,
        /// redo 용 성공 복사 쌍 — created 와 달리 partial 정리 항목 제외.
        /// left_pairs = 왼쪽에 생성(from 은 right 측 경로). 구버전 라인은 빈 벡터.
        #[serde(default)]
        left_pairs: Vec<RedoCopyPair>,
        #[serde(default)]
        right_pairs: Vec<RedoCopyPair>,
    },
    /// 단방향 sync 되돌리기 — 새로 복사 제거 + 덮어쓴 백업 복원 + prune 삭제분 휴지통 복원.
    /// (휴지통 복원은 best-effort — macOS 로컬은 NotSupported 라 수동 복원 필요.)
    UndoSync {
        dst_source: SourceId,
        created: Vec<PathBuf>,
        backups_to_restore: Vec<BackupRestore>,
        pruned: Vec<TrashItem>,
        /// redo 용 원본 소스 — 구버전 라인엔 없음(default → redo 불가).
        #[serde(default)]
        src_source: Option<SourceId>,
        /// `created[i]` 의 원본 경로(병렬 배열). 구버전은 빈 벡터.
        #[serde(default)]
        created_from: Vec<PathBuf>,
    },
    /// 비교 적용 되돌리기 — 양쪽 각각 새로 생성분 제거 + 덮어쓴 백업 복원.
    /// (방향이 ToLeft/ToRight 혼합이라 양쪽 모두 추적.)
    UndoCompareApply {
        left_source: SourceId,
        right_source: SourceId,
        left_created: Vec<PathBuf>,
        right_created: Vec<PathBuf>,
        left_backups: Vec<BackupRestore>,
        right_backups: Vec<BackupRestore>,
        /// redo 용 성공 복사 쌍 (신규 생성만 — 덮어쓰기 행 제외). 구버전은 빈 벡터.
        #[serde(default)]
        left_pairs: Vec<RedoCopyPair>,
        #[serde(default)]
        right_pairs: Vec<RedoCopyPair>,
    },
    /// 3-way 적용 되돌리기 — 생성분 제거 + 덮어쓴 백업 복원 + 삭제(휴지통)분 복원.
    UndoThreeWayApply {
        left_source: SourceId,
        right_source: SourceId,
        left_created: Vec<PathBuf>,
        right_created: Vec<PathBuf>,
        left_backups: Vec<BackupRestore>,
        right_backups: Vec<BackupRestore>,
        trashed_left: Vec<TrashItem>,
        trashed_right: Vec<TrashItem>,
    },
    /// chmod 되돌리기 — 항목별 이전 mode 재적용 (비재귀 chmod 만 기록됨).
    UndoChmod {
        source: SourceId,
        items: Vec<ChmodItem>,
    },
    /// 심볼릭 링크 생성 되돌리기 — 링크 자체만 제거(대상 불변).
    UndoSymlink {
        source: SourceId,
        path: PathBuf,
    },
    /// 빈 파일 생성 되돌리기 — 여전히 빈 파일일 때만 제거(내용이 생겼으면 skip).
    UndoNewFile {
        source: SourceId,
        path: PathBuf,
    },
    Irreversible,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TrashItem {
    /// 로컬 trash crate 의 native id 또는 원격 batch dir 안의 path.
    pub trash_path: String,
    pub original_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BackupRestore {
    pub backup_path: PathBuf,
    pub original_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MoveItem {
    pub src_original: PathBuf,
    pub dst_now: PathBuf,
}

/// redo 용 (원본 → 대상) 복사 쌍 — merge/compare-apply 의 성공한 복사만 기록.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RedoCopyPair {
    pub from: PathBuf,
    pub to: PathBuf,
}

/// batch rename 의 항목별 (현재 경로 → 원래 경로) — undo 시 단일 그룹으로 복원.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RenamePair {
    pub current: PathBuf,
    pub original: PathBuf,
}

/// chmod undo 항목 — 적용 전 mode 로 되돌리기 위한 (경로, 이전 mode).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ChmodItem {
    pub path: PathBuf,
    pub old_mode: u32,
}

/// jsonl 한 줄. push 새 entry 또는 기존 entry undone 토글.
/// `Push` variant 가 ~400B 라 enum 크기 차이가 커서 Box 로 indirect.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
enum JsonlRecord {
    Push(Box<JournalEntry>),
    MarkUndone {
        id: JournalId,
    },
    /// redo 성공 — undone 을 false 로 되돌림 (undo 의 역마킹).
    MarkRedone {
        id: JournalId,
    },
}

pub struct Journal {
    path: PathBuf,
    inner: Mutex<VecDeque<JournalEntry>>,
    /// 파일 append 직렬화(fileops-01) — 동시 push 의 줄이 섞이지 않게 한 번에 하나만 쓴다.
    writer: Mutex<AppendState>,
    /// 시작 로드 때 깨진 줄을 건너뛰었으면 그 내역(사용자 알림용).
    load_notice: Option<StartupNotice>,
}

/// append 잠금이 지키는 파일 끝 상태.
struct AppendState {
    /// 다음 기록 앞에 `\n` 이 필요한가 — 마지막 줄이 줄바꿈 없이 끝났거나(쓰다 끊김)
    /// 지난 쓰기가 중간에 실패해 일부만 남았을 수 있을 때. 빈 줄은 로드 때 무시되므로
    /// 필요 없을 때 하나 더 써도 무해하다.
    needs_newline: bool,
}

impl Journal {
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("journal.jsonl");
        Self::load_from(&path).await
    }

    /// 파일을 읽어 마지막 [`TAIL_LOAD_LIMIT`] 개를 메모리에 올린다. 없으면 빈 journal.
    ///
    /// 깨진 줄은 건너뛰고 나머지를 살린다(시작 불가 방지, fileops-01). 읽기 IO 오류만 `Err`.
    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let loaded = load_file(path, TAIL_LOAD_LIMIT).await?;
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: Mutex::new(loaded.entries),
            writer: Mutex::new(AppendState {
                needs_newline: loaded.needs_newline,
            }),
            load_notice: loaded.notice,
        }))
    }

    /// 시작 로드 때 깨진 줄을 건너뛰었으면 그 알림. 정상이면 `None`.
    pub fn load_notice(&self) -> Option<StartupNotice> {
        self.load_notice.clone()
    }

    /// 새 entry 추가 — 메모리 + 디스크.
    pub async fn push(&self, op: OpKind, undo: UndoAction) -> Result<JournalEntry, DuetError> {
        let entry = JournalEntry {
            id: JournalId::new(),
            timestamp: Utc::now(),
            op,
            undo,
            undone: false,
        };
        self.append(JsonlRecord::Push(Box::new(entry.clone())))
            .await?;
        let mut lock = self.inner.lock().await;
        lock.push_back(entry.clone());
        if lock.len() > TAIL_LOAD_LIMIT {
            lock.pop_front();
        }
        Ok(entry)
    }

    /// 가장 최근 undone == false entry 를 **마킹 없이** 반환. `None` 이면 undo 할 게 없음.
    ///
    /// undo 실행 *전* 조회용. 실제 undone 확정은 실행 성공 후 [`commit_undone`] 으로.
    /// (이전 `pop_undoable` 은 실행 전에 undone 을 박아, undo 실패 시 영구 손실됐음.)
    pub async fn peek_undoable(&self) -> Result<Option<JournalEntry>, DuetError> {
        let lock = self.inner.lock().await;
        Ok(lock
            .iter()
            .rposition(|e| !e.undone)
            .map(|i| lock[i].clone()))
    }

    /// undo 실행 성공(또는 비가역 종결) 후 호출 — 메모리 + 디스크에 undone 확정. 멱등.
    /// 캐시에서 이미 밀려난 오래된 id 는 no-op (디스크 replay 가 이미 반영).
    pub async fn commit_undone(&self, id: JournalId) -> Result<(), DuetError> {
        {
            let mut lock = self.inner.lock().await;
            match lock.iter_mut().find(|e| e.id == id) {
                Some(e) if !e.undone => e.undone = true,
                _ => return Ok(()),
            }
        }
        self.append(JsonlRecord::MarkUndone { id }).await
    }

    /// 꼬리쪽 연속 undone 구간에서 **가장 이른** entry — 다음 redo 대상 (LIFO 역순).
    ///
    /// undo 가 B→A 순서로 진행됐다면 redo 는 A→B 순서. 마지막 entry 가 undone 이
    /// 아니면(새 작업이 이후에 push 됨) redo 불가 — 표준 undo/redo 스택 관례.
    pub async fn peek_redoable(&self) -> Result<Option<JournalEntry>, DuetError> {
        let lock = self.inner.lock().await;
        let mut candidate = None;
        for e in lock.iter().rev() {
            if e.undone {
                candidate = Some(e.clone());
            } else {
                break;
            }
        }
        Ok(candidate)
    }

    /// redo 실행 성공 후 호출 — undone 을 false 로 되돌림. 멱등.
    pub async fn commit_redone(&self, id: JournalId) -> Result<(), DuetError> {
        {
            let mut lock = self.inner.lock().await;
            match lock.iter_mut().find(|e| e.id == id) {
                Some(e) if e.undone => e.undone = false,
                _ => return Ok(()),
            }
        }
        self.append(JsonlRecord::MarkRedone { id }).await
    }

    pub async fn history(&self, limit: usize) -> Vec<JournalEntry> {
        let lock = self.inner.lock().await;
        lock.iter().rev().take(limit).cloned().collect()
    }

    /// 기록 한 줄을 파일 끝에 붙인다.
    ///
    /// 잠금 안에서 본문과 `\n` 을 한 버퍼로 한 번에 쓰고 `sync_data` 한다 — 동시 push 가
    /// 줄을 섞거나, 본문만 쓰고 끊겨 다음 기록이 같은 줄에 붙는 일을 막는다(fileops-01).
    async fn append(&self, record: JsonlRecord) -> Result<(), DuetError> {
        let line = serde_json::to_string(&record)
            .map_err(|e| DuetError::Io(format!("journal serialize: {e}")))?;
        let mut state = self.writer.lock().await;
        let mut buf = Vec::with_capacity(line.len() + 2);
        if state.needs_newline {
            buf.push(b'\n');
        }
        buf.extend_from_slice(line.as_bytes());
        buf.push(b'\n');
        // 실패하면 일부만 써졌을 수 있다 → 그때는 다음 기록을 줄바꿈부터 시작.
        state.needs_newline = true;
        append_bytes(&self.path, &buf).await?;
        state.needs_newline = false;
        Ok(())
    }
}

async fn append_bytes(path: &Path, buf: &[u8]) -> Result<(), DuetError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(DuetError::from)?;
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(DuetError::from)?;
    file.write_all(buf).await.map_err(DuetError::from)?;
    file.sync_data().await.map_err(DuetError::from)?;
    Ok(())
}

/// [`load_file`] 결과.
struct LoadedJournal {
    entries: VecDeque<JournalEntry>,
    needs_newline: bool,
    notice: Option<StartupNotice>,
}

/// 줄 단위 해석 결과 — 파일에 남길 기록을 원래 순서대로.
#[derive(Default)]
struct Scan {
    /// (원문, 해석). 해석이 `None` 이면 이 버전이 모르는 기록 — 재생은 안 하고 파일엔 보존.
    kept: Vec<(String, Option<JsonlRecord>)>,
    /// 읽을 수 없어 버린 조각 수.
    dropped: u32,
    /// 한 줄에 붙어 있던 기록(`{…}{…}`)을 나눈 줄 수.
    split: u32,
    /// 첫 번째 깨진 조각의 오류(알림 "자세히"용).
    first_error: Option<String>,
}

/// journal 파일 읽기 — 깨진 줄은 건너뛰고, 있으면 원본 사본을 남긴 뒤 살린 줄로 다시 쓴다.
///
/// 정책: 깨진 줄은 버린다. 그 줄이 `MarkUndone` 이었다면 해당 항목은 "안 되돌림"으로
/// 보이게 되지만, 파일 전체를 못 읽어 앞의 정상 기록까지 잃는 것보다 낫다.
/// 다시 쓰는 이유는 같은 알림이 매 부팅 반복되지 않게 하기 위해서다.
async fn load_file(path: &Path, limit: usize) -> Result<LoadedJournal, DuetError> {
    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LoadedJournal {
                entries: VecDeque::new(),
                needs_newline: false,
                notice: None,
            })
        }
        Err(e) => return Err(DuetError::from(e)),
    };
    let mut needs_newline = bytes.last().is_some_and(|b| *b != b'\n');
    let scan = scan_lines(&bytes);
    let entries = replay(&scan, limit);

    let mut notice = None;
    if scan.dropped > 0 || scan.split > 0 {
        // 버리는 내용이 있으면 원본 사본부터. 사본을 못 남기면
        // 원본을 다시 쓰지 않는다 — 깨진 줄은 다음 로드 때도 건너뛰니 동작엔 문제없다.
        let mut backup = None;
        let mut can_rewrite = true;
        if scan.dropped > 0 {
            match persist::backup_copy(path).await {
                Ok(b) => backup = Some(b),
                Err(e) => {
                    tracing::warn!("journal backup failed, leaving file as is: {e}");
                    can_rewrite = false;
                }
            }
        }
        if can_rewrite {
            let mut out = String::new();
            for (raw, _) in &scan.kept {
                out.push_str(raw);
                out.push('\n');
            }
            match persist::write_atomic(path, out.as_bytes()).await {
                Ok(()) => needs_newline = false,
                Err(e) => tracing::warn!("journal rewrite failed: {e}"),
            }
        }
        if scan.dropped > 0 {
            tracing::warn!(
                "journal: skipped {} unreadable record(s) in {}",
                scan.dropped,
                path.display()
            );
            notice = Some(StartupNotice {
                file: path.to_path_buf(),
                action: StartupNoticeKind::SkippedLines {
                    count: scan.dropped,
                    backup,
                },
                detail: scan.first_error.clone().unwrap_or_default(),
            });
        }
    }
    Ok(LoadedJournal {
        entries,
        needs_newline,
        notice,
    })
}

/// 줄마다: 아는 기록 → 재생 대상, 모르는 JSON 객체 → 보존만, 그 밖 → 버림(개수 셈).
/// 한 줄에 기록이 붙어 있으면(`{…}{…}`) 나눠서 살린다.
///
/// UTF-8 검사는 줄 단위로 엄격하게 한다 — 파일 전체를 lossy 변환하면 기록 안 경로의
/// 잘못된 바이트가 U+FFFD 로 바뀐 채 "정상" 기록으로 재생돼 엉뚱한 경로로 undo 할 수 있다.
fn scan_lines(bytes: &[u8]) -> Scan {
    let mut scan = Scan::default();
    for (i, raw) in bytes.split(|b| *b == b'\n').enumerate() {
        let Ok(line) = std::str::from_utf8(raw) else {
            scan.drop_piece(i, "not valid UTF-8");
            continue;
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(rec) = serde_json::from_str::<JsonlRecord>(line) {
            scan.kept.push((line.to_string(), Some(rec)));
            continue;
        }
        let mut stream = serde_json::Deserializer::from_str(line).into_iter::<serde_json::Value>();
        let mut start = 0;
        let mut pieces = 0u32;
        while let Some(next) = stream.next() {
            match next {
                Ok(value) => {
                    let end = stream.byte_offset();
                    let raw = line.get(start..end).unwrap_or("").trim().to_string();
                    start = end;
                    pieces += 1;
                    if !value.is_object() {
                        scan.drop_piece(i, "not a journal record");
                        continue;
                    }
                    match serde_json::from_value::<JsonlRecord>(value) {
                        Ok(rec) => scan.kept.push((raw, Some(rec))),
                        Err(e) => {
                            // 정상 JSON 객체인데 모르는 형식 — 새 버전이 쓴 기록일 수 있어
                            // 지우지 않는다(다운그레이드 후 다시 올렸을 때 살아 있게).
                            tracing::warn!("journal line {}: unknown record kept: {e}", i + 1);
                            scan.kept.push((raw, None));
                        }
                    }
                }
                Err(e) => {
                    scan.drop_piece(i, &e.to_string());
                    break;
                }
            }
        }
        if pieces > 1 {
            scan.split += 1;
        }
    }
    scan
}

impl Scan {
    fn drop_piece(&mut self, line_idx: usize, why: &str) {
        self.dropped += 1;
        if self.first_error.is_none() {
            self.first_error = Some(format!("line {}: {why}", line_idx + 1));
        }
    }
}

/// 살린 기록을 처음부터 재생(push / undone 토글) 후 마지막 `limit` 개.
fn replay(scan: &Scan, limit: usize) -> VecDeque<JournalEntry> {
    let mut entries: Vec<JournalEntry> = Vec::new();
    for rec in scan.kept.iter().filter_map(|(_, r)| r.as_ref()) {
        match rec {
            JsonlRecord::Push(e) => entries.push((**e).clone()),
            JsonlRecord::MarkUndone { id } => {
                if let Some(found) = entries.iter_mut().find(|e| e.id == *id) {
                    found.undone = true;
                }
            }
            JsonlRecord::MarkRedone { id } => {
                if let Some(found) = entries.iter_mut().find(|e| e.id == *id) {
                    found.undone = false;
                }
            }
        }
    }
    let start = entries.len().saturating_sub(limit);
    entries.drain(start..).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn mk_undo() -> UndoAction {
        UndoAction::Irreversible
    }
    fn mk_op() -> OpKind {
        OpKind::PermanentDelete {
            count: 1,
            location: Location {
                source: SourceId::Local,
                path: PathBuf::from("/tmp"),
            },
        }
    }

    #[tokio::test]
    async fn push_and_history() {
        let dir = tempdir().unwrap();
        let j = Journal::load_from(&dir.path().join("j.jsonl"))
            .await
            .unwrap();
        j.push(mk_op(), mk_undo()).await.unwrap();
        j.push(mk_op(), mk_undo()).await.unwrap();
        let h = j.history(10).await;
        assert_eq!(h.len(), 2);
    }

    #[tokio::test]
    async fn undo_copy_old_format_line_parses_with_defaults() {
        // 2단계에서 추가된 src_source/copied_from 이 없는 구버전 journal 라인 —
        // serde(default) 로 파싱돼야 기존 사용자 journal 이 안 깨진다.
        let dir = tempdir().unwrap();
        let path = dir.path().join("j.jsonl");
        let line = format!(
            r#"{{"type":"Push","id":"{}","timestamp":"2026-01-01T00:00:00Z","op":{{"kind":"copy","count":1,"src":{{"source":{{"kind":"local"}},"path":"/a"}},"dst":{{"source":{{"kind":"local"}},"path":"/b"}}}},"undo":{{"kind":"undo_copy","target_source":{{"kind":"local"}},"copied":["/b/x"],"backups_to_restore":[]}},"undone":false}}"#,
            Uuid::now_v7()
        );
        tokio::fs::write(&path, format!("{line}\n")).await.unwrap();
        let j = Journal::load_from(&path).await.unwrap();
        let h = j.history(10).await;
        assert_eq!(h.len(), 1);
        match &h[0].undo {
            UndoAction::UndoCopy {
                src_source,
                copied_from,
                ..
            } => {
                assert!(src_source.is_none());
                assert!(copied_from.is_empty());
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[tokio::test]
    async fn redo_peek_lifo_and_commit_roundtrip() {
        let dir = tempdir().unwrap();
        let j = Journal::load_from(&dir.path().join("j.jsonl"))
            .await
            .unwrap();
        let a = j.push(mk_op(), mk_undo()).await.unwrap();
        let b = j.push(mk_op(), mk_undo()).await.unwrap();
        // undo 진행 전엔 redo 없음.
        assert!(j.peek_redoable().await.unwrap().is_none());
        // undo 순서 B → A. redo 는 역순 A → B.
        j.commit_undone(b.id).await.unwrap();
        j.commit_undone(a.id).await.unwrap();
        assert_eq!(j.peek_redoable().await.unwrap().unwrap().id, a.id);
        j.commit_redone(a.id).await.unwrap();
        assert_eq!(j.peek_redoable().await.unwrap().unwrap().id, b.id);
        j.commit_redone(b.id).await.unwrap();
        assert!(j.peek_redoable().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn redo_blocked_by_new_push_and_survives_replay() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("j.jsonl");
        let j = Journal::load_from(&path).await.unwrap();
        let a = j.push(mk_op(), mk_undo()).await.unwrap();
        j.commit_undone(a.id).await.unwrap();
        // 새 push 가 끼면 마지막 entry 가 non-undone → redo 불가 (표준 관례).
        let b = j.push(mk_op(), mk_undo()).await.unwrap();
        assert!(j.peek_redoable().await.unwrap().is_none());
        j.commit_undone(b.id).await.unwrap();
        j.commit_redone(b.id).await.unwrap();
        // replay: MarkRedone 반영 — b 는 undone=false, a 는 여전히 undone.
        let j2 = Journal::load_from(&path).await.unwrap();
        let hist = j2.history(10).await;
        assert!(!hist.iter().find(|e| e.id == b.id).unwrap().undone);
        assert!(hist.iter().find(|e| e.id == a.id).unwrap().undone);
    }

    #[tokio::test]
    async fn peek_commit_walks_stack() {
        let dir = tempdir().unwrap();
        let j = Journal::load_from(&dir.path().join("j.jsonl"))
            .await
            .unwrap();
        let a = j.push(mk_op(), mk_undo()).await.unwrap();
        let b = j.push(mk_op(), mk_undo()).await.unwrap();
        // 가장 최근 = b, commit 해야 다음으로 넘어감
        assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, b.id);
        j.commit_undone(b.id).await.unwrap();
        // 다음 = a
        assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, a.id);
        j.commit_undone(a.id).await.unwrap();
        // 더 없음
        assert!(j.peek_undoable().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn peek_does_not_mark_until_commit() {
        let dir = tempdir().unwrap();
        let j = Journal::load_from(&dir.path().join("j.jsonl"))
            .await
            .unwrap();
        let a = j.push(mk_op(), mk_undo()).await.unwrap();
        // peek 을 여러 번 해도 같은 엔트리 — 아직 소비 안 됨(undo 실패 시 재시도 가능).
        assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, a.id);
        assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, a.id);
        // commit 후에만 소비됨.
        j.commit_undone(a.id).await.unwrap();
        assert!(j.peek_undoable().await.unwrap().is_none());
        // commit 멱등 — 두 번 호출해도 안전.
        j.commit_undone(a.id).await.unwrap();
    }

    #[tokio::test]
    async fn persists_across_load() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("j.jsonl");
        {
            let j = Journal::load_from(&path).await.unwrap();
            let a = j.push(mk_op(), mk_undo()).await.unwrap();
            j.commit_undone(a.id).await.unwrap();
        }
        // 새 인스턴스
        let j2 = Journal::load_from(&path).await.unwrap();
        let h = j2.history(10).await;
        assert_eq!(h.len(), 1);
        assert!(h[0].undone, "MarkUndone replay 가 적용되어야 함");
    }

    #[tokio::test]
    async fn tail_limit_bounds_memory() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("j.jsonl");
        let j = Journal::load_from(&path).await.unwrap();
        for _ in 0..(TAIL_LOAD_LIMIT + 50) {
            j.push(mk_op(), mk_undo()).await.unwrap();
        }
        assert_eq!(j.inner.lock().await.len(), TAIL_LOAD_LIMIT);
    }
}

/// 깨진·이어붙은·모르는 줄이 있는 journal 로드(fileops-01, shell-settings-01).
#[cfg(test)]
mod load_recovery {
    use super::*;
    use tempfile::tempdir;

    fn op() -> OpKind {
        OpKind::PermanentDelete {
            count: 1,
            location: Location {
                source: SourceId::Local,
                path: PathBuf::from("/tmp"),
            },
        }
    }

    /// 정상 기록 n 개를 쓴 journal 파일 경로와 그 줄들.
    async fn journal_with(dir: &Path, n: usize) -> (PathBuf, Vec<String>) {
        let path = dir.join("journal.jsonl");
        let j = Journal::load_from(&path).await.unwrap();
        for _ in 0..n {
            j.push(op(), UndoAction::Irreversible).await.unwrap();
        }
        let text = std::fs::read_to_string(&path).unwrap();
        (path, text.lines().map(str::to_string).collect())
    }

    fn all_lines_parse(path: &Path) -> usize {
        let text = std::fs::read_to_string(path).unwrap();
        for l in text.lines() {
            serde_json::from_str::<serde_json::Value>(l)
                .unwrap_or_else(|e| panic!("bad line {l:?}: {e}"));
        }
        text.lines().count()
    }

    #[tokio::test]
    async fn merged_records_on_one_line_are_split_and_kept() {
        let d = tempdir().unwrap();
        let (path, lines) = journal_with(d.path(), 2).await;
        std::fs::write(&path, format!("{}{}\n", lines[0], lines[1])).unwrap();
        let j = Journal::load_from(&path).await.unwrap();
        assert_eq!(j.history(10).await.len(), 2);
        // 잃은 것이 없으니 알림도 없다. 파일은 두 줄로 고쳐진다.
        assert!(j.load_notice().is_none());
        assert_eq!(all_lines_parse(&path), 2);
    }

    #[tokio::test]
    async fn corrupt_line_is_backed_up_reported_once_and_rewritten() {
        let d = tempdir().unwrap();
        let (path, lines) = journal_with(d.path(), 2).await;
        let original = format!("{}\ngarbage{{\n{}\n", lines[0], lines[1]);
        std::fs::write(&path, &original).unwrap();

        let j = Journal::load_from(&path).await.unwrap();
        assert_eq!(j.history(10).await.len(), 2);
        let notice = j.load_notice().expect("notice");
        assert_eq!(notice.file, path);
        let StartupNoticeKind::SkippedLines { count, backup } = notice.action else {
            panic!("expected SkippedLines");
        };
        assert_eq!(count, 1);
        assert!(notice.detail.starts_with("line 2:"), "{}", notice.detail);
        let backup = backup.expect("backup copy");
        assert_eq!(std::fs::read_to_string(backup).unwrap(), original);
        assert_eq!(all_lines_parse(&path), 2);

        // 다시 쓴 뒤라 다음 부팅은 조용하다.
        let again = Journal::load_from(&path).await.unwrap();
        assert!(again.load_notice().is_none());
        assert_eq!(again.history(10).await.len(), 2);
    }

    #[tokio::test]
    async fn unknown_records_are_kept_in_file_even_when_rewritten() {
        let d = tempdir().unwrap();
        let (path, lines) = journal_with(d.path(), 1).await;
        let future = r#"{"type":"SomethingNew","id":"x"}"#;
        // 새 버전이 쓴 op 종류(아는 type 이지만 모르는 내용)도 보존 대상.
        let future_push = r#"{"type":"Push","id":"0192","op":{"kind":"teleport"}}"#;
        std::fs::write(
            &path,
            format!("{}\n{future}\n{future_push}\n{{torn\n", lines[0]),
        )
        .unwrap();

        let j = Journal::load_from(&path).await.unwrap();
        assert_eq!(j.history(10).await.len(), 1);
        // 버린 것은 잘린 줄 하나뿐.
        match j.load_notice().map(|n| n.action) {
            Some(StartupNoticeKind::SkippedLines { count: 1, .. }) => {}
            other => panic!("unexpected notice {other:?}"),
        }
        j.push(op(), UndoAction::Irreversible).await.unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.lines().any(|l| l == future), "{text}");
        assert!(text.lines().any(|l| l == future_push), "{text}");
        assert!(!text.contains("torn"));

        let again = Journal::load_from(&path).await.unwrap();
        assert_eq!(again.history(10).await.len(), 2);
        assert!(again.load_notice().is_none());
    }

    #[tokio::test]
    async fn append_after_missing_trailing_newline_starts_a_new_line() {
        let d = tempdir().unwrap();
        let (path, lines) = journal_with(d.path(), 1).await;
        std::fs::write(&path, &lines[0]).unwrap();
        let j = Journal::load_from(&path).await.unwrap();
        assert!(j.load_notice().is_none());
        j.push(op(), UndoAction::Irreversible).await.unwrap();
        assert_eq!(all_lines_parse(&path), 2);
    }

    #[tokio::test]
    async fn non_utf8_line_is_skipped() {
        let d = tempdir().unwrap();
        let (path, lines) = journal_with(d.path(), 1).await;
        let mut bytes = format!("{}\n", lines[0]).into_bytes();
        bytes.extend_from_slice(&[0xff, 0xfe, b'\n']);
        std::fs::write(&path, &bytes).unwrap();
        let j = Journal::load_from(&path).await.unwrap();
        assert_eq!(j.history(10).await.len(), 1);
        let Some(StartupNoticeKind::SkippedLines { count: 1, backup }) =
            j.load_notice().map(|n| n.action)
        else {
            panic!("expected one skipped line");
        };
        assert_eq!(std::fs::read(backup.unwrap()).unwrap(), bytes);
    }

    /// 기록 안(JSON 문자열)의 잘못된 바이트 — lossy 변환하면 경로가 U+FFFD 로 바뀐
    /// "정상" 기록이 돼 엉뚱한 경로로 undo 할 수 있다. 그 줄은 깨진 줄로 버려야 한다.
    #[tokio::test]
    async fn invalid_utf8_inside_a_record_drops_only_that_line() {
        let d = tempdir().unwrap();
        let (path, lines) = journal_with(d.path(), 3).await;
        assert!(lines[1].contains("/tmp"), "{}", lines[1]);
        let mut bytes = format!("{}\n", lines[0]).into_bytes();
        let (head, tail) = lines[1].split_once("/tmp").unwrap();
        bytes.extend_from_slice(head.as_bytes());
        bytes.extend_from_slice(b"/tm\xffp");
        bytes.extend_from_slice(tail.as_bytes());
        bytes.push(b'\n');
        bytes.extend_from_slice(format!("{}\n", lines[2]).as_bytes());
        std::fs::write(&path, &bytes).unwrap();

        let j = Journal::load_from(&path).await.unwrap();
        let ids: Vec<String> = j
            .history(10)
            .await
            .iter()
            .rev()
            .map(|e| serde_json::to_string(&e.id).unwrap())
            .collect();
        assert_eq!(ids.len(), 2, "only the damaged record is dropped");
        assert!(lines[0].contains(&ids[0]) && lines[2].contains(&ids[1]));
        let Some(StartupNoticeKind::SkippedLines { count: 1, backup }) =
            j.load_notice().map(|n| n.action)
        else {
            panic!("expected one skipped line");
        };
        assert_eq!(std::fs::read(backup.unwrap()).unwrap(), bytes);
        assert_eq!(all_lines_parse(&path), 2);
    }

    #[tokio::test]
    async fn healthy_journal_has_no_notice_and_is_not_rewritten() {
        let d = tempdir().unwrap();
        let (path, _) = journal_with(d.path(), 2).await;
        let before = std::fs::read(&path).unwrap();
        let j = Journal::load_from(&path).await.unwrap();
        assert!(j.load_notice().is_none());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let names: Vec<_> = std::fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "no backup expected: {names:?}");
    }
}

/// fileops 점검(2026-11-08, opus) 재현 — journal.jsonl 손상 시 앱 시작 불가.
/// `lib.rs` 는 `Journal::load_default().await.expect("journal load")` 라서 load 실패 = 패닉.
#[cfg(test)]
mod review_fileops_opus {
    use super::*;
    use tempfile::tempdir;

    fn op() -> OpKind {
        OpKind::PermanentDelete {
            count: 1,
            location: Location {
                source: SourceId::Local,
                path: PathBuf::from("/tmp"),
            },
        }
    }

    /// 마지막 줄이 잘린 journal(쓰는 도중 강제 종료·전원 차단) — 앞의 정상 기록은 살리고
    /// 로드돼야 한다. 지금은 Err → 시작 시 panic.
    #[tokio::test]
    async fn truncated_last_line_must_not_fail_load() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal.jsonl");
        {
            let j = Journal::load_from(&path).await.unwrap();
            j.push(op(), UndoAction::Irreversible).await.unwrap();
            j.push(op(), UndoAction::Irreversible).await.unwrap();
        }
        // 세 번째 기록이 쓰이다 끊긴 상태.
        let mut text = tokio::fs::read_to_string(&path).await.unwrap();
        text.push_str("{\"type\":\"Push\",\"id\":\"0192");
        tokio::fs::write(&path, text).await.unwrap();

        let r = Journal::load_from(&path).await;
        assert!(
            r.is_ok(),
            "journal with a torn last line fails to load: {:?} — app startup panics",
            r.err()
        );
        assert_eq!(r.unwrap().history(10).await.len(), 2);
    }

    /// 새 버전이 쓴 모르는 op 종류(다운그레이드) 한 줄 때문에 전체 로드가 실패하면 안 된다.
    #[tokio::test]
    async fn unknown_record_kind_must_not_fail_load() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal.jsonl");
        {
            let j = Journal::load_from(&path).await.unwrap();
            j.push(op(), UndoAction::Irreversible).await.unwrap();
        }
        let mut text = tokio::fs::read_to_string(&path).await.unwrap();
        text.push_str("{\"type\":\"SomethingNew\",\"id\":\"x\"}\n");
        tokio::fs::write(&path, text).await.unwrap();
        let r = Journal::load_from(&path).await;
        assert!(r.is_ok(), "unknown record kind fails load: {:?}", r.err());
    }

    /// `append` 는 잠금 없이 줄 본문과 `\n` 을 **따로** write 한다. 동시에 끝난 작업
    /// 둘(호스트별 worker 는 병렬)이 push 하면 줄이 섞일 수 있다 → 다음 시작 때 load 실패.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn concurrent_pushes_keep_every_line_parseable() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal.jsonl");
        let j = Journal::load_from(&path).await.unwrap();
        let mut hs = Vec::new();
        for _ in 0..400 {
            let j = j.clone();
            hs.push(tokio::spawn(async move {
                j.push(op(), UndoAction::Irreversible).await.unwrap();
            }));
        }
        for h in hs {
            h.await.unwrap();
        }
        let text = tokio::fs::read_to_string(&path).await.unwrap();
        let bad: Vec<(usize, &str)> = text
            .lines()
            .enumerate()
            .filter(|(_, l)| serde_json::from_str::<JsonlRecord>(l).is_err())
            .collect();
        assert!(
            bad.is_empty(),
            "{} torn/merged lines after concurrent pushes, e.g. line {}: {:.120}",
            bad.len(),
            bad.first().map(|b| b.0 + 1).unwrap_or(0),
            bad.first().map(|b| b.1).unwrap_or("")
        );
        assert!(Journal::load_from(&path).await.is_ok());
    }

    /// 현실적인 경우 — 작업 **두 개**가 거의 동시에 끝남(로컬 worker + 원격 worker).
    /// 200회 반복해 한 번이라도 줄이 섞이면 다음 시작이 패닉한다.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_concurrent_pushes_keep_journal_loadable() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal.jsonl");
        let j = Journal::load_from(&path).await.unwrap();
        let mut torn_at = None;
        for round in 0..200 {
            let (a, b) = (j.clone(), j.clone());
            let ha = tokio::spawn(async move { a.push(op(), UndoAction::Irreversible).await });
            let hb = tokio::spawn(async move { b.push(op(), UndoAction::Irreversible).await });
            ha.await.unwrap().unwrap();
            hb.await.unwrap().unwrap();
            if Journal::load_from(&path).await.is_err() {
                torn_at = Some(round);
                break;
            }
        }
        assert!(
            torn_at.is_none(),
            "journal became unloadable after round {:?} of 2 concurrent pushes",
            torn_at
        );
    }
}

#[cfg(test)]
mod review_fileops_sol_r2 {
    use super::*;
    use crate::core::undo::{execute_redo, execute_undo};
    use crate::services::connection_pool::ConnectionPool;

    fn batch_entry(root: &Path, current: PathBuf, original: PathBuf) -> JournalEntry {
        JournalEntry {
            id: JournalId::new(),
            timestamp: Utc::now(),
            op: OpKind::BatchRename {
                count: 1,
                location: Location {
                    source: SourceId::Local,
                    path: root.to_path_buf(),
                },
            },
            undo: UndoAction::UndoBatchRename {
                source: SourceId::Local,
                pairs: vec![RenamePair { current, original }],
            },
            undone: false,
        }
    }

    #[tokio::test]
    #[ignore = "fileops-03 repro"]
    async fn batch_undo_preserves_file_recreated_at_original_name() {
        let t = tempfile::tempdir().unwrap();
        let original = t.path().join("a");
        let current = t.path().join("renamed-a");
        tokio::fs::write(&current, b"old batch content")
            .await
            .unwrap();
        tokio::fs::write(&original, b"new independent work")
            .await
            .unwrap();
        let entry = batch_entry(t.path(), current, original.clone());
        let outcome = execute_undo(&entry, &ConnectionPool::new()).await;
        let bytes = tokio::fs::read(&original).await.unwrap();
        eprintln!("batch undo outcome={outcome:?}; original={bytes:?}");
        assert_eq!(
            bytes, b"new independent work",
            "batch undo overwrote recreated original"
        );
    }

    #[tokio::test]
    #[ignore = "fileops-03 repro"]
    async fn batch_redo_preserves_file_recreated_at_current_name() {
        let t = tempfile::tempdir().unwrap();
        let original = t.path().join("a");
        let current = t.path().join("renamed-a");
        tokio::fs::write(&original, b"old batch content")
            .await
            .unwrap();
        tokio::fs::write(&current, b"new independent work")
            .await
            .unwrap();
        let mut entry = batch_entry(t.path(), current.clone(), original);
        entry.undone = true;
        let outcome = execute_redo(&entry, &ConnectionPool::new()).await;
        let bytes = tokio::fs::read(&current).await.unwrap();
        eprintln!("batch redo outcome={outcome:?}; current={bytes:?}");
        assert_eq!(
            bytes, b"new independent work",
            "batch redo overwrote a new target despite single-rename redo guard"
        );
    }
}
