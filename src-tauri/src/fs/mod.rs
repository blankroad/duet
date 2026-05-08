//! 파일시스템 추상화.
//!
//! `LocalFs` (local), `SshFs` (MVP-1), `MockFs` (테스트) 모두 이 trait 구현.
//! 모든 메서드는 `async` — Tauri tokio runtime 위에서 동작.

pub mod local;

use crate::types::{DuetError, Entry, SourceId};
use async_trait::async_trait;
use std::path::Path;

pub use local::LocalFs;

#[async_trait]
pub trait FileSystem: Send + Sync {
    /// 이 파일시스템의 식별자.
    /// 같은-호스트 판정에 사용 (`SourceId::Ssh.host_ip` 일치 시 same-host).
    fn source_id(&self) -> SourceId;

    /// 디렉토리 항목 나열. 정렬은 호출자 책임.
    async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError>;
}
