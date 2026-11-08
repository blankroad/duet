//! review/remote (opus R2) — sudo staging(remote-12), 원격 browse 임시폴더 잔존(remote-18),
//! browse 중 끊김(C-13 보충).
//!
//! 내가 만든 컨테이너 `duet-ssh-jump`(2224, 같은 ssh-ssh 이미지)에서 실행: `DUET_SSH_IT_PORT=2224`.
//! C-13 보충 테스트가 그 컨테이너를 `docker pause` 한다(공유 2222 는 건드리지 않음).
//! `--test-threads=1`, HOME 격리.

mod ssh_common;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use duet_lib::core::archive::{open_for_browse, reap_remote_browse_dirs};
use duet_lib::core::elevate::ElevatedOp;
use duet_lib::core::ops::ConflictPolicy;
use duet_lib::core::sudo::execute_sudo;
use duet_lib::fs::{FileSystem, LocalFs, SshFs};

const PAUSABLE: &str = "duet-ssh-jump";

fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// remote-12: 로컬 → 원격 sudo 복사의 staging 업로드. `.duet-sudo` 가 없을 때 매번 실패하나.
#[tokio::test]
#[ignore = "remote-12 repro: sudo staging parent never created (docker sshd)"]
async fn r12_sudo_staging_fails_every_time_without_parent() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let probe = |label: &'static str| {
        let conn = sess.conn.clone();
        let home = home.clone();
        async move {
            let s = ssh_common::stdout_str(
                &conn,
                &format!("if [ -e {0}/.duet-sudo ]; then echo exists; ls -A {0}/.duet-sudo | wc -l; else echo absent; fi", q(&home)),
            )
            .await;
            println!(
                "[review] r12 {label}: ~/.duet-sudo = {}",
                s.replace('\n', " entries=")
            );
        }
    };
    probe("before").await;
    let sudo_present = ssh_common::stdout_str(&sess.conn, "command -v sudo || echo none").await;
    println!("[review] r12 sudo binary on host: {sudo_present}");

    let tmp = tempfile::TempDir::new().unwrap();
    let local_src = tmp.path().join("payload.txt");
    std::fs::write(&local_src, b"to protected dir").unwrap();
    let dst_ssh = SshFs::new(sess.conn.clone());
    for attempt in 1..=2 {
        let items = vec![(
            local_src.clone(),
            Some(Path::new("/etc/review-opus-payload.txt").to_path_buf()),
        )];
        // 앱 경로: commands/fs_ops.rs fs_copy_execute_sudo → execute_sudo(Copy, local, ssh, stage=true, …)
        // 비번 없는 첫 호출은 sudo_probe 실패로 NeedPassword(staging 전) → 사용자가 비번 입력 후 재호출.
        let need = execute_sudo(
            ElevatedOp::Copy,
            &LocalFs::new(),
            &dst_ssh,
            true,
            items.clone(),
            None,
            ConflictPolicy::Skip,
        )
        .await;
        println!(
            "[review] r12 attempt {attempt} (no password): {:?}",
            need.as_ref()
                .map(|o| format!("{o:?}"))
                .map_err(|e| format!("{e:?}"))
        );
        let r = execute_sudo(
            ElevatedOp::Copy,
            &LocalFs::new(),
            &dst_ssh,
            true,
            items,
            Some("whatever"),
            ConflictPolicy::Skip,
        )
        .await;
        println!(
            "[review] r12 attempt {attempt} (with password): {:?}",
            r.as_ref()
                .map(|o| format!("{o:?}"))
                .map_err(|e| format!("{e:?} → toast: \"sudo copy 실패: {e}\""))
        );
        probe(if attempt == 1 {
            "after attempt 1"
        } else {
            "after attempt 2"
        })
        .await;
    }
}

