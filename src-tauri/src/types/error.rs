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
    #[error("not supported: {0}")]
    NotSupported(String),
    #[error("io: {0}")]
    Io(String),
    #[error("ssh: {0}")]
    Ssh(String),
    /// 서버 호스트키가 `~/.ssh/known_hosts` 와 불일치 — 미지(TOFU 필요) 또는 변경(MITM 경고).
    /// frontend 가 fingerprint 를 보여주고 사용자 신뢰 결정을 받는다.
    #[error("unverified host key for {} ({})", .0.host, .0.fingerprint)]
    HostKeyUnverified(HostKeyInfo),
}

/// 호스트키 검증 실패 상세 — IPC 로 frontend 에 전달해 신뢰 다이얼로그를 띄운다.
#[derive(Debug, Clone, Serialize, Type)]
pub struct HostKeyInfo {
    /// 검증 대상 호스트명.
    pub host: String,
    /// 서버가 제시한 키의 fingerprint (예: `SHA256:…`).
    pub fingerprint: String,
    /// true = 기록된 키와 다름(위험, MITM 가능 — 신뢰 불가). false = 미지의 호스트(TOFU).
    pub changed: bool,
    /// changed 일 때 충돌한 known_hosts 라인 번호 (수동 수정 안내용).
    pub changed_line: Option<u32>,
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
