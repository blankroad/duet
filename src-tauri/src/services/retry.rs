//! Retry 정책 헬퍼.
//!
//! MVP-4 v1: 연결 끊김만 1회 retry. Exponential backoff 없음 (단순 3초 sleep).

use crate::types::DuetError;

/// 이 에러가 retry-worthy 한가?
///
/// True 케이스:
/// - `ConnectionFailed(_)`: TCP 또는 SSH 핸드셰이크 끊김
/// - `Ssh(msg)` 가 substring "channel closed" / "EOF" / "broken pipe" 포함:
///   exec/sftp 도중 connection drop
///
/// False 케이스 (즉시 fail): AuthFailed, NotFound, PermissionDenied, NotPermitted,
/// Cancelled, NotSupported, Io.
pub fn is_retryable_error(err: &DuetError) -> bool {
    match err {
        DuetError::ConnectionFailed(_) => true,
        DuetError::Ssh(msg) => {
            msg.contains("channel closed") || msg.contains("EOF") || msg.contains("broken pipe")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_failed_is_retryable() {
        assert!(is_retryable_error(&DuetError::ConnectionFailed(
            "any".into()
        )));
    }

    #[test]
    fn ssh_channel_closed_is_retryable() {
        assert!(is_retryable_error(&DuetError::Ssh(
            "rsync failed (exit 23): channel closed".into()
        )));
    }

    #[test]
    fn ssh_eof_is_retryable() {
        assert!(is_retryable_error(&DuetError::Ssh("EOF on stream".into())));
    }

    #[test]
    fn ssh_broken_pipe_is_retryable() {
        assert!(is_retryable_error(&DuetError::Ssh(
            "write error: broken pipe".into()
        )));
    }

    #[test]
    fn ssh_other_message_is_not_retryable() {
        assert!(!is_retryable_error(&DuetError::Ssh(
            "permission denied".into()
        )));
    }

    #[test]
    fn auth_failed_is_not_retryable() {
        assert!(!is_retryable_error(&DuetError::AuthFailed));
    }

    #[test]
    fn not_found_is_not_retryable() {
        assert!(!is_retryable_error(&DuetError::NotFound("/nope".into())));
    }

    #[test]
    fn cancelled_is_not_retryable() {
        assert!(!is_retryable_error(&DuetError::Cancelled));
    }

    #[test]
    fn io_is_not_retryable() {
        assert!(!is_retryable_error(&DuetError::Io("permission".into())));
    }

    #[test]
    fn not_supported_is_not_retryable() {
        assert!(!is_retryable_error(&DuetError::NotSupported(
            "MVP-3".into()
        )));
    }
}
