//! MVP-7 keymap smoke — TOML roundtrip, set/unset, reset.

use duet_lib::services::keymap::{read_file, KeymapStore};
use tempfile::tempdir;

#[tokio::test]
async fn smoke_lifecycle() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("keymap.toml");
    let s = KeymapStore::load_from(&path).await.unwrap();
    assert!(s.list().await.is_empty());

    s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
    s.set("Ctrl+W".into(), "tab.close".into()).await.unwrap();
    s.set("Alt+Left".into(), "nav.back".into()).await.unwrap();
    assert_eq!(s.list().await.len(), 3);

    let bindings = read_file(&path).await.unwrap();
    assert_eq!(bindings.len(), 3);

    s.unset("Ctrl+W").await.unwrap();
    assert_eq!(s.list().await.len(), 2);

    s.reset().await.unwrap();
    assert!(s.list().await.is_empty());
    let bindings = read_file(&path).await.unwrap();
    assert_eq!(bindings.len(), 0);
}
