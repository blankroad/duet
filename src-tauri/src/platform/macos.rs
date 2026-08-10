//! macOS 전용 OS 연동.
//!
//! 현재 책임: 마운트 볼륨 eject (`diskutil`). 외부 프로세스 spawn 은
//! CLAUDE.md 상 `platform/` 레이어에서만 — 상위(commands)는 facade 만 호출.

use crate::types::DuetError;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 파일 경로들을 macOS 클립보드에 올리는 JXA 스크립트.
///
/// AppKit 바인딩 크레이트(objc2 등)를 새로 들이지 않기 위해 osascript 의 ObjC 브리지로
/// NSPasteboard 를 직접 쓴다(§6 — 의존성 0). 경로는 **argv 로만** 받는다(§7/§9 — 스크립트
/// 문자열에 끼워넣지 않으므로 경로에 따옴표·개행이 있어도 인젝션 불가).
///
/// 레거시 `NSFilenamesPboardType`(경로 배열 plist)에 쓰면 macOS 가 최신 `public.file-url` 로
/// 브리지해 준다 — 호출 한 번으로 다중 파일이 올라가고 Finder 도 그대로 붙여넣는다.
/// (`writeObjects` 는 JXA 브리지에서 배열의 첫 항목만 올라가는 동작이 확인돼 쓰지 않는다.)
const SET_CLIPBOARD_JXA: &str = r#"ObjC.import("AppKit");
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  pb.declareTypesOwner($(["NSFilenamesPboardType"]), $());
  if (!pb.setPropertyListForType($(argv), $("NSFilenamesPboardType"))) {
    throw new Error("pasteboard write failed");
  }
}"#;

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

/// 클립보드 쓰기 osascript Command 구성 (spawn 안 함 — 테스트용 분리).
fn build_set_file_clipboard_command(paths: &[PathBuf]) -> Command {
    let mut c = Command::new("/usr/bin/osascript");
    c.arg("-l")
        .arg("JavaScript")
        .arg("-e")
        .arg(SET_CLIPBOARD_JXA);
    // `--` 뒤부터 run(argv) 인자 — `-` 로 시작하는 경로가 옵션으로 해석되지 않게.
    c.arg("--");
    for p in paths {
        c.arg(p);
    }
    c
}

/// 파일 경로들을 macOS 클립보드에 올린다(붙여넣기 가능 상태).
pub fn set_file_clipboard(paths: &[PathBuf]) -> Result<(), DuetError> {
    let output = build_set_file_clipboard_command(paths)
        .output()
        .map_err(|e| DuetError::Io(format!("osascript 실행 실패: {e}")))?;
    if output.status.success() {
        return Ok(());
    }
    let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(DuetError::Io(if msg.is_empty() {
        "클립보드 쓰기 실패".into()
    } else {
        msg
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_set_file_clipboard_command_passes_paths_as_argv() {
        // 경로가 스크립트 본문이 아니라 argv 로 들어가야 한다(인젝션 불가).
        let paths = vec![
            PathBuf::from("/tmp/a b.md"),
            PathBuf::from("/tmp/\"; rm -rf /.md"),
        ];
        let cmd = build_set_file_clipboard_command(&paths);
        assert_eq!(cmd.get_program(), "/usr/bin/osascript");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], "-l");
        assert_eq!(args[1], "JavaScript");
        assert_eq!(args[2], "-e");
        assert!(args[3].contains("NSFilenamesPboardType"), "JXA 스크립트");
        assert_eq!(args[4], "--", "경로 앞에 옵션 종료 표시");
        assert_eq!(args[5], "/tmp/a b.md");
        assert_eq!(args[6], "/tmp/\"; rm -rf /.md");
    }

    /// 실제 클립보드를 바꾸는 E2E — **기본 제외**(`--ignored` 로만 실행). 개발자 클립보드를
    /// 말없이 덮어쓰지 않기 위해서다. 확인:
    /// `cargo test -p duet --lib set_file_clipboard_writes -- --ignored --nocapture`
    #[test]
    #[ignore = "OS 클립보드를 실제로 변경한다"]
    fn set_file_clipboard_writes_real_pasteboard() {
        let dir = std::env::temp_dir().join(format!("duet-clip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let a = dir.join("보고서 1.md");
        let b = dir.join("b.txt");
        std::fs::write(&a, b"a").expect("write a");
        std::fs::write(&b, b"b").expect("write b");

        set_file_clipboard(&[a.clone(), b.clone()]).expect("클립보드 쓰기");
        // 파일을 지우지 않는다 — 클립보드가 가리키는 대상이 사라지면 Finder 붙여넣기로
        // 확인할 수 없다. 임시 디렉토리라 OS 가 정리한다.
        assert!(a.exists() && b.exists());
    }

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
