//! Keymap.toml 파일 watcher — 변경 시 store 갱신 + KeymapChangedEvent emit.
//!
//! `notify` crate 사용. 무한 루프 방지: 새 bindings 가 store 와 동일하면 emit 안 함.

use crate::services::keymap::{read_file, KeymapStore};
use crate::services::keymap_events::KeymapChangedEvent;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_specta::Event as _;

/// notify watcher 인스턴스 — drop 되면 watcher 종료.
pub struct KeymapWatcher {
    _inner: RecommendedWatcher,
}

/// keymap.toml 파일 watcher 시작. 변경 감지 → re-read → store 갱신 → emit.
pub fn start(app: AppHandle, store: Arc<KeymapStore>) -> Result<KeymapWatcher, String> {
    let path: PathBuf = store.path().to_path_buf();
    let dir = path
        .parent()
        .ok_or_else(|| "keymap path has no parent".to_string())?
        .to_path_buf();
    let target_filename = path
        .file_name()
        .ok_or_else(|| "keymap path has no file_name".to_string())?
        .to_owned();

    let app_for_cb = app.clone();
    let store_for_cb = store.clone();
    let path_for_cb = path.clone();
    let target_for_cb = target_filename.clone();
    let last_emitted: Arc<Mutex<Vec<crate::services::keymap::KeymapBinding>>> =
        Arc::new(Mutex::new(Vec::new()));
    let last_for_cb = last_emitted.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else { return };
            let modified = matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));
            if !modified {
                return;
            }
            let touches_keymap = event
                .paths
                .iter()
                .any(|p| p.file_name() == Some(&target_for_cb));
            if !touches_keymap {
                return;
            }

            let store = store_for_cb.clone();
            let app = app_for_cb.clone();
            let path = path_for_cb.clone();
            let last = last_for_cb.clone();
            tauri::async_runtime::spawn(async move {
                let new_bindings = match read_file(&path).await {
                    Ok(b) => b,
                    Err(e) => {
                        tracing::warn!("keymap re-read failed: {e}");
                        return;
                    }
                };
                // Guard is scoped so it is dropped before any `.await`.
                let changed = {
                    let mut last_guard = last.lock().expect("poisoned");
                    if *last_guard == new_bindings {
                        false
                    } else {
                        *last_guard = new_bindings.clone();
                        true
                    }
                };
                if !changed {
                    return;
                }
                store.replace(new_bindings.clone()).await;
                let _ = KeymapChangedEvent {
                    bindings: new_bindings,
                }
                .emit(&app);
            });
        },
        Config::default(),
    )
    .map_err(|e| format!("notify watcher init: {e}"))?;

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("notify watch start: {e}"))?;

    Ok(KeymapWatcher { _inner: watcher })
}
