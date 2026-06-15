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

use tauri::Manager as _;
use tauri_specta::{collect_commands, collect_events, Builder};

/// 모든 IPC command 가 등록된 specta `Builder` 를 만든다.
///
/// `run()` 과 standalone bindings export 바이너리 (`bin/export_bindings.rs`)
/// 가 같은 command 목록을 공유하도록 단일 진실. 새 command 추가 시 여기에만
/// 등록.
pub fn make_specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::bookmarks::bookmarks_list,
            commands::bookmarks::bookmarks_add,
            commands::bookmarks::bookmarks_remove,
            commands::bookmarks::bookmarks_reorder,
            commands::pane::list_directory,
            commands::pane::pane_watch_set,
            commands::system::home_directory,
            commands::system::ssh_home_directory,
            commands::system::open_path,
            commands::system::reveal_path,
            commands::system::trash_location,
            commands::system::trash_restore,
            commands::system::places,
            commands::system::volumes,
            commands::system::eject_volume,
            commands::system::local_abs_paths,
            commands::connection::ssh_config_hosts,
            commands::connection::connection_open,
            commands::connection::connection_open_adhoc,
            commands::connection::connection_close,
            commands::connection::connection_list,
            commands::host_favorites::host_favorites_list,
            commands::host_favorites::host_favorites_add,
            commands::host_favorites::host_favorites_remove,
            commands::host_favorites::host_favorites_reorder,
            commands::host_groups::host_groups_list,
            commands::host_groups::host_groups_set,
            commands::saved_hosts::saved_hosts_list,
            commands::saved_hosts::saved_hosts_upsert,
            commands::saved_hosts::saved_hosts_remove,
            commands::saved_hosts::saved_hosts_reorder,
            commands::secret_vault::vault_status,
            commands::secret_vault::vault_unlock,
            commands::secret_vault::vault_lock,
            commands::secret_vault::vault_get,
            commands::secret_vault::vault_set,
            commands::secret_vault::vault_remove,
            commands::search::search_global,
            commands::search::search_cancel,
            commands::keymap::keymap_list,
            commands::keymap::keymap_set,
            commands::keymap::keymap_unset,
            commands::keymap::keymap_reset,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::fs_ops::fs_delete_plan,
            commands::fs_ops::fs_delete_execute,
            commands::fs_ops::fs_copy_plan,
            commands::fs_ops::fs_copy_execute,
            commands::fs_ops::fs_move_plan,
            commands::fs_ops::fs_move_execute,
            commands::fs_ops::fs_compare_dirs,
            commands::fs_ops::fs_compare_cancel,
            commands::fs_ops::fs_merge_bidir,
            commands::fs_ops::fs_apply_compare,
            commands::fs_ops::fs_compare_verify,
            commands::fs_ops::fs_compare_three_way,
            commands::fs_ops::fs_export_compare,
            commands::fs_ops::fs_trash_usage,
            commands::fs_ops::fs_sync_preview,
            commands::fs_ops::fs_sync_plan,
            commands::fs_ops::fs_sync_execute,
            commands::fs_ops::fs_rename,
            commands::fs_ops::fs_batch_rename_preview,
            commands::fs_ops::fs_batch_rename,
            commands::fs_ops::fs_mkdir,
            commands::fs_ops::fs_read_preview,
            commands::fs_ops::fs_compare_pair_preview,
            commands::fs_ops::fs_copy_plan_external,
            commands::fs_ops::fs_archive_open_for_browse,
            commands::fs_ops::fs_extract_plan,
            commands::fs_ops::fs_extract_execute,
            commands::fs_ops::fs_compress_plan,
            commands::fs_ops::fs_repack_plan,
            commands::fs_ops::fs_compress_execute,
            commands::undo::undo_last,
            commands::undo::undo_history,
            commands::tasks::tasks_list,
            commands::tasks::task_cancel,
            commands::user_aliases::user_aliases_list,
            commands::user_aliases::user_aliases_add,
            commands::user_aliases::user_aliases_remove,
            commands::apps::apps_list,
            commands::apps::apps_add,
            commands::apps::apps_rename,
            commands::apps::apps_set_args,
            commands::apps::apps_remove,
            commands::apps::apps_reorder,
            commands::apps::apps_group,
            commands::apps::apps_move_into_folder,
            commands::apps::apps_move_out,
            commands::apps::apps_dissolve,
            commands::apps::apps_reorder_in_folder,
            commands::apps::app_launch,
        ])
        .events(collect_events![
            services::connection_events::ConnectionStateEvent,
            services::compare_events::CompareProgressEvent,
            services::fs_events::FsChangedEvent,
            services::journal_events::JournalChangedEvent,
            services::keymap_events::KeymapChangedEvent,
            services::task_events::TaskEvent,
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
    let settings = tauri::async_runtime::block_on(async {
        services::settings::SettingsStore::load_default().await
    })
    .expect("settings load");
    let journal =
        tauri::async_runtime::block_on(async { services::journal::Journal::load_default().await })
            .expect("journal load");
    let saved_hosts = tauri::async_runtime::block_on(async {
        services::saved_hosts::SavedHostsStore::load_default().await
    })
    .expect("saved hosts load");
    let secret_vault = tauri::async_runtime::block_on(async {
        services::secret_vault::SecretVault::load_default().await
    })
    .expect("secret vault load");
    let bookmarks = tauri::async_runtime::block_on(async {
        services::bookmarks::BookmarksStore::load_default().await
    })
    .expect("bookmarks load");
    let host_favorites = tauri::async_runtime::block_on(async {
        services::host_favorites::HostFavoritesStore::load_default().await
    })
    .expect("host favorites load");
    let host_groups = tauri::async_runtime::block_on(async {
        services::host_groups::HostGroupsStore::load_default().await
    })
    .expect("host groups load");
    let user_aliases = tauri::async_runtime::block_on(async {
        services::user_aliases::UserAliasesStore::load_default().await
    })
    .expect("user aliases load");
    let app_launchers = tauri::async_runtime::block_on(async {
        services::app_launchers::AppLaunchersStore::load_default().await
    })
    .expect("app launchers load");
    let keymap = tauri::async_runtime::block_on(async {
        services::keymap::KeymapStore::load_default().await
    })
    .expect("keymap load");
    let keymap_for_setup = keymap.clone();

    tauri::Builder::default()
        // duet-preview:// 스트리밍 프로토콜 (Range 지원, 로컬+SSH) — 미디어/PDF 미리보기.
        .register_asynchronous_uri_scheme_protocol("duet-preview", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(services::preview_stream::handle(app, request).await);
            });
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_drag::init())
        .manage(pool)
        .manage(settings)
        .manage(journal)
        .manage(saved_hosts)
        .manage(secret_vault)
        .manage(bookmarks)
        .manage(host_favorites)
        .manage(host_groups)
        .manage(user_aliases)
        .manage(app_launchers)
        .manage(keymap)
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);
            // FsWatcher 는 AppHandle 가 필요해 setup 에서 생성 → manage.
            let watcher = services::fs_watcher::FsWatcher::new(app.handle().clone())
                .expect("fs watcher init");
            app.manage(watcher);
            match services::keymap_watcher::start(app.handle().clone(), keymap_for_setup.clone()) {
                Ok(w) => {
                    app.manage(w);
                }
                Err(e) => tracing::warn!("keymap watcher: {e}"),
            }
            let task_queue = services::task_queue::TaskQueue::new(app.handle().clone());
            app.manage(task_queue);
            // 이전 실행/크래시에서 남은 로컬 아카이브 browse 임시 디렉토리 정리 (Phase 2).
            tauri::async_runtime::spawn(core::archive::reap_local_browse_root());
            let active_search = commands::search::ActiveSearch::new();
            app.manage(active_search);
            app.manage(commands::fs_ops::ActiveCompare::new());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
