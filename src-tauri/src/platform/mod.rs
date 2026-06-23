//! OS별 분기. 상위 레이어는 `commands → platform` 으로만 진입.
//!
//! 외부 프로세스 spawn / OS API 호출은 이 레이어에 격리한다. 각 기능은
//! cfg-gated facade 로 노출해 모든 OS 에서 컴파일되며, 미지원 OS 는
//! `DuetError::NotSupported` 를 돌려준다.

use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(windows)]
pub mod shell_menu;

/// 셸 컨텍스트 메뉴 항목(재귀 트리) — IContextMenu 가 채운 HMENU 를 열거한 결과(Tier 2).
#[derive(Debug, Clone, Serialize, Type)]
pub struct ShellMenuItem {
    /// InvokeCommand 용 명령 id(절대, idCmdFirst 기준). 구분선/서브메뉴-only 는 0.
    pub id: u32,
    pub label: String,
    pub separator: bool,
    pub disabled: bool,
    pub children: Vec<ShellMenuItem>,
}

/// 열린 셸 메뉴 — `token` 으로 invoke/close. items 는 프론트가 렌더.
#[derive(Debug, Clone, Serialize, Type)]
pub struct ShellMenu {
    pub token: u64,
    pub items: Vec<ShellMenuItem>,
}

/// 셸 메뉴 핫-스레드 레지스트리 — Tauri state. token 발급 + (Windows) lazy COM 워커 보유.
/// 워커는 앱 수명 내내 살아 셸 핸들러를 warm 하게 유지(탐색기처럼 둘째 클릭부터 빠름).
#[derive(Default)]
pub struct ShellMenuRegistry {
    next: std::sync::atomic::AtomicU64,
    #[cfg(windows)]
    worker: std::sync::OnceLock<shell_menu::Worker>,
}

impl ShellMenuRegistry {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self::default())
    }
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn alloc_token(&self) -> u64 {
        self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }
    /// 핫 COM 워커 (첫 사용 시 spawn, 이후 재사용 — 핸들러 warm).
    #[cfg(windows)]
    pub fn worker(&self) -> &shell_menu::Worker {
        self.worker.get_or_init(shell_menu::Worker::start)
    }
}

/// 우클릭 대상 종류 — 스캔할 레지스트리 shell 루트를 결정.
#[derive(Debug, Clone, Copy, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ShellScope {
    /// 파일 항목 — `*`, `AllFilesystemObjects`, 확장자 ProgID 등.
    File,
    /// 폴더 항목 — `Directory`, `Folder`.
    Directory,
    /// 폴더 빈 영역 — `Directory\Background`.
    Background,
}

/// 앱 실행파일(`.exe`)의 OS 네이티브 아이콘을 PNG 바이트로 추출.
///
/// Windows: `systemicons`(SHGetFileInfo+GDI). 절대경로 .exe 면 임베드 리소스
/// 아이콘을 반환한다. 그 외 OS: `NotSupported` (프론트는 모노그램 fallback).
/// `size` 는 px (16/32/64 권장).
pub fn app_icon(path: &Path, size: i32) -> Result<Vec<u8>, DuetError> {
    #[cfg(windows)]
    {
        let p = path
            .to_str()
            .ok_or_else(|| DuetError::Io("icon: non-utf8 path".into()))?;
        systemicons::get_icon(p, size)
            .map_err(|e| DuetError::Io(format!("icon extract failed: {e:?}")))
    }
    #[cfg(not(windows))]
    {
        let _ = (path, size);
        Err(DuetError::NotSupported(
            "app icon extraction is only supported on Windows".into(),
        ))
    }
}

