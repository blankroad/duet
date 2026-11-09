//! keymap review: tempdir-only disk failures and external edits; no Tauri app.

use duet_lib::services::keymap::{read_file, KeymapStore};
use duet_lib::services::startup_notices::StartupNoticeKind;

/// 시작 로드에서 문법 오류 — 앱은 빈 키맵으로 켜지고, 원본은 `.corrupt-<시각>` 으로 보존된다
/// (shell-settings-01 수정 전에는 Err → 부팅 패닉이었다).
#[tokio::test]
async fn invalid_toml_load_starts_empty_and_keeps_original_aside() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("keymap.toml");
    let text = "[bindings\n\"Ctrl+T\" = \"tab.new\"";
    tokio::fs::write(&path, text).await.unwrap();
    let store = KeymapStore::load_from(&path).await.unwrap();
    assert!(store.list().await.is_empty());
    let notice = store.load_notice().expect("startup notice");
    let StartupNoticeKind::Reset { backup } = notice.action else {
        panic!("expected Reset, got {:?}", notice.action);
    };
    assert_eq!(tokio::fs::read_to_string(&backup).await.unwrap(), text);
}

#[tokio::test]
async fn external_invalid_toml_does_not_mutate_existing_store() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("keymap.toml");
    let store = KeymapStore::load_from(&path).await.unwrap();
    let initial = store.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
    tokio::fs::write(&path, "[bindings\n").await.unwrap();
    assert!(read_file(&path).await.is_err());
    assert_eq!(store.list().await, initial);
}

#[tokio::test]
async fn reset_persists_empty_bindings() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("keymap.toml");
    let store = KeymapStore::load_from(&path).await.unwrap();
    store.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
    store.reset().await.unwrap();
    assert!(store.list().await.is_empty());
    assert!(read_file(&path).await.unwrap().is_empty());
}

#[tokio::test]
async fn failed_save_retains_last_successful_bindings() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("keymap.toml");
    let store = KeymapStore::load_from(&path).await.unwrap();
    let original = store.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
    tokio::fs::rename(&path, temp.path().join("last-good.toml"))
        .await
        .unwrap();
    tokio::fs::create_dir(&path).await.unwrap();
    assert!(store
        .set("Ctrl+W".into(), "tab.close".into())
        .await
        .is_err());
    assert_eq!(store.list().await, original);
}
