//! R2 independent checks. Docker tests use only the disposable duet-ssh-sol:2225.
#![cfg(unix)]
mod ssh_common;
use duet_lib::core::{
    copy_strategy::CopyStrategy,
    ops,
    search::{SearchBackend, SearchOpts, SshFilenameSearch},
    undo::execute_undo,
};
use duet_lib::fs::{FileSystem, SshFs};
use duet_lib::services::connection_pool::ActiveConnection;
use duet_lib::types::{ConnectionId, DeleteMode, EntryKind};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

fn fixture_enabled() -> bool {
    if ssh_common::skip_if_disabled() {
        return false;
    }
    assert_eq!(
        ssh_common::Host::from_env().port,
        2225,
        "use the dedicated sol container only"
    );
    true
}
async fn root(sess: &ssh_common::Session, topic: &str) -> PathBuf {
    let fs = SshFs::new(sess.conn.clone());
    let p = fs.join(
        &fs.home().await.unwrap(),
        &format!("review-sol-r2-{topic}-{}", uuid::Uuid::new_v4()),
    );
    fs.mkdir(&p).await.unwrap();
    p
}

#[tokio::test]
#[ignore = "remote-01 repro: sync prune targets a different folder (docker sshd :2225)"]
async fn sync_prune_must_not_remove_unrelated_folder_contents() {
    if !fixture_enabled() {
        return;
    }
    let sess = ssh_common::connect_password(&ssh_common::Host::from_env()).await;
    let fs = SshFs::new(sess.conn.clone());
    let base = root(&sess, "prune").await;
    let src = fs.join(&base, "source");
    let intended = fs.join(&base, "selected\\destination");
    let parent = fs.join(&base, "selected");
    let unrelated = fs.join(&parent, "destination");
    for p in [&src, &intended, &parent, &unrelated] {
        fs.mkdir(p).await.unwrap();
    }
    fs.write_full(&fs.join(&src, "new.txt"), b"NEW")
        .await
        .unwrap();
    fs.write_full(&fs.join(&intended, "intended.txt"), b"INTENDED")
        .await
        .unwrap();
    let victim = fs.join(&unrelated, "victim.txt");
    fs.write_full(&victim, b"UNRELATED ORIGINAL").await.unwrap();
    let mut plan = ops::sync_plan(
        &fs,
        &fs,
        ssh_common::loc(sess.source.clone(), &src),
        ssh_common::loc(sess.source.clone(), &intended),
    )
    .await
    .unwrap();
    plan.prune = true;
    assert_eq!(plan.strategy, CopyStrategy::SshSameHost);
    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    let entry = ops::sync_execute(&fs, &fs, plan, &ctx, CancellationToken::new(), None)
        .await
        .unwrap();
    let victim_after_sync = fs.metadata(&victim).await.is_ok();
    eprintln!("remote-01 victim present after sync={victim_after_sync}; journal={entry:?}");
    let undo = execute_undo(&entry, &sess.pool).await;
    let victim_after_undo = fs.metadata(&victim).await.is_ok();
    let misplaced_restore = fs.read_full(&fs.join(&intended, "victim.txt")).await.ok();
    eprintln!("remote-01 undo={:?} {:?}; victim present after undo={victim_after_undo}; misplaced restore={misplaced_restore:?}", undo.kind, undo.message);
    assert!(
        victim_after_sync,
        "sync pruned an unrelated folder despite a different selected destination"
    );
}

#[tokio::test]
#[ignore = "remote-03 repro: link identity lost in list/lstat (docker sshd :2225)"]
async fn symlink_matrix_preserves_identity() {
    if !fixture_enabled() {
        return;
    }
    let sess = ssh_common::connect_password(&ssh_common::Host::from_env()).await;
    let fs = SshFs::new(sess.conn.clone());
    let base = root(&sess, "links").await;
    fs.mkdir(&fs.join(&base, "real")).await.unwrap();
    for (name, target) in [
        ("directory-link", "real"),
        ("broken-link", "absent"),
        ("loop-link", "loop-link"),
    ] {
        fs.make_symlink(&fs.join(&base, name), target)
            .await
            .unwrap();
    }
    let entries = fs.list(&base).await.unwrap();
    for name in ["directory-link", "broken-link", "loop-link"] {
        let p = fs.join(&base, name);
        let stat = fs.metadata(&p).await;
        let lstat = fs.symlink_metadata(&p).await;
        eprintln!(
            "remote-03 {name}: list={:?}; stat={:?}; lstat={:?}",
            entries.iter().find(|e| e.name == name).map(|e| e.kind),
            stat.as_ref().map(|m| m.kind),
            lstat.as_ref().map(|m| m.kind)
        );
    }
    assert_eq!(
        fs.symlink_metadata(&fs.join(&base, "directory-link"))
            .await
            .unwrap()
            .kind,
        EntryKind::Symlink
    );
}

