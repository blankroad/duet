//! Saved-hosts smoke — roundtrip + upsert overwrite + remove no-op.

use duet_lib::services::saved_hosts::{SavedHost, SavedHostsStore};
use std::path::PathBuf;
use tempfile::tempdir;

fn mk(alias: &str, host: &str) -> SavedHost {
    SavedHost {
        alias: alias.into(),
        host: host.into(),
        port: 22,
        user: "tester".into(),
        key_path: Some(PathBuf::from("/tmp/key")),
    }
}

#[tokio::test]
async fn smoke_full_lifecycle() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("saved-hosts.json");

    // empty start
    let store = SavedHostsStore::load_from(&path).await.unwrap();
    assert!(store.list().await.is_empty());

    // upsert two
    store.upsert(mk("alpha", "1.1.1.1")).await.unwrap();
    store.upsert(mk("beta", "2.2.2.2")).await.unwrap();
    assert_eq!(store.list().await.len(), 2);

    // overwrite alpha
    let mut updated = mk("alpha", "9.9.9.9");
    updated.user = "root".into();
    store.upsert(updated).await.unwrap();
    let list = store.list().await;
    assert_eq!(list.len(), 2);
    let alpha = list.iter().find(|h| h.alias == "alpha").unwrap();
    assert_eq!(alpha.host, "9.9.9.9");
    assert_eq!(alpha.user, "root");

    // remove non-existent (no-op)
    store.remove("ghost").await.unwrap();
    assert_eq!(store.list().await.len(), 2);

    // remove existing
    store.remove("beta").await.unwrap();
    let list = store.list().await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].alias, "alpha");

    // reload from disk verifies persistence
    let store2 = SavedHostsStore::load_from(&path).await.unwrap();
    let list2 = store2.list().await;
    assert_eq!(list2.len(), 1);
    assert_eq!(list2[0].alias, "alpha");
    assert_eq!(list2[0].host, "9.9.9.9");
}

#[tokio::test]
async fn smoke_empty_alias_rejected() {
    let dir = tempdir().unwrap();
    let store = SavedHostsStore::load_from(&dir.path().join("h.json"))
        .await
        .unwrap();
    let bad = SavedHost {
        alias: "".into(),
        host: "x".into(),
        port: 22,
        user: "u".into(),
        key_path: None,
    };
    assert!(store.upsert(bad).await.is_err());
}
