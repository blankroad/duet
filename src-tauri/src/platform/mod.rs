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
/// macOS: `diskutil eject`. 그 외 OS: `NotSupported` (후속 — Linux `udisksctl`,
/// Windows 이젝트 API). 비가역 시스템 op 라 journal/undo 대상이 아니며,
/// 안전장치는 frontend 확인 다이얼로그다.
pub fn eject_volume(path: &Path) -> Result<(), DuetError> {
    #[cfg(target_os = "macos")]
    {
        macos::eject_volume(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err(DuetError::NotSupported(
            "volume eject is only supported on macOS".into(),
        ))
    }
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
