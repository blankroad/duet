//! SSH 통합 — `SshFs` (실제 SFTP 채널) CRUD + 휴지통 라운드트립.
//!
//! 게이트: `DUET_SSH_IT=1` + `#[ignore]`. 실행은 `scripts/ssh-it.sh`.

mod ssh_common;

use duet_lib::fs::{FileSystem, SshFs};
use duet_lib::services::trash::new_batch_id;
use duet_lib::types::EntryKind;
use std::path::Path;

#[tokio::test]
#[ignore = "docker sshd 필요 — scripts/ssh-it.sh"]
async fn sftp_crud_roundtrip() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let base = format!("{home}/it-sftp");
    ssh_common::run(&sess.conn, &format!("rm -rf '{base}' && mkdir -p '{base}'")).await;

    let fs = SshFs::new(sess.conn.clone());

    // mkdir → list/metadata
    let sub = format!("{base}/sub");
    fs.mkdir(Path::new(&sub)).await.unwrap();
    let meta = fs.metadata(Path::new(&sub)).await.unwrap();
    assert_eq!(meta.kind, EntryKind::Dir);

    // write_full → read_full 바이트 라운드트립
    let file = format!("{base}/hello.bin");
    let payload = b"duet-sftp-roundtrip\x00\x01\xfe\xff".to_vec();
    fs.write_full(Path::new(&file), &payload).await.unwrap();
    let read = fs.read_full(Path::new(&file)).await.unwrap();
    assert_eq!(read, payload);

    let entries = fs.list(Path::new(&base)).await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"sub"));
    assert!(names.contains(&"hello.bin"));

    // rename
    let renamed = format!("{base}/hello-renamed.bin");
    fs.rename(Path::new(&file), Path::new(&renamed)).await.unwrap();
    assert!(fs.metadata(Path::new(&file)).await.is_err());
    assert!(fs.metadata(Path::new(&renamed)).await.is_ok());
}

#[tokio::test]
#[ignore = "docker sshd 필요 — scripts/ssh-it.sh"]
async fn sftp_trash_then_restore() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let base = format!("{home}/it-trash");
    // 이전 잔재 + 휴지통 정리.
    ssh_common::run(
        &sess.conn,
        &format!("rm -rf '{base}' '{home}/.duet-trash' && mkdir -p '{base}'"),
    )
    .await;

    let fs = SshFs::new(sess.conn.clone());
    let victim = format!("{base}/victim.txt");
    fs.write_full(Path::new(&victim), b"bye").await.unwrap();

    // trash → ~/.duet-trash/<batch>/... 로 이동, 원본 사라짐
    let batch = new_batch_id();
    let trash_loc = fs.trash(Path::new(&victim), &batch).await.unwrap();
    assert!(fs.metadata(Path::new(&victim)).await.is_err(), "원본이 남아있음");
    let trash_count = ssh_common::stdout_str(
        &sess.conn,
        &format!("find '{home}/.duet-trash' -type f | wc -l"),
    )
    .await;
    assert_eq!(trash_count, "1", "휴지통에 파일이 없음");

    // restore_from_trash 로 원복
    fs.restore_from_trash(&trash_loc, Path::new(&victim))
        .await
        .unwrap();
    let restored = fs.read_full(Path::new(&victim)).await.unwrap();
    assert_eq!(restored, b"bye");
}
