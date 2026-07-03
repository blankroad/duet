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
            commands::system::ssh_edit_open,
            commands::system::reveal_path,
            commands::system::open_recycle_bin,
            commands::system::trash_location,
            commands::system::trash_restore,
            commands::system::places,
            commands::system::volumes,
            commands::system::ssh_places,
            commands::system::ssh_volumes,
            commands::system::eject_volume,
            commands::system::open_terminal,
            commands::system::shell_menu_open,
            commands::system::shell_menu_invoke,
            commands::system::shell_menu_close,
            commands::system::open_in_duet_get,
            commands::system::open_in_duet_set,
            commands::system::startup_open_path,
            commands::system::default_folder_handler_get,
            commands::system::default_folder_handler_set,
            commands::system::local_abs_paths,
            commands::connection::ssh_config_hosts,
            commands::connection::connection_open,
            commands::connection::connection_open_adhoc,
            commands::connection::connection_close,
            commands::connection::connection_list,
            commands::connection::ssh_setup_key_auth,
            commands::host_favorites::host_favorites_list,
            commands::host_favorites::host_favorites_add,
            commands::host_favorites::host_favorites_remove,
            commands::host_favorites::host_favorites_reorder,
            commands::host_groups::host_groups_list,
            commands::host_groups::host_groups_set,
            commands::host_nicknames::host_nickname_list,
            commands::host_nicknames::host_nickname_set,
            commands::host_nicknames::host_nickname_remove,
            commands::tags::tag_list,
            commands::tags::tag_set,
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
            commands::search::index_search,
            commands::search::index_reindex,
            commands::search::index_ensure,
            commands::search::index_build_global,
            commands::keymap::keymap_list,
            commands::keymap::keymap_set,
            commands::keymap::keymap_unset,
            commands::keymap::keymap_reset,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::fs_ops::fs_dir_size,
            commands::fs_ops::fs_delete_plan,
            commands::fs_ops::fs_delete_execute,
            commands::fs_ops::fs_copy_plan,
            commands::fs_ops::fs_copy_execute,
            commands::fs_ops::fs_copy_execute_elevated,
            commands::fs_ops::fs_copy_execute_sudo,
            commands::fs_ops::fs_move_execute_elevated,
            commands::fs_ops::fs_delete_execute_elevated,
            commands::fs_ops::fs_move_execute_sudo,
            commands::fs_ops::fs_delete_execute_sudo,
            commands::fs_ops::fs_move_plan,
            commands::fs_ops::fs_move_execute,
            commands::fs_ops::fs_compare_dirs,
            commands::fs_ops::fs_compare_cancel,
            commands::fs_ops::fs_merge_bidir,
            commands::fs_ops::fs_apply_compare,
            commands::fs_ops::fs_compare_verify,
            commands::fs_ops::fs_compare_three_way,
            commands::fs_ops::fs_apply_three_way,
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
            commands::frecency::frecency_record,
            commands::frecency::frecency_query,
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
            commands::system::file_icon,
        ])
        .events(collect_events![
            services::connection_events::ConnectionStateEvent,
            services::compare_events::CompareProgressEvent,
            services::fs_events::FsChangedEvent,
            services::journal_events::JournalChangedEvent,
            services::keymap_events::KeymapChangedEvent,
            services::task_events::TaskEvent,
            services::index_events::IndexProgressEvent,
            services::open_path_events::OpenPathEvent,
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
    // UAC 승격 자식 모드(`--elevated-op <manifest> --manifest-sha256 <hex>`): GUI 를
    // 띄우지 않고 manifest 의 복사만 수행 후 종료. runas 로 재실행된 승격 인스턴스.
    // (single-instance 등 어떤 초기화보다도 먼저.)
    {
        let argv: Vec<String> = std::env::args().collect();
        if let Some(i) = argv.iter().position(|a| a == "--elevated-op") {
            let manifest = argv.get(i + 1).map(String::as_str).unwrap_or("");
            let hash = argv
                .iter()
                .position(|a| a == "--manifest-sha256")
                .and_then(|j| argv.get(j + 1))
                .map(String::as_str)
                .unwrap_or("");
            let code = core::elevate::execute_child(std::path::Path::new(manifest), hash);
            std::process::exit(code);
        }
    }

    // 로그: stdout + `<config>/duet/logs/duet.log.<날짜>` 파일(일 단위 회전, ANSI 없음).
    // RUST_LOG 미설정 시 `duet_lib=info` — 터미널/env 설정 없이 그냥 실행해도 계측 로그
    // (셸 메뉴 타이밍 등)가 파일로 남는다. RUST_LOG 를 주면 그 필터가 우선.
    {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::util::SubscriberInitExt;
        let filter = tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("duet_lib=info"));
        let file_layer = services::settings::duet_config_dir().ok().and_then(|dir| {
            let logs = dir.join("logs");
            std::fs::create_dir_all(&logs).ok()?;
            let appender = tracing_appender::rolling::daily(logs, "duet.log");
            Some(
                tracing_subscriber::fmt::layer()
                    .with_writer(appender)
                    .with_ansi(false),
            )
        });
        tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer())
            .with(file_layer)
            .init();
    }

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
    let frecency = tauri::async_runtime::block_on(async {
        services::frecency::FrecencyStore::load_default().await
    })
    .expect("frecency load");
    let host_nicknames = tauri::async_runtime::block_on(async {
        services::host_nicknames::HostNicknamesStore::load_default().await
    })
    .expect("host nicknames load");
    let tags =
        tauri::async_runtime::block_on(async { services::tags::TagsStore::load_default().await })
            .expect("tags load");

    // single-instance 는 "가장 먼저" 등록돼야 한다(공식 문서). Windows 에서 duet 이
    // 기본 폴더 핸들러일 때 폴더를 열면 새 인스턴스가 뜨는데, 이를 기존 창으로 forward
    // 해 활성 패널의 새 탭으로 연다(OpenPathEvent). macOS/Linux 는 폴더 핸들러로 등록되지
    // 않으므로 미적용 — 의존성·플러그인 모두 cfg(windows).
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = {
        use tauri_specta::Event as _;
        builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
            // argv[1] = 더블클릭/"Open in duet" 으로 들어온 폴더. cold start 와 같은 해석 로직.
            if let Some(arg) = args.get(1) {
                if let Some(path) = commands::system::resolve_open_path(arg) {
                    let _ = services::open_path_events::OpenPathEvent { path }.emit(app);
                }
            }
        }))
    };
    builder
        // duet-preview:// 스트리밍 프로토콜 (Range 지원, 로컬+SSH) — 미디어/PDF 미리보기.
        .register_asynchronous_uri_scheme_protocol("duet-preview", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(services::preview_stream::handle(app, request).await);
            });
        })
        // duet-thumb:// — 그리드/타일 썸네일(이미지 디코드→축소→JPEG 캐시).
        .register_asynchronous_uri_scheme_protocol("duet-thumb", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(services::thumbnail::handle(app, request).await);
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
        .manage(frecency)
        .manage(host_nicknames)
        .manage(tags)
        .manage(platform::ShellMenuRegistry::new())
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
            // 파일명 인덱스(Everything 식 즉시·오프라인 검색) — 디스크 캐시 <config>/duet/index.
            app.manage(services::file_index::FileIndex::load_default().expect("file index init"));
            // Windows: 셸 메뉴 핫 워커를 시작 시 예열 — 첫 우클릭도 빠르게(핸들러 warm).
            #[cfg(windows)]
            {
                use tauri::Manager;
                let hwnd = app
                    .get_webview_window("main")
                    .and_then(|w| w.hwnd().ok())
                    .map(|h| h.0 as isize)
                    .unwrap_or(0);
                let reg = app.state::<std::sync::Arc<platform::ShellMenuRegistry>>();
                let worker = reg.worker();
                // 파일(*·확장자) 핸들러: 실행파일 경로. 디렉토리 핸들러: home.
                if let Ok(exe) = std::env::current_exe() {
                    worker.prewarm(hwnd, exe);
                }
                if let Some(home) = dirs::home_dir() {
                    worker.prewarm(hwnd, home);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
