//! 진행 중 op 의 실시간 progress 이벤트.
//!
//! MVP-3: 같은-host SSH copy 가 rsync `--info=progress2` 출력을 파싱해서
//! emit. cp fallback 또는 다른 op 는 emit 안 함 (ProgressModal 은 spinner).

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

/// op 진행 상황 실시간 이벤트 (`progress-event` 로 emit/listen).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ProgressEvent {
    /// copy_execute 진입 시 발급한 임시 UUID (string).
    /// MVP-3 는 단일 active op 가정 — 매칭 무관. MVP-4 TaskQueue 와 함께
    /// 다중 op 식별에 사용.
    pub op_id: String,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub speed_bps: Option<u64>,
    pub eta_sec: Option<u32>,
    /// 0..=100
    pub percent: Option<u8>,
}
