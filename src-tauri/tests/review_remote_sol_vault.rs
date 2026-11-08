//! Remote R1 vault checks: isolated paths, no application state or real credentials.
use duet_lib::services::secret_vault::SecretVault;

#[tokio::test]
async fn corrupted_empty_and_locked_vaults_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v.age");
    for bytes in [b"".as_slice(), b"broken age file".as_slice()] {
        tokio::fs::write(&path, bytes).await.unwrap();
        let vault = SecretVault::load_from(&path).await.unwrap();
        assert!(vault.unlock("test-only".into()).await.is_err());
        assert!(!vault.is_unlocked().await);
        assert!(!vault.has("a").await);
        assert!(vault.set("a".into(), "test-only".into()).await.is_err());
    }
}

#[tokio::test]
async fn first_creation_encrypts_and_sets_private_unix_permissions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v.age");
    let vault = SecretVault::load_from(&path).await.unwrap();
    vault.unlock("test-master".into()).await.unwrap();
    vault
        .set("a".into(), "test-plaintext-marker".into())
        .await
        .unwrap();
    assert!(
        !String::from_utf8_lossy(&std::fs::read(&path).unwrap()).contains("test-plaintext-marker")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    vault.lock().await;
    assert!(!vault.has("a").await);
    assert!(vault.unlock("wrong-master".into()).await.is_err());
    vault.unlock("test-master".into()).await.unwrap();
    assert!(vault.has("a").await);
    vault.remove("a").await.unwrap();
    vault.lock().await;
    vault.unlock("test-master".into()).await.unwrap();
    assert!(!vault.has("a").await);
}

#[tokio::test]
#[ignore = "remote-21 repro: concurrent vault flushes share tmp path"]
async fn concurrent_sets_all_persist_without_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v.age");
    let vault = SecretVault::load_from(&path).await.unwrap();
    vault.unlock("test-master".into()).await.unwrap();
    let (a, b, c) = tokio::join!(
        vault.set("a".into(), "one".into()),
        vault.set("b".into(), "two".into()),
        vault.set("c".into(), "three".into())
    );
    eprintln!("concurrent results: a={a:?}, b={b:?}, c={c:?}");
    assert!(a.is_ok() && b.is_ok() && c.is_ok());
    let reload = SecretVault::load_from(&path).await.unwrap();
    reload.unlock("test-master".into()).await.unwrap();
    for key in ["a", "b", "c"] {
        assert!(reload.has(key).await, "lost {key}");
    }
}

#[tokio::test]
#[ignore = "remote-22 repro: failed persistence still updates memory"]
async fn failed_set_must_not_claim_secret_was_saved() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = dir.path().join("not-a-directory");
    std::fs::write(&blocked, "block").unwrap();
    let vault = SecretVault::load_from(&blocked.join("v.age"))
        .await
        .unwrap();
    vault.unlock("test-master".into()).await.unwrap();
    assert!(vault.set("a".into(), "test-only".into()).await.is_err());
    assert!(
        !vault.has("a").await,
        "failed write must not advertise persisted password"
    );
}
