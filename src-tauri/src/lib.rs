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

pub mod commands;
pub mod core;
pub mod fs;
pub mod platform;
pub mod services;
pub mod ssh;

use tauri_specta::{collect_commands, Builder};

/// Tauri 앱 진입점.
///
/// `main.rs` 에서 호출. 이 함수가 main에 있으면 `cdylib` 빌드 시 실행 안 됨.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let specta_builder = Builder::<tauri::Wry>::new()
        // commands는 다음 Task에서 추가
        .commands(collect_commands![]);

    #[cfg(debug_assertions)]
    specta_builder
        .export(
            specta_typescript::Typescript::default()
                .formatter(specta_typescript::formatter::prettier),
            "../src/types/bindings.ts",
        )
        .expect("failed to export specta bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
