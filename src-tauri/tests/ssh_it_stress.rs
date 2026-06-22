//! SSH 통합 — MVP-3 큰 파일 / 다수 파일 stress (ROADMAP 미완료 항목).
//!
//! 크기·개수는 env 로 조절. 기본은 가볍게(256MB / 2000개), ROADMAP 의
//! 10GB / 1만개는 명시 opt-in:
//!
//! ```sh
//! DUET_SSH_IT_BYTES=10000000000 DUET_SSH_IT_COUNT=10000 \
//!   bash scripts/ssh-it.sh ssh_it_stress
//! ```
//!
//! 게이트: `DUET_SSH_IT=1` + `#[ignore]`.

mod ssh_common;

use duet_lib::core::ops::{copy_execute, copy_plan, ConflictPolicy};
use duet_lib::fs::SshFs;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[tokio::test]
#[ignore = "docker sshd 필요 + 무거움 — scripts/ssh-it.sh ssh_it_stress"]
async fn stress_large_single_file() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let bytes = env_usize("DUET_SSH_IT_BYTES", 268_435_456); // 256MB
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let base = format!("{home}/it-stress-large");
    let src = format!("{base}/src");
    let dst = format!("{base}/dst");
    ssh_common::run(
        &sess.conn,
        &format!(
            "rm -rf '{base}' && mkdir -p '{src}' '{dst}' && \
             head -c {bytes} /dev/urandom > '{src}/blob'"
        ),
    )
    .await;

    let ssh_fs = SshFs::new(sess.conn.clone());
    let items = vec![ssh_common::entry(sess.source.clone(), &src, "blob")];
    let dst_loc = ssh_common::loc(sess.source.clone(), &dst);
    let plan = copy_plan(&ssh_fs, &ssh_fs, items, dst_loc).await.unwrap();
    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;

    let t0 = Instant::now();
    copy_execute(
        &ssh_fs,
        &ssh_fs,
        plan,
        ConflictPolicy::Replace,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .expect("large file copy failed");
    let elapsed = t0.elapsed();

    let src_hash = ssh_common::sha256_file(&sess.conn, &format!("{src}/blob")).await;
    let dst_hash = ssh_common::sha256_file(&sess.conn, &format!("{dst}/blob")).await;
    assert_eq!(src_hash, dst_hash, "큰 파일 무결성 불일치");

    let mb = bytes as f64 / 1_000_000.0;
    let mbps = mb / elapsed.as_secs_f64().max(0.001);
    eprintln!(
        "[ssh-it] large file: {mb:.0} MB in {:.2}s → {mbps:.1} MB/s (server-side)",
        elapsed.as_secs_f64()
    );
}

#[tokio::test]
#[ignore = "docker sshd 필요 + 무거움 — scripts/ssh-it.sh ssh_it_stress"]
async fn stress_many_small_files() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let count = env_usize("DUET_SSH_IT_COUNT", 2000);
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let base = format!("{home}/it-stress-many");
    let src = format!("{base}/src");
    let dst = format!("{base}/dst");
    // 파일별 고유 내용(echo $i) → 무결성 비교가 의미 있게.
    ssh_common::run(
        &sess.conn,
        &format!(
            "rm -rf '{base}' && mkdir -p '{src}/many' '{dst}' && \
             i=1; while [ $i -le {count} ]; do echo $i > '{src}/many/f'$i; i=$((i+1)); done"
        ),
    )
    .await;

    let ssh_fs = SshFs::new(sess.conn.clone());
    // 디렉토리 'many' 통째로 복사 → dst/many.
    let items = vec![ssh_common::entry(sess.source.clone(), &src, "many")];
    let dst_loc = ssh_common::loc(sess.source.clone(), &dst);
    let plan = copy_plan(&ssh_fs, &ssh_fs, items, dst_loc).await.unwrap();
    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;

    let t0 = Instant::now();
    copy_execute(
        &ssh_fs,
        &ssh_fs,
        plan,
        ConflictPolicy::Replace,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .expect("many files copy failed");
    let elapsed = t0.elapsed();

    let copied =
        ssh_common::stdout_str(&sess.conn, &format!("find '{dst}/many' -type f | wc -l")).await;
    assert_eq!(copied, count.to_string(), "복사된 파일 개수 불일치");

    let src_tree = ssh_common::sha256_tree(&sess.conn, &format!("{src}/many")).await;
    let dst_tree = ssh_common::sha256_tree(&sess.conn, &format!("{dst}/many")).await;
    assert_eq!(src_tree, dst_tree, "다수 파일 트리 무결성 불일치");

    eprintln!(
        "[ssh-it] many files: {count} files in {:.2}s (server-side)",
        elapsed.as_secs_f64()
    );
}
