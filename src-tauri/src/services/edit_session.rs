//! 원격 파일 편집 라운드트립.
//!
//! 원격 파일을 로컬 temp 로 받아 OS 기본 에디터로 열고, temp 의 변경(mtime)을
//! 폴링 감지해 원격 경로로 자동 재업로드한다. notify 대신 폴링 — 에디터의
//! atomic-save(임시파일 후 rename)에도 견고하고 단순하다.
//!
//! 자기-종료(별도 레지스트리 불필요): 연결 종료(`pool.get` 실패) / temp 삭제 /
//! 장시간 무변경 시 task 가 스스로 끝난다.
//!
//! temp 는 **삭제하지 않는다** — 외부 에디터가 아직 열고 있을 수 있어 지우면
//! 미저장 편집을 잃을 수 있다(기존 `download_to_temp`/`duet-opened` 와 동일하게
//! best-effort 잔존, OS temp 정리에 맡김).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use crate::fs::{FileSystem, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::types::{ConnectionId, DuetError};

/// 편집용 로컬 temp 경로 — 연결별 하위 디렉토리로 동명 파일 충돌을 막는다.
pub fn edit_temp_path(connection_id: &ConnectionId, file_name: &OsStr) -> PathBuf {
    std::env::temp_dir()
        .join("duet-edit")
        .join(&connection_id.0)
        .join(file_name)
}

/// temp mtime 폴링 간격.
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
/// 무변경이 이만큼(틱) 이어지면 watch 종료(누수 방지) — 약 2시간. 활성 편집은 중단 안 함.
const MAX_IDLE_TICKS: u32 = 4800;

async fn file_mtime(path: &Path) -> Option<SystemTime> {
    tokio::fs::metadata(path).await.ok()?.modified().ok()
}

async fn upload(fs: &SshFs, remote: &Path, temp: &Path) -> Result<(), DuetError> {
    let bytes = tokio::fs::read(temp)
        .await
        .map_err(|e| DuetError::Io(format!("edit read temp: {e}")))?;
    fs.write_full(remote, &bytes).await
}

/// temp 변경을 폴링 감지해 원격으로 재업로드하는 백그라운드 task 를 spawn.
/// `temp` 는 이미 다운로드돼 있다고 가정(다운로드 직후 호출).
pub fn spawn_edit_watch(
    pool: Arc<ConnectionPool>,
    connection_id: ConnectionId,
    remote_path: PathBuf,
    temp: PathBuf,
) {
    tokio::spawn(async move {
        // baseline = 다운로드 직후 mtime. 첫 사용자 저장이 이보다 새로우면 업로드.
        let mut last = file_mtime(&temp).await;
        let mut idle: u32 = 0;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let conn = match pool.get(&connection_id).await {
                Ok(c) => c,
                Err(_) => break, // 연결 종료 → watch 종료
            };
            let cur = match file_mtime(&temp).await {
                Some(m) => m,
                None => break, // temp 사라짐 → 종료
            };
            let changed = last.map(|l| cur > l).unwrap_or(true);
            if changed {
                let fs = SshFs::new(conn);
                match upload(&fs, &remote_path, &temp).await {
                    Ok(()) => {
                        tracing::info!(remote = %remote_path.display(), "edit roundtrip: re-uploaded");
                        last = Some(cur);
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
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_temp_path_is_per_connection_and_keeps_name() {
        let a = edit_temp_path(&ConnectionId("conn-a".into()), OsStr::new("notes.txt"));
        let b = edit_temp_path(&ConnectionId("conn-b".into()), OsStr::new("notes.txt"));
        // 동명 파일이라도 연결이 다르면 경로가 달라 충돌 안 함.
        assert_ne!(a, b);
        assert!(a.ends_with("notes.txt"));
        let s = a.to_string_lossy();
        assert!(s.contains("duet-edit"));
        assert!(s.contains("conn-a"));
    }
}
