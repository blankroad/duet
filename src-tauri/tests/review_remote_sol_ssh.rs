//! Remote R1 Docker-only authentication, ProxyJump and shell quoting checks.
// HOME isolation is Unix-specific; never let these tests write Windows real profiles.
#![cfg(unix)]

mod ssh_common;
use duet_lib::core::ops::{copy_execute, copy_plan, ConflictPolicy};
use duet_lib::fs::{FileSystem, SshFs};
use duet_lib::ssh::{config::SshHostEntry, connection, remote_exec};
use duet_lib::types::DuetError;
use std::path::Path;
use tokio_util::sync::CancellationToken;

#[tokio::test]
#[ignore = "remote-01 repro: backslash name overwrites unrelated file (docker sshd)"]
async fn same_host_copy_must_preserve_backslash_name() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let sess = ssh_common::connect_password(&ssh_common::Host::from_env()).await;
    *sess.conn.rsync_available.lock().await = Some(false);
    let fs = SshFs::new(sess.conn.clone());
    let home = fs.home().await.unwrap();
    let root = fs.join(
        &home,
        &format!("review-sol-backslash-{}", uuid::Uuid::new_v4()),
    );
    fs.mkdir(&root).await.unwrap();
    let src = fs.join(&root, "src");
    let dst = fs.join(&root, "dst");
    fs.mkdir(&src).await.unwrap();
    fs.mkdir(&dst).await.unwrap();
    fs.mkdir(&fs.join(&dst, "a")).await.unwrap();
    fs.write_full(&fs.join(&dst, "a/b"), b"UNRELATED ORIGINAL")
        .await
        .unwrap();
    let name = "a\\b";
    fs.write_full(&fs.join(&src, name), b"SELECTED")
        .await
        .unwrap();
    fs.mkdir(&fs.join(&src, "a")).await.unwrap();
    fs.write_full(&fs.join(&src, "a/b"), b"OTHER FILE")
        .await
        .unwrap();
    let plan = copy_plan(
        &fs,
        &fs,
        vec![ssh_common::entry(sess.source.clone(), &src, name)],
        ssh_common::loc(sess.source.clone(), &dst),
    )
    .await
    .unwrap();
    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    let result = copy_execute(
        &fs,
        &fs,
        plan,
        ConflictPolicy::Skip,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await;
    eprintln!(
        "copy result={result:?}; destination={:?}",
        fs.list(&dst)
            .await
            .unwrap()
            .iter()
            .map(|e| &e.name)
            .collect::<Vec<_>>()
    );
    assert!(result.is_ok(), "copy failed: {result:?}");
    let unrelated = fs.read_full(&fs.join(&dst, "a/b")).await.unwrap();
    eprintln!(
        "unrelated destination now={}",
        String::from_utf8_lossy(&unrelated)
    );
    assert_eq!(
        unrelated, b"UNRELATED ORIGINAL",
        "Skip must not overwrite an unrelated existing file"
    );
    assert_eq!(
        fs.read_full(&fs.join(&dst, name)).await.unwrap(),
        b"SELECTED"
    );
}

#[tokio::test]
#[ignore = "remote-16 evidence: encrypted key needs passphrase (docker sshd)"]
async fn key_password_and_wrong_key() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let _ = ssh_common::connect_key(&host).await;
    assert!(matches!(
        connection::connect_with_password(
            &host.host,
            host.port,
            &host.user,
            "wrong-review-password",
            false,
            false
        )
        .await,
        Err(DuetError::AuthFailed)
    ));
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("encrypted");
    let output = std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "review-test-only", "-f"])
        .arg(&key)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(matches!(
        connection::connect_with_key(&host.host, host.port, &host.user, &key, None).await,
        Err(DuetError::AuthFailed)
    ));
    let sess = ssh_common::connect_password(&host).await;
    let pubkey = std::fs::read_to_string(key.with_extension("pub")).unwrap();
    // Generated public key only; no private credential leaves this tempdir.
    let public = duet_lib::core::copy_strategy::shell_escape_str(pubkey.trim()).unwrap();
    ssh_common::run(
        &sess.conn,
        &format!("printf '%s\\n' {public} >> .ssh/authorized_keys"),
    )
    .await;
    let encrypted = connection::connect_with_key(
        &host.host,
        host.port,
        &host.user,
        &key,
        Some("review-test-only"),
    )
    .await;
    assert!(encrypted.is_ok());
    let bad = dir.path().join("bad");
    std::fs::write(&bad, "not a key").unwrap();
    assert!(matches!(
        connection::connect_with_key(&host.host, host.port, &host.user, &bad, None).await,
        Err(DuetError::AuthFailed)
    ));
}

#[tokio::test]
#[ignore = "remote-14/02 attempt: needs forwarding-enabled fixture"]
async fn nested_jump_survives_session_handle_registration() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let h = ssh_common::Host::from_env();
    let key = h.key.clone().unwrap();
    let jump = SshHostEntry {
        alias: "jump".into(),
        hostname: h.host.clone(),
        port: h.port,
        user: h.user.clone(),
        identity_files: vec![key.clone()],
        proxy_jump: vec![],
    };
    let inner = SshHostEntry {
        alias: "inner".into(),
        hostname: "127.0.0.1".into(),
        port: 22,
        user: h.user.clone(),
        identity_files: vec![key.clone()],
        proxy_jump: vec![],
    };
    for hops in [vec!["jump".into()], vec!["jump".into(), "inner".into()]] {
        let target = SshHostEntry {
            alias: "target".into(),
            hostname: "127.0.0.1".into(),
            port: 22,
            user: h.user.clone(),
            identity_files: vec![key.clone()],
            proxy_jump: hops,
        };
        let all = vec![jump.clone(), inner.clone(), target.clone()];
        let sess = connection::connect(&target, &all, true, false)
            .await
            .unwrap();
        let out = remote_exec::exec(&sess.handle, "printf nested-ok")
            .await
            .unwrap();
        assert_eq!(out.stdout, b"nested-ok");
        let handle = sess.handle; // Mirrors commands::connection::open_and_register.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let out = remote_exec::exec(&handle, "printf registered-ok")
            .await
            .unwrap();
        assert_eq!(out.stdout, b"registered-ok");
    }
}

