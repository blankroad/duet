//! Paths R2: a recording filesystem deliberately uses a different child-path rule.
//! Virtual paths never reach the host filesystem; only journals use TempDir.
use super::*;
use crate::types::{ConnectionId, Entry, EntryKind, EntryMeta, ServerEndpoint};
use std::collections::HashMap;
use std::path::Path;
use std::pin::Pin;
use std::sync::Mutex;

struct ProbeFs {
    source: SourceId,
    port: u16,
    exists: bool,
    entries: HashMap<PathBuf, Vec<Entry>>,
    seen: Mutex<Vec<PathBuf>>,
}
impl ProbeFs {
    fn new(conn: &str, port: u16) -> Self {
        Self {
            source: SourceId::Ssh {
                connection_id: ConnectionId(conn.into()),
                host_ip: "127.0.0.1".parse().unwrap(),
                user: "fixture".into(),
            },
            port,
            exists: false,
            entries: HashMap::new(),
            seen: Mutex::new(Vec::new()),
        }
    }
    fn record(&self, path: &Path) {
        self.seen.lock().unwrap().push(path.into());
    }
}
fn absent() -> DuetError {
    DuetError::NotFound("record-only fixture".into())
}
#[async_trait::async_trait]
impl FileSystem for ProbeFs {
    fn source_id(&self) -> SourceId {
        self.source.clone()
    }
    fn endpoint(&self) -> Option<ServerEndpoint> {
        Some(ServerEndpoint::new(
            "127.0.0.1".parse().unwrap(),
            self.port,
            &[],
        ))
    }
    fn join(&self, base: &Path, name: &str) -> PathBuf {
        crate::fs::posix_join(&crate::fs::posix_join(base, "__fs"), name)
    }
    async fn list(&self, p: &Path) -> Result<Vec<Entry>, DuetError> {
        self.record(p);
        Ok(self.entries.get(p).cloned().unwrap_or_default())
    }
    async fn metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
        self.record(p);
        if self.exists {
            Ok(EntryMeta {
                kind: EntryKind::Dir,
                size: None,
                modified_ms: None,
                permissions: None,
            })
        } else {
            Err(absent())
        }
    }
    async fn rename(&self, _: &Path, _: &Path) -> Result<(), DuetError> {
        panic!("unexpected rename")
    }
    async fn mkdir(&self, _: &Path) -> Result<(), DuetError> {
        panic!("unexpected mkdir")
    }
    async fn trash(&self, p: &Path, _: &str) -> Result<TrashLocation, DuetError> {
        self.record(p);
        Err(absent())
    }
    async fn remove(&self, _: &Path) -> Result<(), DuetError> {
        panic!("permanent removal forbidden")
    }
    async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
        panic!("unexpected restore")
    }
    async fn read_full(&self, p: &Path) -> Result<Vec<u8>, DuetError> {
        self.record(p);
        Err(absent())
    }
    async fn write_full(&self, _: &Path, _: &[u8]) -> Result<(), DuetError> {
        panic!("unexpected write")
    }
    async fn open_read(
        &self,
        _: &Path,
        _: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
        panic!("unexpected open")
    }
    async fn open_write(
        &self,
        _: &Path,
        _: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
        panic!("unexpected open")
    }
}

#[tokio::test]
async fn remote17_keep_both_candidate_uses_destination_join() {
    let fs = ProbeFs::new("dst", 22);
    let p = dedup_dst_name(&fs, Path::new("/dst"), r"a\b.txt").await;
    assert_eq!(p, fs.join(Path::new("/dst"), r"a\b (1).txt"));
}
#[tokio::test]
async fn remote17_timestamp_fallback_uses_destination_join() {
    let mut fs = ProbeFs::new("dst", 22);
    fs.exists = true;
    let p = dedup_dst_name(&fs, Path::new("/dst"), "x.txt").await;
    assert_eq!(p.parent(), Some(Path::new("/dst/__fs")));
    assert_eq!(fs.seen.lock().unwrap().len(), 9999);
}
