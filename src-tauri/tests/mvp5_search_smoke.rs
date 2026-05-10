//! MVP-5 search smoke — local 트리 walk + find 파서.

use duet_lib::core::search::{parse_find_output, LocalFilenameSearch, SearchBackend, SearchOpts};
use duet_lib::types::{ConnectionId, EntryKind, SourceId};
use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn smoke_local_finds_in_subdirs() {
    let dir = tempdir().unwrap();
    let sub = dir.path().join("subdir");
    fs::create_dir(&sub).unwrap();
    fs::write(dir.path().join("alpha.txt"), b"x").unwrap();
    fs::write(sub.join("alpha_inner.md"), b"x").unwrap();
    fs::write(dir.path().join("beta.txt"), b"x").unwrap();

    let backend = LocalFilenameSearch;
    let hits = backend
        .search(
            dir.path(),
            "alpha",
            &SearchOpts::default(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
    assert!(names.contains(&"alpha.txt"));
    assert!(names.contains(&"alpha_inner.md"));
    assert!(!names.contains(&"beta.txt"));
}

#[tokio::test]
async fn smoke_local_max_results_cap() {
    let dir = tempdir().unwrap();
    for i in 0..50 {
        fs::write(dir.path().join(format!("alpha_{i}")), b"x").unwrap();
    }
    let backend = LocalFilenameSearch;
    let hits = backend
        .search(
            dir.path(),
            "alpha",
            &SearchOpts {
                max_results: 10,
                ..SearchOpts::default()
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(hits.len(), 10);
}

#[test]
fn smoke_parse_find_output_ssh_shape() {
    let conn_id = ConnectionId("conn-1".into());
    let ip = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5));
    let stdout = "/var/log/syslog\n/var/log/auth.log\n";
    let hits = parse_find_output(stdout, &conn_id, ip, "user1");
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].name, "syslog");
    assert_eq!(hits[0].location.path, PathBuf::from("/var/log"));
    match &hits[0].location.source {
        SourceId::Ssh {
            connection_id,
            host_ip,
            user,
        } => {
            assert_eq!(connection_id.0, "conn-1");
            assert_eq!(*host_ip, ip);
            assert_eq!(user, "user1");
        }
        _ => panic!("expected Ssh"),
    }
    assert_eq!(hits[0].kind, EntryKind::File);
}
