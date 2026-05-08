//! IPC 경계로 노출되는 에러 타입.
//!
//! `Serialize` 필수 — Tauri command가 `Result<T, DuetError>` 반환 시 자동 직렬화.
//! `anyhow::Error` 는 `commands/` 진입에서 `DuetError`로 변환.

use serde::Serialize;
use specta::Type;
use thiserror::Error;

/// Tauri command에서 반환되는 최상위 에러 타입.
#[derive(Debug, Error, Serialize, Type)]
#[serde(tag = "kind", content = "message")]
#[non_exhaustive]
pub enum DuetError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("connection failed: {0}")]
    ConnectionFailed(String),
    #[error("auth failed")]
    AuthFailed,
    #[error("destructive op not permitted")]
    NotPermitted,
    #[error("cancelled")]
    Cancelled,
    #[error("io: {0}")]
    Io(String),
    #[error("ssh: {0}")]
    Ssh(String),
}

impl From<std::io::Error> for DuetError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => DuetError::NotFound(e.to_string()),
            std::io::ErrorKind::PermissionDenied => DuetError::PermissionDenied(e.to_string()),
            _ => DuetError::Io(e.to_string()),
        }
    }
}