#[tokio::test]
#[ignore = "remote-08 repro: partial cross-device trash unjournaled (docker sshd :2225)"]
async fn partial_cross_device_trash_must_remain_recoverable() {
    if !fixture_enabled() {
        return;
    }
    let sess = ssh_common::connect_password(&ssh_common::Host::from_env()).await;
    let fs = SshFs::new(sess.conn.clone());
    let name = format!("review-sol-r2-xdev-{}", uuid::Uuid::new_v4());
    let tree = fs.join(Path::new("/dev/shm"), &name);
    fs.mkdir(&tree).await.unwrap();
    let locked = fs.join(&tree, "locked");
    fs.mkdir(&locked).await.unwrap();
    fs.write_full(&fs.join(&locked, "retained.txt"), b"LOCKED")
        .await
        .unwrap();
    for n in ["removable-a", "removable-b"] {
        fs.write_full(&fs.join(&tree, n), b"RECOVER ME")
            .await
            .unwrap();
    }
    fs.set_mode(&locked, 0o555, false).await.unwrap();
    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    let plan = ops::delete_plan(
        &fs,
        vec![ssh_common::entry(sess.source.clone(), "/dev/shm", &name)],
        DeleteMode::Trash,
    )
    .await
    .unwrap();
    let result = ops::delete_execute(&fs, plan, &ctx, "", None).await;
    let remaining = fs
        .list(&tree)
        .await
        .unwrap()
        .iter()
        .map(|e| e.name.clone())
        .collect::<Vec<_>>();
    let journal = ctx.journal.history(10).await;
    let home = fs.home().await.unwrap();
    let backups = ssh_common::stdout_str(
        &sess.conn,
        &format!(
            "find '{}' -name 'removable-*' -type f",
            fs.join(&home, ".duet-trash").display()
        ),
    )
    .await;
    eprintln!("remote-08 result={result:?}; remaining={remaining:?}; journal={}; backup files={backups:?}", journal.len());
    assert!(result.is_err());
    assert!(
        remaining.contains(&"removable-a".into()) && remaining.contains(&"removable-b".into()),
        "partial removal left no undo entry: {}",
        journal.len()
    );
}

#[tokio::test]
#[ignore = "remote-09 observation: cross-account permission control (docker sshd :2225)"]
async fn cross_account_copy_permission_controls() {
    if !fixture_enabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let duet = ssh_common::connect_password(&host).await;
    let raw = duet_lib::ssh::connection::connect_with_password(
        &host.host, host.port, "alt", "altpass", true, false,
    )
    .await
    .unwrap();
    let alt_id = ConnectionId(format!("sol-r2-alt-{}", uuid::Uuid::new_v4()));
    duet.pool
        .insert(ActiveConnection {
            id: alt_id.clone(),
            alias: "alt".into(),
            host_ip: raw.host_ip,
            endpoint: duet_lib::types::ServerEndpoint::new(raw.host_ip, host.port, &[]),
            user: "alt".into(),
            session: Some(tokio::sync::Mutex::new(raw.handle)),
            rsync_available: tokio::sync::Mutex::new(Some(false)),
            browse_temp_dirs: tokio::sync::Mutex::new(Vec::new()),
        })
        .await;
    let alt = duet.pool.get(&alt_id).await.unwrap();
    let srcfs = SshFs::new(alt.clone());
    let dstfs = SshFs::new(duet.conn.clone());
    let alt_home = srcfs.home().await.unwrap();
    srcfs.set_mode(&alt_home, 0o755, false).await.unwrap();
    let src = srcfs.join(
        &alt_home,
        &format!("review-sol-r2-src-{}", uuid::Uuid::new_v4()),
    );
    srcfs.mkdir(&src).await.unwrap();
    srcfs.set_mode(&src, 0o755, false).await.unwrap();
    srcfs
        .write_full(&srcfs.join(&src, "note.txt"), b"ALT DATA")
        .await
        .unwrap();
    srcfs
        .set_mode(&srcfs.join(&src, "note.txt"), 0o644, false)
        .await
        .unwrap();
    let base = root(&duet, "cross-account").await;
    dstfs.set_mode(&base, 0o755, false).await.unwrap();
    let (ctx, _cfg) = ssh_common::mk_ctx(duet.pool.clone()).await;
    for (label, mode, should_work) in [("private", 0o700, false), ("shared", 0o777, true)] {
        let dest = dstfs.join(&base, label);
        dstfs.mkdir(&dest).await.unwrap();
        dstfs.set_mode(&dest, mode, false).await.unwrap();
        let plan = ops::copy_plan(
            &srcfs,
            &dstfs,
            vec![ssh_common::entry(alt.source_id(), &src, "note.txt")],
            ssh_common::loc(duet.source.clone(), &dest),
        )
        .await
        .unwrap();
        assert_eq!(plan.strategy, CopyStrategy::SshSameHost);
        let r = ops::copy_execute(
            &srcfs,
            &dstfs,
            plan,
            ops::ConflictPolicy::Skip,
            &ctx,
            CancellationToken::new(),
            None,
        )
        .await;
        let listing =
            ssh_common::stdout_str(&duet.conn, &format!("ls -l '{}'", dest.display())).await;
        eprintln!("remote-09 {label} result={r:?}; destination={listing:?}");
        assert_eq!(r.is_ok(), should_work);
    }
}

