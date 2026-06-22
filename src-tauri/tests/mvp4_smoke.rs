//! MVP-4 smoke tests — retry policy + task DTO serde 정합성.
//!
//! 실제 TaskQueue 통합 (enqueue → 워커 → completion) 은 Tauri AppHandle 필요해 후속.

use duet_lib::services::journal::JournalId;
use duet_lib::services::retry::is_retryable_error;
use duet_lib::services::task_events::{
    HostKey, ProgressInfo, TaskDto, TaskId, TaskKind, TaskStatus,
};
use duet_lib::types::DuetError;

#[test]
fn smoke_retry_matrix() {
    assert!(is_retryable_error(&DuetError::ConnectionFailed("x".into())));
    assert!(is_retryable_error(&DuetError::Ssh("channel closed".into())));
    assert!(is_retryable_error(&DuetError::Ssh("EOF".into())));
    assert!(is_retryable_error(&DuetError::Ssh("broken pipe".into())));
    assert!(!is_retryable_error(&DuetError::AuthFailed));
    assert!(!is_retryable_error(&DuetError::NotFound("x".into())));
    assert!(!is_retryable_error(&DuetError::Cancelled));
    assert!(!is_retryable_error(&DuetError::Io("x".into())));
}

#[test]
fn smoke_task_dto_roundtrip() {
    let dto = TaskDto {
        id: TaskId("test-id".into()),
        kind: TaskKind::Copy,
        status: TaskStatus::Running,
        title: "Copying foo".into(),
        host_key: HostKey::Ssh {
            host_ip: "10.0.0.1".into(),
        },
        progress: Some(ProgressInfo {
            bytes_done: 100,
            bytes_total: Some(200),
            speed_bps: Some(50),
            eta_sec: Some(2),
            percent: Some(50),
            ..Default::default()
        }),
        error_message: None,
        affected_locations: vec![],
    };
    let json = serde_json::to_string(&dto).unwrap();
    let back: TaskDto = serde_json::from_str(&json).unwrap();
    assert_eq!(back.id.0, "test-id");
    assert_eq!(back.kind, TaskKind::Copy);
    assert_eq!(back.title, "Copying foo");
}

#[test]
fn smoke_task_status_completed_roundtrip() {
    let s = TaskStatus::Completed {
        journal_id: JournalId(uuid::Uuid::nil()),
    };
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("completed"));
    assert!(json.contains("journal_id"));
}

#[test]
fn smoke_host_key_serde() {
    let local = HostKey::Local;
    let ssh = HostKey::Ssh {
        host_ip: "1.2.3.4".into(),
    };
    let local_json = serde_json::to_string(&local).unwrap();
    let ssh_json = serde_json::to_string(&ssh).unwrap();
    assert!(local_json.contains("local"));
    assert!(ssh_json.contains("ssh"));
    assert!(ssh_json.contains("1.2.3.4"));
}
