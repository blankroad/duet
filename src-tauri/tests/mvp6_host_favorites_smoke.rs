//! MVP-6 host favorites smoke — lifecycle + persistence.

use duet_lib::services::host_favorites::HostFavoritesStore;
use std::path::PathBuf;
use tempfile::tempdir;

#[tokio::test]
async fn smoke_lifecycle() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("hf.json");
    let s = HostFavoritesStore::load_from(&path).await.unwrap();
    assert!(s.list().await.is_empty());

    s.add("alpha".into(), "logs".into(), PathBuf::from("/var/log"))
        .await
        .unwrap();
    s.add("beta".into(), "home".into(), PathBuf::from("/home/u"))
        .await
        .unwrap();
    assert_eq!(s.list().await.len(), 2);

    let s2 = HostFavoritesStore::load_from(&path).await.unwrap();
    let list = s2.list().await;
    assert_eq!(list.len(), 2);
    assert!(list.iter().any(|f| f.host_alias == "alpha"));
    assert!(list.iter().any(|f| f.host_alias == "beta"));

    let id = list[0].id.clone();
    s2.remove(&id).await.unwrap();
    assert_eq!(s2.list().await.len(), 1);
}
