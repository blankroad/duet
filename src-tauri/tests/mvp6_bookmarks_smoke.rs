//! MVP-6 bookmarks smoke — lifecycle.

use duet_lib::services::bookmarks::BookmarksStore;
use duet_lib::types::{Location, SourceId};
use std::path::PathBuf;
use tempfile::tempdir;

fn loc(p: &str) -> Location {
    Location {
        source: SourceId::Local,
        path: PathBuf::from(p),
    }
}

#[tokio::test]
async fn smoke_lifecycle() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("bm.json");
    let s = BookmarksStore::load_from(&path).await.unwrap();
    assert!(s.list().await.is_empty());

    s.add("Alpha".into(), loc("/a")).await.unwrap();
    s.add("Beta".into(), loc("/b")).await.unwrap();
    let list = s.list().await;
    assert_eq!(list.len(), 2);

    let id_alpha = list.iter().find(|b| b.name == "Alpha").unwrap().id.clone();
    s.remove(&id_alpha).await.unwrap();
    s.remove("ghost").await.unwrap();

    let s2 = BookmarksStore::load_from(&path).await.unwrap();
    let list2 = s2.list().await;
    assert_eq!(list2.len(), 1);
    assert_eq!(list2[0].name, "Beta");
}
