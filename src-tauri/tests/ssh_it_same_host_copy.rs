//! SSH 통합 — MVP-3 same-host copy 핵심 경로.
//!
//! 실제 sshd 위에서 `copy_plan` → `copy_execute(SshSameHost)` 를 구동해
//! 서버사이드 rsync/cp 복사, 충돌 backup, hard-error 정책을 검증한다.
//!
//! 게이트: `DUET_SSH_IT=1` + `#[ignore]`. 실행은 `scripts/ssh-it.sh`.

mod ssh_common;

use duet_lib::core::copy_strategy::CopyStrategy;
use duet_lib::core::ops::{copy_execute, copy_plan};
use duet_lib::fs::SshFs;
use duet_lib::services::journal::UndoAction;
use duet_lib::types::DuetError;
use tokio_util::sync::CancellationToken;

/// src/dst 디렉토리 준비 + 무작위 src 파일 생성. (base, src_dir, dst_dir) 반환.
async fn seed(sess: &ssh_common::Session, sub: &str, bytes: usize) -> (String, String, String) {
    let home = ssh_common::home(&sess.conn).await;
    let base = format!("{home}/it-copy-{sub}");
    let src = format!("{base}/src");
    let dst = format!("{base}/dst");
    ssh_common::run(
        &sess.conn,
        &format!(
            "rm -rf '{base}' && mkdir -p '{src}' '{dst}' && \
             head -c {bytes} /dev/urandom > '{src}/big.bin'"
        ),
    )
    .await;
    (base, src, dst)
}

#[tokio::test]
#[ignore = "docker sshd 필요 — scripts/ssh-it.sh"]
async fn same_host_copy_rsync_integrity() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let (_base, src, dst) = seed(&sess, "rsync", 5_000_000).await;

    let ssh_fs = SshFs::new(sess.conn.clone());
    let items = vec![ssh_common::entry(sess.source.clone(), &src, "big.bin")];
    let dst_loc = ssh_common::loc(sess.source.clone(), &dst);

    // decide() 실경로 — 같은 connection 양쪽이라 SshSameHost.
    let plan = copy_plan(&ssh_fs, &ssh_fs, items, dst_loc).await.unwrap();
    assert_eq!(plan.strategy, CopyStrategy::SshSameHost);

    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    copy_execute(&ssh_fs, &ssh_fs, plan, &ctx, CancellationToken::new(), None)
        .await
        .expect("same-host rsync copy failed");

    let src_hash = ssh_common::sha256_file(&sess.conn, &format!("{src}/big.bin")).await;
    let dst_hash = ssh_common::sha256_file(&sess.conn, &format!("{dst}/big.bin")).await;
    assert_eq!(src_hash, dst_hash, "복사본 무결성 불일치 (rsync)");
}

#[tokio::test]
#[ignore = "docker sshd 필요 — scripts/ssh-it.sh"]
async fn same_host_copy_cp_fallback_integrity() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let (_base, src, dst) = seed(&sess, "cp", 3_000_000).await;

    // rsync 가 설치돼 있어도 cp fallback 분기를 강제 — 캐시를 Some(false) 로.
    *sess.conn.rsync_available.lock().await = Some(false);

    let ssh_fs = SshFs::new(sess.conn.clone());
    let items = vec![ssh_common::entry(sess.source.clone(), &src, "big.bin")];
    let dst_loc = ssh_common::loc(sess.source.clone(), &dst);
    let plan = copy_plan(&ssh_fs, &ssh_fs, items, dst_loc).await.unwrap();

    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    copy_execute(&ssh_fs, &ssh_fs, plan, &ctx, CancellationToken::new(), None)
        .await
        .expect("same-host cp fallback copy failed");

    let src_hash = ssh_common::sha256_file(&sess.conn, &format!("{src}/big.bin")).await;
    let dst_hash = ssh_common::sha256_file(&sess.conn, &format!("{dst}/big.bin")).await;
    assert_eq!(src_hash, dst_hash, "복사본 무결성 불일치 (cp)");
}

#[tokio::test]
#[ignore = "docker sshd 필요 — scripts/ssh-it.sh"]
async fn same_host_copy_conflict_creates_backup() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let (_base, src, dst) = seed(&sess, "conflict", 1_000_000).await;
    // dst 에 동명 파일 미리 — 충돌 유발.
    ssh_common::run(&sess.conn, &format!("echo OLD > '{dst}/big.bin'")).await;

    let ssh_fs = SshFs::new(sess.conn.clone());
    let items = vec![ssh_common::entry(sess.source.clone(), &src, "big.bin")];
    let dst_loc = ssh_common::loc(sess.source.clone(), &dst);
    let plan = copy_plan(&ssh_fs, &ssh_fs, items, dst_loc).await.unwrap();

    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    let entry = copy_execute(&ssh_fs, &ssh_fs, plan, &ctx, CancellationToken::new(), None)
        .await
        .expect("conflict copy failed");

    // 기존 dst 파일이 .bak.<ts> 로 백업됨 (MVP-2 일관).
    let bak_count = ssh_common::stdout_str(
        &sess.conn,
        &format!("ls -1 '{dst}'/big.bin.bak.* 2>/dev/null | wc -l"),
    )
    .await;
    assert_eq!(bak_count, "1", "충돌 backup 파일이 없음");

    // journal 에 UndoCopy + backups_to_restore 기록.
    match entry.undo {
        UndoAction::UndoCopy {
            backups_to_restore, ..
        } => assert_eq!(backups_to_restore.len(), 1, "backup 기록 누락"),
        other => panic!("expected UndoCopy, got {other:?}"),
    }

    // 새 복사본은 src 와 동일.
    let src_hash = ssh_common::sha256_file(&sess.conn, &format!("{src}/big.bin")).await;
    let dst_hash = ssh_common::sha256_file(&sess.conn, &format!("{dst}/big.bin")).await;
    assert_eq!(src_hash, dst_hash);
}

#[tokio::test]
#[ignore = "docker sshd 필요 — scripts/ssh-it.sh"]
async fn same_host_copy_failure_is_hard_error() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let base = format!("{home}/it-copy-fail");
    let src = format!("{base}/src");
    // dst 를 쓰기 불가 디렉토리로 — rsync/cp 가 실패해야 함.
    let dst = format!("{base}/ro");
    ssh_common::run(
        &sess.conn,
        &format!(
            "rm -rf '{base}' && mkdir -p '{src}' '{dst}' && \
             head -c 100000 /dev/urandom > '{src}/big.bin' && chmod 500 '{dst}'"
        ),
    )
    .await;

    let ssh_fs = SshFs::new(sess.conn.clone());
    let items = vec![ssh_common::entry(sess.source.clone(), &src, "big.bin")];
    let dst_loc = ssh_common::loc(sess.source.clone(), &dst);
    let plan = copy_plan(&ssh_fs, &ssh_fs, items, dst_loc).await.unwrap();

    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    let res = copy_execute(&ssh_fs, &ssh_fs, plan, &ctx, CancellationToken::new(), None).await;

    // silent relay 가 아니라 명시적 에러여야 한다 (CLAUDE.md DON'T).
    assert!(
        matches!(res, Err(DuetError::Ssh(_))),
        "expected hard DuetError::Ssh, got {res:?}"
    );
}
