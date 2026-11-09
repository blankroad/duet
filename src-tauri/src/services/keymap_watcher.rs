//! Keymap.toml 파일 watcher — 변경 시 store 갱신 + KeymapChangedEvent emit.
//!
//! `notify` crate 사용. 무한 루프 방지: 새 bindings 가 store 현재 값과 같으면 emit 안 함
//! (앱 자신의 저장도 파일 변경 알림을 일으킨다). 다시 읽다 실패하면(문법 오류 등) 이전 키를
//! 그대로 쓰고 `KeymapLoadFailedEvent` 로 알린다 — 같은 오류가 이어지면 한 번만(shell-settings-12).

use crate::services::keymap::{read_file, KeymapStore};
use crate::services::keymap_events::{KeymapChangedEvent, KeymapLoadFailedEvent};
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

/// 재읽기 실패를 알릴지 정한다. 마지막으로 알린 오류와 같으면 `false`(한 번 저장에 변경
/// 알림이 여러 번 오므로). `None` 을 넘기면(재읽기 성공) 기록을 비워 다음 오류는 다시 알린다.
pub(crate) fn should_report_error(last_reported: &mut Option<String>, error: Option<&str>) -> bool {
    match error {
        None => {
            *last_reported = None;
            false
        }
        Some(msg) if last_reported.as_deref() == Some(msg) => false,
        Some(msg) => {
            *last_reported = Some(msg.to_string());
            true
        }
    }
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
    let last_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else { return };
            let modified = matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));
            if !modified {
                return;
            }
            // 원자적 저장의 임시 파일(`.keymap.toml.tmp`)은 이름이 달라 여기서 걸러진다.
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
            let last_error = last_error.clone();
            tauri::async_runtime::spawn(async move {
                let read = read_file(&path).await;
                // Guard is scoped so it is dropped before any `.await`.
                let report = {
                    let mut guard = last_error.lock().unwrap_or_else(|p| p.into_inner());
                    let msg = read.as_ref().err().map(|e| e.to_string());
                    if should_report_error(&mut guard, msg.as_deref()) {
                        msg
                    } else {
                        None
                    }
                };
                let new_bindings = match read {
                    Ok(b) => b,
                    Err(e) => {
                        tracing::warn!("keymap re-read failed, keeping previous keys: {e}");
                        if let Some(message) = report {
                            let _ = KeymapLoadFailedEvent { message }.emit(&app);
                        }
                        return;
                    }
                };
                // 비교 기준은 store 현재 값 — 시작 직후 첫 외부 편집이 "전부 비우기" 여도
                // 반영된다(shell-settings-18; 예전엔 빈 Vec 으로 시작한 별도 기록과 비교).
                if !store.replace_if_changed(new_bindings.clone()).await {
                    return;
                }
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

#[cfg(test)]
mod tests {
    use super::should_report_error;

    #[test]
    fn same_error_is_reported_once_until_a_success() {
        let mut last = None;
        assert!(should_report_error(&mut last, Some("line 2: bad")));
        // 한 번 저장에 변경 알림이 여러 번 — 같은 오류는 다시 알리지 않는다.
        assert!(!should_report_error(&mut last, Some("line 2: bad")));
        // 다른 오류는 알린다.
        assert!(should_report_error(&mut last, Some("line 3: bad")));
        // 고쳐서 성공하면 초기화 → 같은 오류가 다시 생기면 다시 알린다.
        assert!(!should_report_error(&mut last, None));
        assert!(should_report_error(&mut last, Some("line 3: bad")));
    }
}