/// remote-18: 원격 압축 browse 2회 → 앱 종료처럼 close 없이 연결이 사라지면 임시 폴더가 남는다.
/// 대조군: close 경로(take_browse_dirs + reap_remote_browse_dirs)는 지운다.
#[tokio::test]
#[ignore = "remote-18 repro: browse temp dirs survive without close (docker sshd)"]
async fn r18_browse_temp_dirs_survive_drop_without_close() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let count_browse = |conn: Arc<duet_lib::services::connection_pool::ActiveConnection>| async move {
        ssh_common::stdout_str(
            &conn,
            "ls -d \"$HOME\"/.duet-tmp/browse-* 2>/dev/null | wc -l",
        )
        .await
    };

    // 준비: 아카이브 + 시작 시점 개수
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let dir = format!("{home}/review-opus-r18");
    ssh_common::run(
        &sess.conn,
        &format!("mkdir -p {0}/src/inner && echo hi > {0}/src/inner/a.txt && head -c 2000000 /dev/urandom > {0}/src/big.bin && tar -czf {0}/pack.tar.gz -C {0} src", q(&dir)),
    )
    .await;
    let before = count_browse(sess.conn.clone()).await;

    // (A) 앱 종료 시뮬레이션 — browse 2회 후 close 없이 세션을 버림
    let mut roots = Vec::new();
    for _ in 0..2 {
        let (loc, _) = open_for_browse(
            ssh_common::entry(sess.source.clone(), &dir, "pack.tar.gz"),
            None,
            &sess.pool,
        )
        .await
        .expect("open_for_browse");
        roots.push(loc.path.parent().unwrap().to_path_buf());
    }
    let du = ssh_common::stdout_str(&sess.conn, "du -sk \"$HOME/.duet-tmp\" | cut -f1").await;
    println!("[review] r18 browse roots: {roots:?}; ~/.duet-tmp size = {du} KB");
    drop(sess); // close 경로(connection_close) 없이 연결이 사라짐 — 앱 종료/비정상 끊김과 같음
    tokio::time::sleep(Duration::from_secs(1)).await;
    let sess2 = ssh_common::connect_password(&host).await;
    let after_drop = count_browse(sess2.conn.clone()).await;
    println!("[review] r18 browse-* dirs: before={before} after browse×2 + drop (new connection) = {after_drop}");

    // (B) 대조군 — connection_close 가 하는 순서 그대로
    let (loc, _) = open_for_browse(
        ssh_common::entry(sess2.source.clone(), &dir, "pack.tar.gz"),
        None,
        &sess2.pool,
    )
    .await
    .unwrap();
    sess2
        .conn
        .track_browse_dir(loc.path.parent().unwrap().to_path_buf())
        .await;
    let with_one_more = count_browse(sess2.conn.clone()).await;
    let tracked = sess2.conn.take_browse_dirs().await;
    reap_remote_browse_dirs(&sess2.pool, &sess2.conn_id, &tracked).await;
    let after_close = count_browse(sess2.conn.clone()).await;
    println!("[review] r18 control (close path): {with_one_more} → {after_close} (only the tracked one reaped; earlier orphans stay)");
    assert_eq!(
        after_drop.trim(),
        before.trim(),
        "browse temp dirs left on server after the app went away"
    );
}

/// C-13 보충: 원격 압축 browse(호스트측 tar 추출) 중 서버가 멈추면.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "remote-05 measure: remote archive browse hang while paused (pausable container)"]
async fn c13_pause_during_remote_browse() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    struct Revive;
    impl Drop for Revive {
        fn drop(&mut self) {
            let _ = std::process::Command::new("docker")
                .args(["unpause", PAUSABLE])
                .output();
        }
    }
    let _r = Revive;
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let dir = format!("{home}/review-opus-c13browse");
    // 압축 풀기에 몇 초 걸리도록 큰 tar.gz
    ssh_common::run(
        &sess.conn,
        &format!("mkdir -p {0}/src && [ -f {0}/big.tar.gz ] || (head -c 400000000 /dev/urandom > {0}/src/big.bin && tar -czf {0}/big.tar.gz -C {0} src)", q(&dir)),
    )
    .await;
    let pool = sess.pool.clone();
    let entry = ssh_common::entry(sess.source.clone(), &dir, "big.tar.gz");
    let t0 = Instant::now();
    let task =
        tokio::spawn(async move { open_for_browse(entry, None, &pool).await.map(|(l, _)| l) });
    tokio::time::sleep(Duration::from_millis(800)).await;
    let st = std::process::Command::new("docker")
        .args(["pause", PAUSABLE])
        .status()
        .unwrap();
    let cut = t0.elapsed();
    println!("[review] c13 browse: paused at {cut:?} ({st})");
    // 같은 연결로 목록 열기도 동시에 (다른 패널에서 폴더 열기)
    let conn = sess.conn.clone();
    let list = tokio::spawn(async move {
        let t = Instant::now();
        let r = SshFs::new(conn).list(Path::new("/")).await;
        (t.elapsed(), r.map(|v| v.len()).map_err(|e| e.to_string()))
    });
    let res = tokio::time::timeout(Duration::from_secs(330), task).await;
    match res {
        Ok(Ok(r)) => println!(
            "[review] c13 browse returned {:?} after cut: {:?}",
            t0.elapsed() - cut,
            r.map_err(|e| format!("{e:?} / Display=\"{e}\""))
        ),
        Ok(Err(e)) => println!("[review] c13 browse task panicked: {e}"),
        Err(_) => println!("[review] c13 browse STILL RUNNING 330s after start"),
    }
    match tokio::time::timeout(Duration::from_secs(330), list).await {
        Ok(Ok((t, r))) => {
            println!("[review] c13 concurrent list on same connection: {t:?} → {r:?}")
        }
        _ => println!("[review] c13 concurrent list did not finish"),
    }
    let _ = std::process::Command::new("docker")
        .args(["unpause", PAUSABLE])
        .status();
    // 서버에 남은 반쯤 풀린 browse 폴더
    tokio::time::sleep(Duration::from_secs(2)).await;
    let s2 = ssh_common::connect_password(&host).await;
    let left = ssh_common::stdout_str(&s2.conn, "ls -d \"$HOME\"/.duet-tmp/browse-* 2>/dev/null | wc -l; du -sk \"$HOME/.duet-tmp\" 2>/dev/null | cut -f1").await;
    println!(
        "[review] c13 after unpause: browse dirs / KB = {}",
        left.replace('\n', " / ")
    );
    let _ = FileSystem::source_id(&SshFs::new(s2.conn.clone()));
}
