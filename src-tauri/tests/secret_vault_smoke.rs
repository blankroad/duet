//! Secret vault smoke — full lifecycle end-to-end.

use duet_lib::services::secret_vault::SecretVault;
use tempfile::tempdir;

#[tokio::test]
async fn smoke_full_lifecycle() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("vault.age");

    // 신규 — exists false, unlock 시 빈 맵
    let v = SecretVault::load_from(&path).await.unwrap();
    assert!(!v.exists().await);
    assert!(!v.is_unlocked().await);
    v.unlock("masterPW123".into()).await.unwrap();
    assert!(v.is_unlocked().await);

    // set 2개 → 자동 flush
    v.set("ssh-prod".into(), "p@ss-prod".into()).await.unwrap();
    v.set("ssh-dev".into(), "p@ss-dev".into()).await.unwrap();
    assert!(v.exists().await);

    // 같은 process 에서 read
    assert_eq!(
        v.get("ssh-prod").await.unwrap().as_deref(),
        Some("p@ss-prod")
    );

    // lock → 메모리 clear
    v.lock().await;
    assert!(!v.is_unlocked().await);
    assert!(v.get("ssh-prod").await.is_err());

    // 다른 process 시뮬레이션 — 새 store 로 재로드
    let v2 = SecretVault::load_from(&path).await.unwrap();
    assert!(v2.exists().await);
    assert!(!v2.is_unlocked().await);
    // 잘못된 master
    assert!(v2.unlock("wrong".into()).await.is_err());
    // 올바른 master
    v2.unlock("masterPW123".into()).await.unwrap();
    assert_eq!(
        v2.get("ssh-prod").await.unwrap().as_deref(),
        Some("p@ss-prod")
    );
    assert_eq!(
        v2.get("ssh-dev").await.unwrap().as_deref(),
        Some("p@ss-dev")
    );

    // remove + reload 검증
    v2.remove("ssh-dev").await.unwrap();
    let v3 = SecretVault::load_from(&path).await.unwrap();
    v3.unlock("masterPW123".into()).await.unwrap();
    assert!(v3.get("ssh-dev").await.unwrap().is_none());
    assert_eq!(
        v3.get("ssh-prod").await.unwrap().as_deref(),
        Some("p@ss-prod")
    );
}
