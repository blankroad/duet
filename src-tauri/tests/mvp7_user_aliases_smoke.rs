//! MVP-7 user aliases smoke — Navigate + Connect lifecycle.

use duet_lib::services::user_aliases::{AliasKind, UserAliasesStore};
use duet_lib::types::{Location, SourceId};
use std::path::PathBuf;
use tempfile::tempdir;

#[tokio::test]
async fn smoke_lifecycle() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("ua.json");
    let s = UserAliasesStore::load_from(&path).await.unwrap();
    assert!(s.list().await.is_empty());

    s.add(
        "tmp".into(),
        AliasKind::Navigate {
            location: Location {
                source: SourceId::Local,
                path: PathBuf::from("/tmp"),
            },
        },
    )
    .await
    .unwrap();
    s.add(
        "prod".into(),
        AliasKind::Connect {
            saved_host_alias: "prod".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(s.list().await.len(), 2);

    let s2 = UserAliasesStore::load_from(&path).await.unwrap();
    let list = s2.list().await;
    assert_eq!(list.len(), 2);
    let id = list[0].id.clone();
    s2.remove(&id).await.unwrap();
    assert_eq!(s2.list().await.len(), 1);
}
