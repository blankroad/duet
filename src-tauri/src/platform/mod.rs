//! OS별 분기. 상위 레이어는 `commands → platform` 으로만 진입.
//!
//! 외부 프로세스 spawn / OS API 호출은 이 레이어에 격리한다. 각 기능은
//! cfg-gated facade 로 노출해 모든 OS 에서 컴파일되며, 미지원 OS 는
//! `DuetError::NotSupported` 를 돌려준다.

use crate::types::DuetError;
use std::path::Path;

#[cfg(target_os = "macos")]
mod macos;

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
