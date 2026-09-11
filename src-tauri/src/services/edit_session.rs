//! 원격 파일 편집 라운드트립.
//!
//! 원격 파일을 로컬 temp 로 받아 OS 기본 에디터로 열고, temp 의 변경(mtime)을
//! 폴링 감지해 원격 경로로 자동 재업로드한다. notify 대신 폴링 — 에디터의
//! atomic-save(임시파일 후 rename)에도 견고하고 단순하다.
//!
//! 연결·전체 원격 경로별 세션을 재사용한다. watch 는 연결 종료 / temp 삭제 /
//! 장시간 무변경 시 task 가 스스로 끝난다.
//!
//! temp 는 **삭제하지 않는다** — 외부 에디터가 아직 열고 있을 수 있어 지우면
//! 미저장 편집을 잃을 수 있다(기존 `download_to_temp`/`duet-opened` 와 동일하게
//! best-effort 잔존, OS temp 정리에 맡김).

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::fs::{FileSystem, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::types::{ConnectionId, DuetError, EntryKind};

// Path equality can normalize components; use opaque OS strings for exact remote identity.
// Entries remain for this process lifetime so idle/failed watches never discard local edits.
type Sessions = Mutex<HashMap<(ConnectionId, OsString), Arc<Mutex<EditSession>>>>;
static SESSIONS: OnceLock<Sessions> = OnceLock::new();

#[derive(Default)]
struct EditSession {
    temp: Option<PathBuf>,
    last_uploaded: Arc<Mutex<Option<SystemTime>>>,
    watch: Option<JoinHandle<()>>,
}

async fn session_for(
    sessions: &Sessions,
    connection_id: &ConnectionId,
    remote: &Path,
) -> Arc<Mutex<EditSession>> {
    sessions
        .lock()
        .await
        .entry((connection_id.clone(), remote.as_os_str().to_owned()))
        .or_default()
        .clone()
}

impl EditSession {
    async fn prepare(
        &mut self,
        fs: &dyn FileSystem,
        remote: &Path,
        root: &Path,
    ) -> Result<PathBuf, DuetError> {
        // Serialize refresh with the complete upload, including its baseline update.
        // Otherwise a download could be mistaken for an editor save by the watcher.
        let baseline = self.last_uploaded.clone();
        let mut last = baseline.lock().await;
        let mut clean_copy = None;
        if let Some(temp) = &self.temp {
            match tokio::fs::metadata(temp).await {
                Ok(meta) => {
                    let modified = meta.modified().map_err(|e| {
                        DuetError::Io(format!("edit working copy timestamp unavailable: {e}"))
                    })?;
                    if *last != Some(modified) {
                        return Ok(temp.clone()); // Preserve edits not yet uploaded.
                    }
                    clean_copy = Some((temp.clone(), modified));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(DuetError::Io(format!("edit working copy unavailable: {e}"))),
            }
        }
        if fs.metadata(remote).await?.kind != EntryKind::File {
            return Err(DuetError::Io("can only edit regular files".into()));
        }
        let name = remote
            .file_name()
            .ok_or_else(|| DuetError::Io("remote path has no file name".into()))?;
        let bytes = fs.read_full(remote).await?;
        if let Some((temp, modified)) = clean_copy {
            // The editor can save while the remote read is in flight.
            match tokio::fs::metadata(&temp).await {
                Ok(meta) => {
                    if meta.modified().ok() != Some(modified) {
                        return Ok(temp);
                    }
                    tokio::fs::write(&temp, bytes)
                        .await
                        .map_err(|e| DuetError::Io(format!("refresh edit temp: {e}")))?;
                    *last = file_mtime(&temp).await;
                    return Ok(temp);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(DuetError::Io(format!("edit working copy unavailable: {e}"))),
            }
        }
        // UUID is independent of untrusted connection/path components; preserve extension.
        // create_dir (not create_dir_all) also refuses an existing session directory.
        tokio::fs::create_dir_all(root)
            .await
            .map_err(|e| DuetError::Io(format!("create edit root: {e}")))?;
        let dir = root.join(uuid::Uuid::new_v4().to_string());
        tokio::fs::create_dir(&dir)
            .await
            .map_err(|e| DuetError::Io(format!("create edit session dir: {e}")))?;
        let temp = dir.join(name);
        tokio::fs::write(&temp, bytes)
            .await
            .map_err(|e| DuetError::Io(format!("write edit temp: {e}")))?;
        // Capture before the editor can save, including before the watcher is scheduled.
        // A missing copy requires a new path and therefore a new watcher. The baseline
        // lock guarantees the old watcher is not in the middle of an upload.
        if let Some(watch) = self.watch.take() {
            watch.abort();
            let _ = watch.await;
        }
        *last = file_mtime(&temp).await;
        self.temp = Some(temp.clone());
        Ok(temp)
    }

    fn ensure_watch(&mut self, start: impl FnOnce() -> JoinHandle<()>) {
        if self.watch.as_ref().is_none_or(JoinHandle::is_finished) {
            self.watch = Some(start());
        }
    }
}

/// Refresh uploaded working copies on open, preserving edits not yet uploaded.
/// Missing copies are downloaded again; each working copy has a single watcher.
pub async fn prepare_remote_edit(
    pool: Arc<ConnectionPool>,
    connection_id: ConnectionId,
    remote: PathBuf,
) -> Result<PathBuf, DuetError> {
    let fs = SshFs::new(pool.get(&connection_id).await?);
    let session = session_for(
        SESSIONS.get_or_init(Sessions::default),
        &connection_id,
        &remote,
    )
    .await;
    let mut session = session.lock().await;
    let temp = session
        .prepare(&fs, &remote, &std::env::temp_dir().join("duet-edit"))
        .await?;
    let last = session.last_uploaded.clone();
    session.ensure_watch(|| spawn_edit_watch(pool, connection_id, remote, temp.clone(), last));
    Ok(temp)
}

/// temp mtime 폴링 간격.
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
/// 무변경이 이만큼(틱) 이어지면 watch 종료(누수 방지) — 약 2시간. 활성 편집은 중단 안 함.
const MAX_IDLE_TICKS: u32 = 4800;

async fn file_mtime(path: &Path) -> Option<SystemTime> {
    tokio::fs::metadata(path).await.ok()?.modified().ok()
}

async fn upload(fs: &dyn FileSystem, remote: &Path, temp: &Path) -> Result<(), DuetError> {
    let bytes = tokio::fs::read(temp)
        .await
        .map_err(|e| DuetError::Io(format!("edit read temp: {e}")))?;
    fs.write_full(remote, &bytes).await
}

/// temp 변경을 폴링 감지해 원격으로 재업로드하는 백그라운드 task 를 spawn.
/// `last_uploaded` 는 에디터 실행 전에 확보한 baseline 을 유지한다.
fn spawn_edit_watch(
    pool: Arc<ConnectionPool>,
    connection_id: ConnectionId,
    remote_path: PathBuf,
    temp: PathBuf,
    last_uploaded: Arc<Mutex<Option<SystemTime>>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut idle: u32 = 0;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let conn = match pool.get(&connection_id).await {
                Ok(c) => c,
                Err(_) => break, // 연결 종료 → watch 종료
            };
            let mut last = last_uploaded.lock().await;
            let cur = match file_mtime(&temp).await {
                Some(m) => m,
                None => break, // temp 사라짐 → 종료
            };
            let changed = *last != Some(cur);
            if changed {
                let fs = SshFs::new(conn);
                match upload(&fs, &remote_path, &temp).await {
                    Ok(()) => {
                        tracing::info!(remote = %remote_path.display(), "edit roundtrip: re-uploaded");
                        *last = Some(cur);
                        idle = 0;
                    }
                    Err(e) => {
                        // last 유지 — 다음 tick 에서 재시도(일시적 끊김 등).
                        tracing::warn!("edit roundtrip upload failed: {e}");
                    }
                }
            } else {
                idle += 1;
                if idle >= MAX_IDLE_TICKS {
                    break;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::LocalFs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn same_names_on_different_paths_upload_only_to_their_own_target() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("edits");
        let sessions = Sessions::default();
        let connection = ConnectionId("connection-a".into());
        let fs = LocalFs::new();
        let mut copies = Vec::new();
        for folder in ["a", "b"] {
            let dir = fixture.path().join(folder);
            tokio::fs::create_dir(&dir).await.unwrap();
            let remote = dir.join("notes.txt");
            tokio::fs::write(&remote, folder).await.unwrap();
            let session = session_for(&sessions, &connection, &remote).await;
            let temp = session
                .lock()
                .await
                .prepare(&fs, &remote, &root)
                .await
                .unwrap();
            assert_eq!(temp.file_name().unwrap(), "notes.txt");
            copies.push((remote, temp));
        }
        assert_ne!(copies[0].1, copies[1].1);
        tokio::fs::write(&copies[0].1, "edited a").await.unwrap();
        tokio::fs::write(&copies[1].1, "edited b").await.unwrap();
        for (remote, temp) in &copies {
            upload(&fs, remote, temp).await.unwrap();
        }
        assert_eq!(tokio::fs::read(&copies[0].0).await.unwrap(), b"edited a");
        assert_eq!(tokio::fs::read(&copies[1].0).await.unwrap(), b"edited b");
        let other = session_for(
            &sessions,
            &ConnectionId("connection-b".into()),
            &copies[0].0,
        )
        .await;
        let other_temp = other
            .lock()
            .await
            .prepare(&fs, &copies[0].0, &root)
            .await
            .unwrap();
        assert_ne!(copies[0].1, other_temp);
    }

    #[tokio::test]
    async fn concurrent_reopens_keep_unsent_edits_and_one_watcher() {
        let fixture = tempfile::tempdir().unwrap();
        let remote = fixture.path().join("notes.txt");
        tokio::fs::write(&remote, "original").await.unwrap();
        let root = fixture.path().join("edits");
        let sessions = Sessions::default();
        let connection = ConnectionId("connection".into());
        let session = session_for(&sessions, &connection, &remote).await;
        let temp = session
            .lock()
            .await
            .prepare(&LocalFs::new(), &remote, &root)
            .await
            .unwrap();
        let baseline = *session.lock().await.last_uploaded.lock().await;
        tokio::fs::write(&temp, "unsent local edit").await.unwrap();
        std::fs::File::options()
            .write(true)
            .open(&temp)
            .unwrap()
            .set_modified(baseline.unwrap() + Duration::from_secs(2))
            .unwrap();
        tokio::fs::write(&remote, "changed remotely").await.unwrap();
        let starts = Arc::new(AtomicUsize::new(0));
        let mut opens = Vec::new();
        for _ in 0..8 {
            let same = session_for(&sessions, &connection, &remote).await;
            assert!(Arc::ptr_eq(&session, &same));
            let remote = remote.clone();
            let root = root.clone();
            let starts = starts.clone();
            opens.push(tokio::spawn(async move {
                let mut session = same.lock().await;
                let temp = session
                    .prepare(&LocalFs::new(), &remote, &root)
                    .await
                    .unwrap();
                session.ensure_watch(|| {
                    starts.fetch_add(1, Ordering::SeqCst);
                    tokio::spawn(std::future::pending())
                });
                temp
            }));
        }
        for open in opens {
            assert_eq!(open.await.unwrap(), temp);
        }
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(tokio::fs::read(&temp).await.unwrap(), b"unsent local edit");
        let mut session = session.lock().await;
        assert_eq!(*session.last_uploaded.lock().await, baseline);
        // A finished watcher can restart, retaining the pre-editor upload baseline.
        let old_watch = session.watch.take().unwrap();
        old_watch.abort();
        let _ = old_watch.await;
        session.watch = Some(tokio::spawn(async {}));
        while !session.watch.as_ref().unwrap().is_finished() {
            tokio::task::yield_now().await;
        }
        session.ensure_watch(|| tokio::spawn(std::future::pending()));
        assert!(!session.watch.as_ref().unwrap().is_finished());
        assert_eq!(*session.last_uploaded.lock().await, baseline);
        session.watch.take().unwrap().abort();
    }

    #[tokio::test]
    async fn failed_download_and_missing_copy_can_recover_without_restart() {
        let fixture = tempfile::tempdir().unwrap();
        let remote = fixture.path().join("missing.txt");
        let root = fixture.path().join("edits");
        let mut session = EditSession::default();
        assert!(session
            .prepare(&LocalFs::new(), &remote, &root)
            .await
            .is_err());
        assert!(session.temp.is_none());
        tokio::fs::write(&remote, "now present").await.unwrap();
        let temp = session
            .prepare(&LocalFs::new(), &remote, &root)
            .await
            .unwrap();
        // Simulate temp cleanup without deleting a user's file.
        tokio::fs::rename(&temp, temp.with_extension("saved"))
            .await
            .unwrap();
        session.watch = Some(tokio::spawn(std::future::pending()));
        tokio::fs::write(&remote, "latest remote content")
            .await
            .unwrap();
        let recovered = session
            .prepare(&LocalFs::new(), &remote, &root)
            .await
            .unwrap();
        assert_ne!(recovered, temp);
        assert_eq!(
            tokio::fs::read(&recovered).await.unwrap(),
            b"latest remote content"
        );
        assert_eq!(
            *session.last_uploaded.lock().await,
            file_mtime(&recovered).await
        );
        assert!(session.watch.is_none());
        session.ensure_watch(|| tokio::spawn(std::future::pending()));
        assert!(!session.watch.as_ref().unwrap().is_finished());
        session.watch.take().unwrap().abort();
    }

    #[tokio::test]
    async fn uploaded_copy_refreshes_after_remote_change_without_uploading_the_refresh() {
        let fixture = tempfile::tempdir().unwrap();
        let remote = fixture.path().join("notes.txt");
        let root = fixture.path().join("edits");
        let fs = LocalFs::new();
        tokio::fs::write(&remote, "original").await.unwrap();
        let mut session = EditSession::default();
        let temp = session.prepare(&fs, &remote, &root).await.unwrap();
        tokio::fs::write(&temp, "uploaded edit").await.unwrap();
        upload(&fs, &remote, &temp).await.unwrap();
        *session.last_uploaded.lock().await = file_mtime(&temp).await;
        tokio::fs::write(&remote, "server changed after git pull")
            .await
            .unwrap();
        session.watch = Some(tokio::spawn(std::future::pending()));
        let watch_id = session.watch.as_ref().unwrap().id();
        let reopened = session.prepare(&fs, &remote, &root).await.unwrap();
        assert_eq!(reopened, temp);
        assert_eq!(
            tokio::fs::read(&reopened).await.unwrap(),
            b"server changed after git pull"
        );
        assert_eq!(
            *session.last_uploaded.lock().await,
            file_mtime(&reopened).await
        );
        assert_eq!(session.watch.as_ref().unwrap().id(), watch_id);
        session.watch.take().unwrap().abort();
        // Failed refresh preserves the last usable copy and baseline.
        tokio::fs::rename(&remote, remote.with_extension("moved"))
            .await
            .unwrap();
        assert!(session.prepare(&fs, &remote, &root).await.is_err());
        assert_eq!(
            tokio::fs::read(&temp).await.unwrap(),
            b"server changed after git pull"
        );
    }
}
