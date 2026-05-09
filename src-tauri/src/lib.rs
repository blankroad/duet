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
pub mod types;

use tauri_specta::{collect_commands, collect_events, Builder};

/// 모든 IPC command 가 등록된 specta `Builder` 를 만든다.
///
/// `run()` 과 standalone bindings export 바이너리 (`bin/export_bindings.rs`)
/// 가 같은 command 목록을 공유하도록 단일 진실. 새 command 추가 시 여기에만
/// 등록.
pub fn make_specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::pane::list_directory,
            commands::system::home_directory,
            commands::connection::ssh_config_hosts,
            commands::connection::connection_open,
            commands::connection::connection_close,
            commands::connection::connection_list,
        ])
        .events(collect_events![
            services::connection_events::ConnectionStateEvent,
        ])
}

/// `src/types/bindings.ts` 의 절대경로.
fn bindings_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/types/bindings.ts")
}

/// specta builder 로 TS bindings 를 디스크에 쓴다.
///
/// `run()` (debug build) 와 `bin/export_bindings.rs` (CLI) 가 공통 사용.
pub fn export_bindings(specta_builder: &Builder<tauri::Wry>) -> Result<(), String> {
    let path = bindings_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    specta_builder
        .export(
            specta_typescript::Typescript::default()
                .formatter(specta_typescript::formatter::prettier)
                .bigint(specta_typescript::BigIntExportBehavior::Number)
                .header("// @ts-nocheck\n"),
            &path,
        )
        .map_err(|e| format!("failed to export specta bindings: {e}"))
}

/// Tauri 앱 진입점.
///
/// `main.rs` 에서 호출. 이 함수가 main에 있으면 `cdylib` 빌드 시 실행 안 됨.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let specta_builder = make_specta_builder();

    #[cfg(debug_assertions)]
    {
        export_bindings(&specta_builder).expect("export bindings");
    }

    let pool = services::connection_pool::ConnectionPool::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .manage(pool)
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
