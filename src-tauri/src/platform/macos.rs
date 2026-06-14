//! macOS 전용 OS 연동.
//!
//! 현재 책임: 마운트 볼륨 eject (`diskutil`). 외부 프로세스 spawn 은
//! CLAUDE.md 상 `platform/` 레이어에서만 — 상위(commands)는 facade 만 호출.

use crate::types::DuetError;
use std::path::Path;
use std::process::Command;

/// `/usr/sbin/diskutil eject <mount-point>` Command 구성 (spawn 안 함 — 테스트용 분리).
///
/// 셸 미경유 argv 전달이라 경로에 메타문자가 있어도 인젝션 불가 (§7/§9).
/// 절대경로 바이너리 사용 — PATH 환경차 회피. `diskutil` 은 시스템
/// ssh/sftp/scp 가 아니므로 §9(시스템 SSH 금지) 대상이 아니다.
fn build_eject_command(path: &Path) -> Command {
    let mut c = Command::new("/usr/sbin/diskutil");
    // `eject` 는 마운트 지점/디스크 식별자를 받아 언마운트 후 디바이스 분리.
    c.arg("eject").arg(path);
    c
}

/// 마운트 지점을 eject. 실패하면 diskutil 자체 stderr 메시지를 그대로 surface
/// (예: "Volume ... is in use"). 비가역 시스템 op — journal/undo 대상 아님.
pub fn eject_volume(path: &Path) -> Result<(), DuetError> {
    let output = build_eject_command(path)
        .output()
        .map_err(|e| DuetError::Io(format!("diskutil spawn failed: {e}")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let msg = stderr.trim();
    Err(DuetError::Io(format!(
        "eject failed: {}",
        if msg.is_empty() {
            "diskutil returned a non-zero status"
        } else {
            msg
        }
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_eject_command_uses_absolute_binary_and_argv() {
        // 경로에 공백/메타문자가 있어도 단일 argv 로 전달되는지 확인 (spawn 안 함).
        let cmd = build_eject_command(Path::new("/Volumes/My Disk; rm -rf /"));
        assert_eq!(cmd.get_program(), "/usr/sbin/diskutil");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, vec!["eject", "/Volumes/My Disk; rm -rf /"]);
    }
}
