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
///
/// `argv = [pasteboard 이름, 소유 표식, 경로...]`. 이름이 빈 문자열이면 시스템 일반 클립보드 —
/// 테스트는 비공개 이름을 넘겨 사용자 클립보드를 건드리지 않는다. 파일 목록과 함께 duet 전용
/// 형식(`com.duet.clipboard-owner`)에 표식 문자열을 실어, 나중에 "아직 우리 것인가" 를 판정한다.
const SET_CLIPBOARD_JXA: &str = r#"ObjC.import("AppKit");
const OWNER = "com.duet.clipboard-owner";
function board(name) {
  return name === "" ? $.NSPasteboard.generalPasteboard : $.NSPasteboard.pasteboardWithName($(name));
}
function run(argv) {
  const pb = board(argv[0]);
  pb.clearContents;
  pb.declareTypesOwner($(["NSFilenamesPboardType", OWNER]), $());
  if (!pb.setPropertyListForType($(argv.slice(2)), $("NSFilenamesPboardType"))) {
    throw new Error("pasteboard write failed");
  }
  if (!pb.setStringForType($(argv[1]), $(OWNER))) {
    throw new Error("pasteboard owner mark failed");
  }
}"#;

/// 클립보드에 **아직 duet 의 그 표식이 있을 때만** 비우는 JXA 스크립트.
///
/// `argv = [pasteboard 이름, 기대 표식]`. 그사이 다른 앱이 무언가를 복사했다면 표식이 사라져
/// 건드리지 않는다. stdout: `cleared` | `kept`. (macOS 는 pasteboard 잠금이 없어 확인과
/// 비우기는 별개 호출 — 작지만 상한 없는 틈이 남는다. `file_clipboard::clear_if_owned` 참고.)
const CLEAR_IF_OWNED_JXA: &str = r#"ObjC.import("AppKit");
const OWNER = "com.duet.clipboard-owner";
function board(name) {
  return name === "" ? $.NSPasteboard.generalPasteboard : $.NSPasteboard.pasteboardWithName($(name));
}
function run(argv) {
  const pb = board(argv[0]);
  if (ObjC.unwrap(pb.stringForType($(OWNER))) !== argv[1]) return "kept";
  pb.clearContents;
  return "cleared";
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
/// `board` 가 빈 문자열이면 일반 클립보드.
fn build_set_file_clipboard_command(board: &str, paths: &[PathBuf], nonce: u64) -> Command {
    let mut c = Command::new("/usr/bin/osascript");
    c.arg("-l")
        .arg("JavaScript")
        .arg("-e")
        .arg(SET_CLIPBOARD_JXA);
    // `--` 뒤부터 run(argv) 인자 — `-` 로 시작하는 경로가 옵션으로 해석되지 않게.
    c.arg("--").arg(board).arg(nonce.to_string());
    for p in paths {
        c.arg(p);
    }
    c
}

/// "아직 우리 표식이면 비우기" osascript Command 구성 (spawn 안 함).
fn build_clear_if_owned_command(board: &str, nonce: u64) -> Command {
    let mut c = Command::new("/usr/bin/osascript");
    c.arg("-l")
        .arg("JavaScript")
        .arg("-e")
        .arg(CLEAR_IF_OWNED_JXA)
        .arg("--")
        .arg(board)
        .arg(nonce.to_string());
    c
}

/// 파일 경로들을 macOS 클립보드에 올린다(붙여넣기 가능 상태). `nonce` 는 duet 소유 표식.
pub fn set_file_clipboard(paths: &[PathBuf], nonce: u64) -> Result<(), DuetError> {
    set_file_clipboard_on("", paths, nonce)
}

/// 일반 클립보드에 아직 duet 의 `nonce` 표식이 있을 때만 비운다.
/// 비웠으면 true, 그사이 다른 내용으로 바뀌었으면 false.
pub fn clear_file_clipboard_if(nonce: u64) -> Result<bool, DuetError> {
    clear_file_clipboard_if_on("", nonce)
}

fn set_file_clipboard_on(board: &str, paths: &[PathBuf], nonce: u64) -> Result<(), DuetError> {
    run_osascript(build_set_file_clipboard_command(board, paths, nonce)).map(|_| ())
}

fn clear_file_clipboard_if_on(board: &str, nonce: u64) -> Result<bool, DuetError> {
    let out = run_osascript(build_clear_if_owned_command(board, nonce))?;
    Ok(out.trim() == "cleared")
}

/// osascript 실행 — 성공이면 stdout, 실패면 stderr 를 오류로.
fn run_osascript(mut cmd: Command) -> Result<String, DuetError> {
    let output = cmd
        .output()
        .map_err(|e| DuetError::Io(format!("osascript 실행 실패: {e}")))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
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
        let cmd = build_set_file_clipboard_command("", &paths, 9);
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
        assert_eq!(args[5], "", "빈 이름 = 일반 클립보드");
        assert_eq!(args[6], "9", "소유 표식");
        assert_eq!(args[7], "/tmp/a b.md");
        assert_eq!(args[8], "/tmp/\"; rm -rf /.md");
    }

    #[test]
    fn build_clear_if_owned_command_passes_board_and_count_as_argv() {
        let cmd = build_clear_if_owned_command("", 42);
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args[3].contains("com.duet.clipboard-owner"), "JXA 스크립트");
        assert_eq!(&args[4..], ["--", "", "42"]);
    }

    /// UX-SHL-04 (fileops-36): 원격 Ctrl+C 뒤 OS 클립보드에 예전 로컬 파일이 남던 것.
    /// 실제 osascript·NSPasteboard 를 쓰지만 **비공개 이름의 pasteboard** 라 사용자 클립보드는
    /// 건드리지 않는다. osascript 를 띄우므로 기본 제외 — 이 테스트 **하나만** 정확히 지정해 실행:
    /// `cargo test --lib platform::macos::tests::clear_if_owned_clears_only_our_unchanged_contents -- --ignored --exact`
    /// (`--ignored` 를 넓게 돌리면 아래 일반 클립보드 E2E 까지 돌아 사용자 클립보드를 덮어쓴다.)
    #[test]
    #[ignore = "osascript 를 실행한다(비공개 pasteboard, 사용자 클립보드 무관)"]
    fn clear_if_owned_clears_only_our_unchanged_contents() {
        let board = format!("duet-test-{}", std::process::id());
        let dir = tempfile::tempdir().expect("temp dir");
        let a = dir.path().join("a.txt");
        std::fs::write(&a, b"a").expect("write a");

        // 우리 표식 그대로면 비운다.
        set_file_clipboard_on(&board, &[a.clone()], 11).expect("set");
        assert!(clear_file_clipboard_if_on(&board, 11).expect("clear"));
        // 비운 뒤엔 표식이 없으니 다시 불러도 그대로.
        assert!(!clear_file_clipboard_if_on(&board, 11).expect("clear again"));

        // 그사이 다른 쓰기(다른 표식)가 올라왔으면 건드리지 않는다.
        set_file_clipboard_on(&board, &[a.clone()], 12).expect("set");
        set_file_clipboard_on(&board, &[a], 13).expect("set again");
        assert!(!clear_file_clipboard_if_on(&board, 12).expect("clear stale"));

        // 표식 없는 다른 앱 내용(일반 문자열)도 건드리지 않는다.
        let out = std::process::Command::new("/usr/bin/osascript")
            .args(["-l", "JavaScript", "-e"])
            .arg(
                r#"ObjC.import("AppKit");
function run(argv) {
  const pb = $.NSPasteboard.pasteboardWithName($(argv[0]));
  pb.clearContents;
  pb.setStringForType($("hello"), $("public.utf8-plain-text"));
  return ObjC.unwrap(pb.stringForType($("public.utf8-plain-text")));
}"#,
            )
            .arg("--")
            .arg(&board)
            .output()
            .expect("osascript");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hello");
        assert!(!clear_file_clipboard_if_on(&board, 13).expect("clear foreign"));
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

        set_file_clipboard(&[a.clone(), b.clone()], 1).expect("클립보드 쓰기");
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
