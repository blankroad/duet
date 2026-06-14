//! 원격 SSH exec 채널 헬퍼.
//!
//! - `exec`: 단발 명령 → ExecOutput { exit_status, stdout, stderr } 모두 수집
//! - `exec_streaming`: stdout 라인 단위 콜백 (stderr 는 전체 수집), exit_status
//!   반환. progress 출력 같은 long-running 명령용.
//!
//! 둘 다 russh `Handle::channel_open_session().exec()` 사용. 시스템 ssh 호출
//! 절대 X (CLAUDE.md §9).

use crate::ssh::connection::HostKeyVerifier;
use crate::types::DuetError;
use russh::client::Handle;
use russh::ChannelMsg;

/// 단발 명령 결과.
#[derive(Debug, Clone)]
pub struct ExecOutput {
    pub exit_status: u32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// 단발 exec — stdout/stderr 전체 수집 + exit_status.
///
/// `ExitStatus` 메시지를 수신하기 전에 채널이 닫히면 (예: 연결 끊김, 서버 측
/// 강제 종료) `DuetError::Ssh` 반환 — silent success 방지.
pub async fn exec(handle: &Handle<HostKeyVerifier>, cmd: &str) -> Result<ExecOutput, DuetError> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| DuetError::Ssh(format!("open session: {e}")))?;
    channel
        .exec(true, cmd)
        .await
        .map_err(|e| DuetError::Ssh(format!("exec '{cmd}': {e}")))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_status: Option<u32> = None;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, ext: 1 } => stderr.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status: code } => {
                exit_status = Some(code);
            }
            ChannelMsg::Eof | ChannelMsg::Close => {
                // close 가 와도 ExitStatus 가 아직 안 왔을 수 있음 — 계속 대기
            }
            _ => {}
        }
        // ExitStatus 받았고 추가 메시지 없으면 종료 — wait().await None 으로 자연 종료
    }

    let exit_status = exit_status.ok_or_else(|| {
        DuetError::Ssh("channel closed without ExitStatus — connection may have dropped".into())
    })?;
    Ok(ExecOutput {
        exit_status,
        stdout,
        stderr,
    })
}

/// Streaming exec — stdout 라인 단위 콜백, stderr 전체 수집, exit_status 반환.
///
/// `ExitStatus` 미수신 시 `DuetError::Ssh` (exec 와 동일).
///
/// 콜백은 `&str` 라인 (newline 미포함). 비-UTF8 stdout 은 `String::from_utf8_lossy`
/// 로 lossy 변환. progress 라인은 ASCII 라 무관.
///
/// stderr 는 전체 수집 후 결과로 반환 — 에러 디버깅용.
pub async fn exec_streaming<F>(
    handle: &Handle<HostKeyVerifier>,
    cmd: &str,
    mut on_stdout_line: F,
) -> Result<(u32, Vec<u8>), DuetError>
where
    F: FnMut(&str),
{
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| DuetError::Ssh(format!("open session: {e}")))?;
    channel
        .exec(true, cmd)
        .await
        .map_err(|e| DuetError::Ssh(format!("exec '{cmd}': {e}")))?;

    let mut stdout_buf = Vec::<u8>::new();
    let mut stderr = Vec::new();
    let mut exit_status: Option<u32> = None;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => {
                stdout_buf.extend_from_slice(&data);
                // 라인 단위 flush. rsync 는 progress update 시 \r 로 같은 줄
                // 갱신 — \r 도 라인 구분자로 취급.
                while let Some(idx) = stdout_buf.iter().position(|&b| b == b'\n' || b == b'\r') {
                    let line_bytes: Vec<u8> = stdout_buf.drain(..=idx).collect();
                    let line_str = String::from_utf8_lossy(&line_bytes);
                    let line_trimmed = line_str.trim_end_matches(['\r', '\n']);
                    if !line_trimmed.is_empty() {
                        on_stdout_line(line_trimmed);
                    }
                }
            }
            ChannelMsg::ExtendedData { data, ext: 1 } => stderr.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status: code } => {
                exit_status = Some(code);
            }
            ChannelMsg::Eof | ChannelMsg::Close => {}
            _ => {}
        }
    }
    // 채널 종료 후 buffer 에 남은 partial line 도 flush
    if !stdout_buf.is_empty() {
        let line_str = String::from_utf8_lossy(&stdout_buf);
        let trimmed = line_str.trim_end_matches(['\r', '\n']);
        if !trimmed.is_empty() {
            on_stdout_line(trimmed);
        }
    }

    let exit = exit_status.ok_or_else(|| {
        DuetError::Ssh("channel closed without ExitStatus — connection may have dropped".into())
    })?;
    Ok((exit, stderr))
}

#[cfg(test)]
mod tests {
    // 실제 SSH 통합 테스트는 docker compose 후속 — 컴파일 시그니처만.

    #[test]
    fn exec_signature_compiles() {
        let _ = super::exec;
    }

    #[test]
    fn exec_streaming_signature_compiles() {
        let _ = super::exec_streaming::<fn(&str)>;
    }
}
