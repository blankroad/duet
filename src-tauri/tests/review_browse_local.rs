//! browse R1: temporary-only local listing, size and notify boundary checks.
use duet_lib::fs::{FileSystem, LocalFs};
#[cfg(unix)]
use duet_lib::types::EntryKind;
use std::time::{Duration, Instant};

#[tokio::test]
async fn dotfiles_and_case_distinct_names_when_supported() {
    let fixture = tempfile::tempdir().unwrap();
    std::fs::write(fixture.path().join(".dotfile"), b"dot").unwrap();
    std::fs::write(fixture.path().join("a.txt"), b"lower").unwrap();
    let distinct = std::fs::File::options()
        .write(true)
        .create_new(true)
        .open(fixture.path().join("A.txt"))
        .is_ok();
    let entries = LocalFs::new().list(fixture.path()).await.unwrap();
    assert!(
        entries
            .iter()
            .find(|entry| entry.name == ".dotfile")
            .unwrap()
            .hidden
    );
    if distinct {
        assert!(entries.iter().any(|entry| entry.name == "a.txt"));
        assert!(entries.iter().any(|entry| entry.name == "A.txt"));
    } else {
        eprintln!("case-distinct fixture unsupported on this case-insensitive volume");
    }
}

#[tokio::test]
async fn folder_links_broken_links_and_cycles_remain_listable() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        std::fs::create_dir(root.join("folder")).unwrap();
        std::fs::write(root.join("folder/data"), b"abc").unwrap();
        symlink("folder", root.join("folder-link")).unwrap();
        symlink("missing", root.join("broken")).unwrap();
        symlink("b", root.join("a")).unwrap();
        symlink("a", root.join("b")).unwrap();
        let fs = LocalFs::new();
        let listed = fs.list(root).await.unwrap();
        let kind = |name| listed.iter().find(|e| e.name == name).unwrap().kind;
        assert_eq!(kind("folder-link"), EntryKind::Dir);
        for name in ["broken", "a", "b"] {
            assert_eq!(kind(name), EntryKind::Symlink);
        }
        assert_eq!(fs.dir_size(root).await.unwrap(), 3);
        assert_eq!(fs.dir_size(&root.join("folder-link")).await.unwrap(), 0);
    }
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "browse-21 repro (F-sol-01)"]
async fn macos_uf_hidden_should_be_reflected_in_listing() {
    use std::os::macos::fs::MetadataExt;
    let fixture = tempfile::tempdir().unwrap();
    let file = fixture.path().join("finder-hidden.txt");
    std::fs::write(&file, b"data").unwrap();
    let status = std::process::Command::new("/usr/bin/chflags")
        .arg("hidden")
        .arg(&file)
        .status()
        .unwrap();
    assert!(status.success());
    assert_ne!(std::fs::metadata(&file).unwrap().st_flags() & 0x8000, 0);
    let entries = LocalFs::new().list(fixture.path()).await.unwrap();
    assert!(entries[0].hidden, "UF_HIDDEN file returned hidden=false");
}

#[cfg(unix)]
#[tokio::test]
async fn non_utf8_names_should_not_silently_disappear_if_filesystem_accepts_them() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    let fixture = tempfile::tempdir().unwrap();
    let file = fixture
        .path()
        .join(OsString::from_vec(b"invalid-\xff".to_vec()));
    if let Err(error) = std::fs::write(file, b"abc") {
        eprintln!("non-UTF8 fixture unsupported by this filesystem: {error}");
        return;
    }
    assert_eq!(std::fs::read_dir(fixture.path()).unwrap().count(), 1);
    let entries = LocalFs::new().list(fixture.path()).await.unwrap();
    assert_eq!(
        entries.len(),
        1,
        "existing non-UTF8 file omitted without warning"
    );
}

#[tokio::test]
async fn twenty_thousand_entries_listing_timing() {
    let fixture = tempfile::tempdir().unwrap();
    for i in 0..20_000 {
        std::fs::write(fixture.path().join(format!("entry-{i:05}.txt")), b"x").unwrap();
    }
    let start = Instant::now();
    let entries = LocalFs::new().list(fixture.path()).await.unwrap();
    eprintln!("20,000 entries listing elapsed={:?}", start.elapsed());
    assert_eq!(entries.len(), 20_000);
    assert!(start.elapsed() < Duration::from_secs(120));
}

#[tokio::test]
async fn hard_links_count_logical_bytes_for_each_name() {
    let fixture = tempfile::tempdir().unwrap();
    std::fs::write(fixture.path().join("a"), b"1234567").unwrap();
    std::fs::hard_link(fixture.path().join("a"), fixture.path().join("b")).unwrap();
    assert_eq!(LocalFs::new().dir_size(fixture.path()).await.unwrap(), 14);
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "browse-19 repro (F-sol-12)"]
async fn unreadable_child_should_preserve_readable_subtotal() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = tempfile::tempdir().unwrap();
    let blocked = fixture.path().join("blocked");
    std::fs::create_dir(&blocked).unwrap();
    std::fs::write(fixture.path().join("readable"), b"1234567").unwrap();
    std::fs::write(blocked.join("secret"), b"abc").unwrap();
    std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o0)).unwrap();
    let inaccessible = std::fs::read_dir(&blocked).is_err();
    let actual = LocalFs::new().dir_size(fixture.path()).await;
    std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o700)).unwrap();
    if !inaccessible {
        eprintln!("permission fixture bypassed by process privileges; not verified");
        return;
    }
    assert_eq!(
        actual.unwrap(),
        7,
        "readable subtree should remain measurable"
    );
}

#[test]
#[ignore = "browse-12 repro (F-sol-04)"]
fn shared_notify_path_should_remain_watched_after_one_pane_leaves() {
    use notify::{RecursiveMode, Watcher};
    let fixture = tempfile::tempdir().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    })
    .unwrap();
    // Exact notify calls issued by FsWatcher for left=root, right=root, left=elsewhere.
    watcher
        .watch(fixture.path(), RecursiveMode::NonRecursive)
        .unwrap();
    watcher
        .watch(fixture.path(), RecursiveMode::NonRecursive)
        .unwrap();
    watcher.unwatch(fixture.path()).unwrap();
    let probe = fixture.path().join("right-pane-needs-this-event");
    std::fs::write(&probe, b"data").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut seen = false;
    while Instant::now() < deadline {
        if let Ok(Ok(event)) = rx.recv_timeout(Duration::from_millis(100)) {
            seen |= event.paths.iter().any(|path| path == &probe);
        }
    }
    assert!(
        seen,
        "no event after one of two same-path watches is removed"
    );
}

#[test]
fn notify_thousand_file_burst_event_count() {
    use notify::{RecursiveMode, Watcher};
    let fixture = tempfile::tempdir().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    })
    .unwrap();
    watcher
        .watch(fixture.path(), RecursiveMode::NonRecursive)
        .unwrap();
    for i in 0..1000 {
        std::fs::write(fixture.path().join(format!("burst-{i}")), b"x").unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut events = 0;
    let mut emitted_paths = 0;
    while Instant::now() < deadline {
        if let Ok(Ok(event)) = rx.recv_timeout(Duration::from_millis(100)) {
            if matches!(
                event.kind,
                notify::EventKind::Create(_)
                    | notify::EventKind::Modify(_)
                    | notify::EventKind::Remove(_)
            ) {
                events += 1;
                emitted_paths += event.paths.len();
            }
        }
    }
    eprintln!(
        "1,000 file burst: notify events={events}, FsChangedEvent candidates={emitted_paths}"
    );
    assert!(events > 0);
}