#[tokio::test]
#[ignore = "remote-11 repro: hidden root suppresses descendants (docker sshd :2225)"]
async fn search_should_find_visible_files_below_hidden_root() {
    if !fixture_enabled() {
        return;
    }
    let sess = ssh_common::connect_password(&ssh_common::Host::from_env()).await;
    let fs = SshFs::new(sess.conn.clone());
    let base = root(&sess, "search").await;
    let hidden = fs.join(&base, ".settings");
    fs.mkdir(&hidden).await.unwrap();
    fs.write_full(&fs.join(&hidden, "visible.ini"), b"CONFIG")
        .await
        .unwrap();
    let backend = SshFilenameSearch {
        conn: sess.conn.clone(),
    };
    let mut counts = Vec::new();
    for include_hidden in [false, true] {
        let opts = SearchOpts {
            include_hidden,
            ..SearchOpts::default()
        };
        let found = backend
            .search(&hidden, "visible", &opts, CancellationToken::new())
            .await
            .unwrap();
        eprintln!("remote-11 include_hidden={include_hidden}; hits={found:?}");
        counts.push(found.len());
    }
    assert_eq!(counts, vec![1, 1]);
}

#[tokio::test]
#[ignore = "remote-07 observation: exec holds session lock (docker sshd :2225)"]
async fn long_exec_delays_the_supervisor_mutex() {
    if !fixture_enabled() {
        return;
    }
    let sess = ssh_common::connect_password(&ssh_common::Host::from_env()).await;
    let fs = Arc::new(SshFs::new(sess.conn.clone()));
    let taskfs = fs.clone();
    let task = tokio::spawn(async move { taskfs.exec_raw("sleep 3").await.unwrap() });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let start = Instant::now();
    let closed = {
        let h = sess.conn.session.as_ref().unwrap().lock().await;
        h.is_closed()
    };
    eprintln!(
        "remote-07 health-check mutex wait={:?}; closed={closed}",
        start.elapsed()
    );
    assert!(start.elapsed() > Duration::from_secs(2));
    assert_eq!(task.await.unwrap().exit_status, 0);
}

#[tokio::test]
async fn corrupt_host_stores_should_be_recoverable() {
    use duet_lib::services::{
        host_favorites::HostFavoritesStore, host_groups::HostGroupsStore,
        host_nicknames::HostNicknamesStore, saved_hosts::SavedHostsStore,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("broken.json");
    std::fs::write(&path, "[{\"alias\":").unwrap();
    let results = [
        ("saved", SavedHostsStore::load_from(&path).await.map(|_| ())),
        (
            "favorites",
            HostFavoritesStore::load_from(&path).await.map(|_| ()),
        ),
        (
            "groups",
            HostGroupsStore::load_from(&path).await.map(|_| ()),
        ),
        (
            "nicknames",
            HostNicknamesStore::load_from(&path).await.map(|_| ()),
        ),
    ];
    eprintln!("remote-19 loads={results:?}");
    assert!(
        results.iter().all(|(_, r)| r.is_ok()),
        "startup expect panics on these errors"
    );
}
