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