/// 마운트된 볼륨/드라이브를 eject (언마운트 + 디바이스 분리).
///
/// - macOS: `diskutil eject <mount>`
/// - Windows: PowerShell Shell.Application 의 "Eject" verb (탐색기의 "꺼내기"와 동일)
/// - Linux: `udisksctl unmount` → `udisksctl power-off` (polkit, root 불필요)
///
/// 새 의존성 없이 OS 표준 도구를 spawn 한다(기존 diskutil/open 패턴과 동일). 비가역
/// 시스템 op 라 journal/undo 대상이 아니며, 안전장치는 frontend 확인 다이얼로그다.
pub fn eject_volume(path: &Path) -> Result<(), DuetError> {
    #[cfg(target_os = "macos")]
    {
        macos::eject_volume(path)
    }
    #[cfg(target_os = "windows")]
    {
        windows_eject(path)
    }
    #[cfg(target_os = "linux")]
    {
        linux_eject(path)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = path;
        Err(DuetError::NotSupported(
            "volume eject is not supported on this OS".into(),
        ))
    }
}

/// 지정 폴더에서 OS 터미널을 연다 (로컬 경로). 우클릭 "여기서 터미널 열기".
///
/// - macOS: `open -a Terminal <dir>`
/// - Windows: Windows Terminal(`wt.exe -d <dir>`), 없으면 `cmd` 새 창(해당 폴더 cwd)
/// - Linux: `$TERMINAL` → 흔한 터미널(x-terminal-emulator/gnome-terminal/… ) 순차 시도
///
/// 새 의존성 없이 OS 표준 도구를 spawn(기존 eject/open 패턴과 동일). 셸을 띄우는 것뿐이라
/// journal/undo 대상이 아니다. 비-디렉토리/원격은 호출자(command)가 거른다.
pub fn open_terminal(dir: &Path) -> Result<(), DuetError> {
    #[cfg(target_os = "macos")]
    {
        macos_open_terminal(dir)
    }
    #[cfg(target_os = "windows")]
    {
        windows_open_terminal(dir)
    }
    #[cfg(target_os = "linux")]
    {
        linux_open_terminal(dir)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = dir;
        Err(DuetError::NotSupported(
            "open terminal is not supported on this OS".into(),
        ))
    }
}

#[cfg(target_os = "macos")]
fn macos_open_terminal(dir: &Path) -> Result<(), DuetError> {
    use std::process::Command;
    let status = Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(dir)
        .status()
        .map_err(|e| DuetError::Io(format!("open terminal: spawn failed: {e}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(DuetError::Io(
            "open terminal: 'open -a Terminal' failed".into(),
        ))
    }
}

#[cfg(target_os = "windows")]
fn windows_open_terminal(dir: &Path) -> Result<(), DuetError> {
    use std::process::Command;
    // 1) Windows Terminal 우선 — `-d <dir>` 로 시작 폴더 지정.
    if Command::new("wt.exe").arg("-d").arg(dir).spawn().is_ok() {
        return Ok(());
    }
    // 2) 폴백: 새 cmd 창. start 가 새 콘솔을 띄우고, cwd 는 current_dir 로 상속(인용 이슈 회피).
    Command::new("cmd")
        .args(["/c", "start", "cmd"])
        .current_dir(dir)
        .spawn()
        .map_err(|e| DuetError::Io(format!("open terminal: cmd spawn failed: {e}")))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_open_terminal(dir: &Path) -> Result<(), DuetError> {
    use std::process::Command;
    // 대부분의 터미널은 spawn 의 cwd(current_dir)를 상속해 그 폴더에서 시작한다.
    let try_spawn = |bin: &str| Command::new(bin).current_dir(dir).spawn().is_ok();
    if let Ok(t) = std::env::var("TERMINAL") {
        if !t.is_empty() && try_spawn(&t) {
            return Ok(());
        }
    }
    for bin in [
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "alacritty",
        "kitty",
        "xterm",
    ] {
        if try_spawn(bin) {
            return Ok(());
        }
    }
    Err(DuetError::NotSupported(
        "open terminal: no known terminal emulator found".into(),
    ))
}

/// Windows: 볼륨 경로(`E:\`)에서 드라이브 토큰(`E:`) 추출. 드라이브 문자 형식만 허용.
#[cfg(any(target_os = "windows", test))]
fn windows_drive_token(path: &Path) -> Option<String> {
    let s = path.to_str()?;
    let b = s.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        Some(format!("{}:", (b[0] as char).to_ascii_uppercase()))
    } else {
        None
    }
}