#[tokio::test]
#[ignore = "remote C-17 baseline: hostile names quoted (docker sshd)"]
async fn exec_operations_treat_hostile_names_as_data() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let sess = ssh_common::connect_password(&ssh_common::Host::from_env()).await;
    let fs = SshFs::new(sess.conn.clone());
    let root = fs.join(
        &fs.home().await.unwrap(),
        &format!("review-sol-quotes-{}", uuid::Uuid::new_v4()),
    );
    fs.mkdir(&root).await.unwrap();
    for name in ["-rf", "$(id)", "`x`", "it's a file", "한글 파일"] {
        let path = fs.join(&root, name);
        fs.write_full(&path, b"hello").await.unwrap();
        fs.set_mode(&path, 0o600, false).await.unwrap();
        let sum = fs
            .checksum(&path, duet_lib::types::ChecksumAlgo::Sha256)
            .await
            .unwrap();
        assert_eq!(
            sum,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        let link = fs.join(&root, &format!("link-{name}"));
        fs.make_symlink(&link, path.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(fs.read_full(&link).await.unwrap(), b"hello");
    }
    // String quoting is also used for patterns/passwords; NUL must be rejected.
    assert!(duet_lib::core::copy_strategy::shell_escape_path(Path::new("/a/\0b")).is_err());
}

#[tokio::test]
#[ignore = "remote C-17 baseline: checksum newline name (docker sshd)"]
async fn checksum_handles_newline_in_filename() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let sess = ssh_common::connect_password(&ssh_common::Host::from_env()).await;
    let fs = SshFs::new(sess.conn.clone());
    let path = fs.join(
        &fs.home().await.unwrap(),
        &format!("review-sol-checksum-{}\nline", uuid::Uuid::new_v4()),
    );
    fs.write_full(&path, b"hello").await.unwrap();
    assert_eq!(
        fs.checksum(&path, duet_lib::types::ChecksumAlgo::Sha256)
            .await
            .unwrap(),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
}

#[tokio::test]
#[ignore = "remote-12 repro: sudo staging parent missing (docker sshd)"]
async fn first_sudo_copy_creates_staging_parent() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let sess = ssh_common::connect_password(&ssh_common::Host::from_env()).await;
    let fs = SshFs::new(sess.conn.clone());
    let home = fs.home().await.unwrap();
    let staging = fs.join(&home, ".duet-sudo");
    assert!(
        fs.metadata(&staging).await.is_err(),
        "fixture precondition: .duet-sudo must be absent"
    );
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("review-sol-stage");
    std::fs::write(&src, b"test-only").unwrap();
    let result = duet_lib::core::sudo::execute_sudo(
        duet_lib::core::elevate::ElevatedOp::Copy,
        &duet_lib::fs::LocalFs::new(),
        &fs,
        true,
        vec![(src, Some(fs.join(&home, "review-sol-sudo-destination")))],
        Some("test-only"),
        ConflictPolicy::Skip,
    )
    .await;
    eprintln!("sudo staging result={result:?}");
    // With no sudo installed, reaching sudo should produce an outcome, not SFTP NotFound.
    assert!(result.is_ok(), "staging failed before sudo: {result:?}");
}

#[tokio::test]
#[ignore = "remote-02 attempt: needs forwarding-enabled fixture"]
async fn trusting_jump_key_must_not_silently_trust_target_key() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    const CHILD: &str = "DUET_REVIEW_SOL_TOFU_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "trusting_jump_key_must_not_silently_trust_target_key",
                "--ignored",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("HOME", dir.path())
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let h = ssh_common::Host::from_env();
    let jump = SshHostEntry {
        alias: "jump".into(),
        hostname: h.host.clone(),
        port: h.port,
        user: h.user.clone(),
        identity_files: vec![h.key.clone().unwrap()],
        proxy_jump: vec![],
    };
    let target = SshHostEntry {
        alias: "target".into(),
        hostname: "127.0.0.1".into(),
        port: 22,
        user: h.user,
        identity_files: vec![h.key.unwrap()],
        proxy_jump: vec!["jump".into()],
    };
    let all = vec![jump, target.clone()];
    assert!(matches!(
        connection::connect(&target, &all, false, false).await,
        Err(DuetError::HostKeyUnverified(_))
    ));
    let retry = connection::connect(&target, &all, true, false).await;
    let contents =
        std::fs::read_to_string(dirs::home_dir().unwrap().join(".ssh/known_hosts")).unwrap();
    eprintln!(
        "retry succeeded={}; recorded nonempty lines={}",
        retry.is_ok(),
        contents.lines().filter(|l| !l.is_empty()).count()
    );
    assert!(
        matches!(retry, Err(DuetError::HostKeyUnverified(_))),
        "target key must receive its own approval"
    );
}
