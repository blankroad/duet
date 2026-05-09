//! 파일시스템 변경 이벤트.
//!
//! `FsWatcher` 가 활성 패널의 디렉토리 변경을 감지해 emit. 프론트엔드는
//! 같은 source + path 를 보고 있는 패널이면 list_directory 재호출로 갱신.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::types::SourceId;

/// 디렉토리 변경 알림.
///
/// `path` 는 변경이 감지된 디렉토리 (또는 그 안의 항목). 프론트엔드는
/// `source + path` 가 자신이 보고 있는 위치에 영향을 주는지 판단해서
/// 재로드.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct FsChangedEvent {
    pub source: SourceId,
    /// POSIX-style 절대경로 (UTF-8 문자열).
    pub path: String,
}