/// Windows: Shell.Application "Eject" verb 를 호출하는 PowerShell 스크립트.
/// Namespace(17) = ssfDRIVES(내 PC). `drive` 는 검증된 `X:` 형식이라 인젝션 안전.
#[cfg(any(target_os = "windows", test))]
fn windows_eject_script(drive: &str) -> String {
    format!(
        "$ErrorActionPreference='Stop'; (New-Object -ComObject Shell.Application).Namespace(17).ParseName('{drive}').InvokeVerb('Eject')"
    )
}

#[cfg(target_os = "windows")]
fn windows_eject(path: &Path) -> Result<(), DuetError> {
    use std::process::Command;
    let drive = windows_drive_token(path)
        .ok_or_else(|| DuetError::Io(format!("eject: not a drive path: {}", path.display())))?;
    let script = windows_eject_script(&drive);
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| DuetError::Io(format!("eject: powershell spawn failed: {e}")))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(DuetError::Io(format!(
            "eject failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

/// Linux: `/proc/mounts` 의 octal escape(`\040` 등) 디코딩.
#[cfg(any(target_os = "linux", test))]
fn unescape_proc_mounts(field: &str) -> String {
    let mut out = String::with_capacity(field.len());
    let mut chars = field.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '\\' && field.len() >= i + 4 {
            let oct = &field[i + 1..i + 4];
            if let Ok(n) = u8::from_str_radix(oct, 8) {
                out.push(n as char);
                chars.next();
                chars.next();
                chars.next();
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// Linux: `/proc/mounts` 내용에서 주어진 mountpoint 의 device 경로를 찾는다.
#[cfg(any(target_os = "linux", test))]
fn linux_device_for_mount(mounts: &str, mountpoint: &Path) -> Option<String> {
    let target = mountpoint.to_str()?;
    for line in mounts.lines() {
        let mut it = line.split_whitespace();
        let dev = it.next()?;
        let mp = it.next()?;
        if unescape_proc_mounts(mp) == target {
            return Some(dev.to_string());
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn linux_eject(path: &Path) -> Result<(), DuetError> {
    use std::process::Command;
    let mounts = std::fs::read_to_string("/proc/mounts")
        .map_err(|e| DuetError::Io(format!("eject: read /proc/mounts: {e}")))?;
    let dev = linux_device_for_mount(&mounts, path)
        .ok_or_else(|| DuetError::Io(format!("eject: no device for mount {}", path.display())))?;
    // unmount (polkit — root 불필요). 실패 시 중단.
    let out = Command::new("udisksctl")
        .args(["unmount", "-b", &dev])
        .output()
        .map_err(|e| DuetError::Io(format!("eject: udisksctl spawn failed (설치 필요?): {e}")))?;
    if !out.status.success() {
        return Err(DuetError::Io(format!(
            "eject(unmount) failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    // power-off (USB 안전제거) — 네트워크/일부 디바이스는 미지원이라 best-effort.
    let _ = Command::new("udisksctl")
        .args(["power-off", "-b", &dev])
        .output();
    Ok(())
}

// === Windows 탐색기 통합: 폴더/드라이브 우클릭 "Open in duet" ===
//
// HKCU\Software\Classes 아래 사용자 범위로만 기록(관리자 불필요). 우리가 만든
// 3개 키(Directory / Directory\Background / Drive 의 shell\duet)만 다루고,
// 해제는 그 키만 재귀 삭제 — 완전 가역. 레지스트리 경로는 파일시스템 경로가
// 아니라 항상 `\` 구분자(§7 무관).

/// "Open in duet" 우클릭 항목이 등록돼 있는지. 비-Windows 는 항상 false.
pub fn open_in_duet_status() -> Result<bool, DuetError> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        Ok(hkcu
            .open_subkey(r"Software\Classes\Directory\shell\duet\command")
            .is_ok())
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// "Open in duet" 우클릭 항목 등록(멱등). `exe` = 현재 실행파일 — 클릭한 폴더를
/// `%1`(Drive/Directory) / `%V`(Background) 로 전달받는다.
pub fn open_in_duet_register(exe: &Path) -> Result<(), DuetError> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let exe_str = exe
            .to_str()
            .ok_or_else(|| DuetError::Io("exe path non-utf8".into()))?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        // (base 키, command 가 폴더를 받는 토큰)
        let targets = [
            (r"Software\Classes\Directory\shell\duet", "%1"),
            (r"Software\Classes\Directory\Background\shell\duet", "%V"),
            (r"Software\Classes\Drive\shell\duet", "%1"),
        ];
        for (base, arg) in targets {
            let (key, _) = hkcu.create_subkey(base)?;
            key.set_value("", &"Open in duet")?; // 메뉴 라벨
            key.set_value("Icon", &exe_str)?; // 메뉴 아이콘 = duet exe
            let (cmd, _) = hkcu.create_subkey(format!(r"{base}\command"))?;
            cmd.set_value("", &format!("\"{exe_str}\" \"{arg}\""))?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = exe;
        Err(DuetError::NotSupported(
            "shell integration is only supported on Windows".into(),
        ))
    }
}

/// "Open in duet" 우클릭 항목 해제 — 우리가 만든 3개 키만 재귀 삭제(없으면 무시).
pub fn open_in_duet_unregister() -> Result<(), DuetError> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for base in [
            r"Software\Classes\Directory\shell\duet",
            r"Software\Classes\Directory\Background\shell\duet",
            r"Software\Classes\Drive\shell\duet",
        ] {
            let _ = hkcu.delete_subkey_all(base); // 없으면 Err — 무시(가역·멱등)
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_drive_token_extracts_letter() {
        assert_eq!(
            windows_drive_token(Path::new("E:\\")).as_deref(),
            Some("E:")
        );
        assert_eq!(windows_drive_token(Path::new("e:")).as_deref(), Some("E:"));
        assert_eq!(
            windows_drive_token(Path::new("C:\\Users")).as_deref(),
            Some("C:")
        );
        assert_eq!(windows_drive_token(Path::new("/Volumes/x")), None);
        assert_eq!(windows_drive_token(Path::new("\\\\server\\share")), None);
    }

    #[test]
    fn windows_eject_script_targets_drive() {
        let s = windows_eject_script("E:");
        assert!(s.contains("Shell.Application"));
        assert!(s.contains("ParseName('E:')"));
        assert!(s.contains("InvokeVerb('Eject')"));
    }

    #[test]
    fn proc_mounts_unescape_decodes_octal() {
        assert_eq!(
            unescape_proc_mounts("/media/u/My\\040Disk"),
            "/media/u/My Disk"
        );
        assert_eq!(unescape_proc_mounts("/mnt/data"), "/mnt/data");
        assert_eq!(unescape_proc_mounts("a\\134b"), "a\\b"); // \134 = backslash
    }

    #[test]
    fn linux_device_for_mount_resolves() {
        let mounts = "\
/dev/sda1 / ext4 rw 0 0
/dev/sdb1 /media/u/My\\040Disk vfat rw 0 0
tmpfs /run tmpfs rw 0 0
";
        assert_eq!(
            linux_device_for_mount(mounts, Path::new("/media/u/My Disk")).as_deref(),
            Some("/dev/sdb1")
        );
        assert_eq!(
            linux_device_for_mount(mounts, Path::new("/")).as_deref(),
            Some("/dev/sda1")
        );
        assert_eq!(linux_device_for_mount(mounts, Path::new("/nope")), None);
    }
}
