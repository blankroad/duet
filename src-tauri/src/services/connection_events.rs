//! 연결 상태 변화 이벤트.
//!
//! 백엔드에서 활성 연결의 lifecycle 변화 (open / close / error / reconnect) 가
//! 일어날 때 프론트엔드 connections store 가 자동으로 동기화되도록 하기 위한
//! 채널. tauri-specta `Event` derive 로 TS 타입까지 자동 생성.
//!
//! ## 발행 시점
//!
//! - `Connected`: `connection_open` 성공 직후 (Pool 등록 완료 후)
//! - `Disconnected`: `connection_close` 완료 직후
//! - `Error { message }`: 자동 재연결 시도 실패 (Task 13)
//! - `Connecting`: 자동 재연결 시도 시작 (Task 13)
//!
//! 프론트엔드 dialog 가 `connection_open` await 도중 보여주는 "Connecting…"
//! 은 로컬 UI 상태 — 이 이벤트와 별개. 이벤트는 dialog 가 닫힌 뒤의
//! background 상태 변화에 사용.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::types::ConnectionId;

/// 연결 상태 enum. `tag = "kind"` 로 TS 에서 discriminated union.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnectionStateChange {
    /// 백오프 후 재연결 시도 진행 중 (Task 13).
    Connecting,
    /// 핸드셰이크 + 인증 성공.
    Connected,
    /// 사용자 명시 종료 또는 핸들 disconnect 감지 후.
    Disconnected,
    /// 재연결 시도 실패 또는 네트워크 끊김.
    Error { message: String },
}

/// 연결 상태 변화 이벤트 (`connection-state-event` 로 emit/listen).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ConnectionStateEvent {
    pub id: ConnectionId,
    pub alias: String,
    /// 핸드셰이크 시점에 잡은 peer IP (`Connected` 일 때만 의미; 그 외 빈 문자열).
    pub host_ip: String,
    pub user: String,
    pub state: ConnectionStateChange,
}
