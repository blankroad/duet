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
    fs.rename(Path::new(&file), Path::new(&renamed))
        .await
        .unwrap();
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
    assert!(
        fs.metadata(Path::new(&victim)).await.is_err(),
        "원본이 남아있음"
    );
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

/// 비어있지 않은 디렉토리 trash → restore. 자식(중첩 포함)까지 통째로 이동/원복되는지.
/// (원격 폴더 삭제가 파일과 달리 실패하던 회귀 방지 — child 경로 POSIX 결합 §7.)
#[tokio::test]
#[ignore = "docker sshd 필요 — scripts/ssh-it.sh"]
async fn sftp_trash_dir_then_restore() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let base = format!("{home}/it-trash-dir");
    ssh_common::run(
        &sess.conn,
        &format!("rm -rf '{base}' '{home}/.duet-trash' && mkdir -p '{base}'"),
    )
    .await;

    let fs = SshFs::new(sess.conn.clone());
    // 중첩 디렉토리 + 파일 트리.
    let dir = format!("{base}/victim-dir");
    fs.mkdir(Path::new(&dir)).await.unwrap();
    fs.mkdir(Path::new(&format!("{dir}/nested"))).await.unwrap();
    fs.write_full(Path::new(&format!("{dir}/a.txt")), b"a")
        .await
        .unwrap();
    fs.write_full(Path::new(&format!("{dir}/nested/b.txt")), b"b")
        .await
        .unwrap();

    // trash → 디렉토리 통째로 이동, 원본 사라짐.
    let batch = new_batch_id();
    let trash_loc = fs.trash(Path::new(&dir), &batch).await.unwrap();
    assert!(
        fs.metadata(Path::new(&dir)).await.is_err(),
        "원본 디렉토리가 남아있음"
    );
    let trash_files = ssh_common::stdout_str(
        &sess.conn,
        &format!("find '{home}/.duet-trash' -type f | wc -l"),
    )
    .await;
    assert_eq!(trash_files, "2", "휴지통에 자식 파일 2개가 없음");

    // restore → 디렉토리 + 자식 원복.
    fs.restore_from_trash(&trash_loc, Path::new(&dir))
        .await
        .unwrap();
    assert_eq!(
        fs.read_full(Path::new(&format!("{dir}/a.txt")))
            .await
            .unwrap(),
        b"a"
    );
    assert_eq!(
        fs.read_full(Path::new(&format!("{dir}/nested/b.txt")))
            .await
            .unwrap(),
        b"b"
    );
}

/// 비어있지 않은 디렉토리 영구삭제(`remove` = `remove_recursive`). 자식 경로를 POSIX 로
/// 결합해 재귀 삭제하는지 — native `Path::join` 회귀 시 자식이 안 지워져 실패해야 한다.
#[tokio::test]
#[ignore = "docker sshd 필요 — scripts/ssh-it.sh"]
async fn sftp_remove_dir_recursive() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let base = format!("{home}/it-rmdir");
    ssh_common::run(&sess.conn, &format!("rm -rf '{base}' && mkdir -p '{base}'")).await;

    let fs = SshFs::new(sess.conn.clone());
    let dir = format!("{base}/tree");
    fs.mkdir(Path::new(&dir)).await.unwrap();
    fs.mkdir(Path::new(&format!("{dir}/sub"))).await.unwrap();
    fs.write_full(Path::new(&format!("{dir}/x.txt")), b"x")
        .await
        .unwrap();
    fs.write_full(Path::new(&format!("{dir}/sub/y.txt")), b"y")
        .await
        .unwrap();

    fs.remove(Path::new(&dir)).await.unwrap();
    assert!(
        fs.metadata(Path::new(&dir)).await.is_err(),
        "디렉토리가 안 지워짐"
    );
}
