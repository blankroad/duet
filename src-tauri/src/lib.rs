//! duet — Safe dual-pane SSH/SFTP file manager
//!
//! 백엔드 라이브러리 루트. Tauri 앱 진입점 + 모듈 트리.
//!
//! 레이어 구조:
//! ```text
//! commands → services → core → fs → platform
//!                               └→ ssh
//! ```
//!
//! 자세한 내용은 `ARCHITECTURE.md` 참조.

pub mod platform;
pub mod ssh;
pub mod fs;
pub mod core;
pub mod services;
pub mod commands;

/// Tauri 앱 진입점.
///
/// `main.rs` 에서 호출. 이 함수가 main에 있으면 `cdylib` 빌드 시 실행 안 됨.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // TODO (MVP-0):
    // 1. tracing-subscriber 초기화 (RUST_LOG)
    // 2. 작업 큐, 저널 등 서비스 초기화
    // 3. Tauri builder 설정
    // 4. command 등록

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        // .invoke_handler(tauri::generate_handler![
        //     commands::pane::list_directory,
        //     ...
        // ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
