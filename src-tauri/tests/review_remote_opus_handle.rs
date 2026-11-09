//! review/remote (opus R2) — remote-05/06/07 수정 설계 근거: russh 0.46 `client::Handle` 을
//! `Mutex` 없이 `Arc` 로 공유할 수 있는가.
//! - 컴파일 확인: `Handle<HostKeyVerifier>: Send + Sync` (아래 assert 가 컴파일되면 참).
//! - 실행 확인: `Arc<Handle>` 하나로 긴 exec 와 SFTP 목록을 **동시에** — 목록이 기다리지 않는가.
//!
//! 게이트: DUET_SSH_IT=1 (실행 테스트만). `DUET_SSH_IT_PORT` 는 내 컨테이너(2224) 권장.

mod ssh_common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use duet_lib::ssh::connection::{connect_with_password, HostKeyVerifier};
use russh::client::Handle;

#[test]
fn handle_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Handle<HostKeyVerifier>>();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "remote-05/07 design evidence: Handle shared without Mutex (docker sshd)"]
async fn shared_handle_without_mutex_runs_concurrently() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let s = connect_with_password(&host.host, host.port, &host.user, &host.pass, true, false)
        .await
        .unwrap();
    let handle = Arc::new(s.handle);
    let h1 = handle.clone();
    let long = tokio::spawn(async move {
        duet_lib::ssh::remote_exec::exec(&h1, "sleep 5; echo done")
            .await
            .map(|o| o.exit_status)
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t = Instant::now();
    // SshFs::open_sftp 와 같은 단계: channel_open_session(&self) → sftp subsystem → read_dir
    let ch = handle.channel_open_session().await.unwrap();
    ch.request_subsystem(true, "sftp").await.unwrap();
    let sftp = russh_sftp::client::SftpSession::new(ch.into_stream())
        .await
        .unwrap();
    let n = sftp.read_dir("/").await.unwrap().count();
    let el = t.elapsed();
    let long_r = long.await.unwrap();
    println!("[review] handle: list '/' ({n} entries) while a 5s exec runs on the SAME handle (no Mutex): {el:?}; exec = {long_r:?}");
    assert!(
        el < Duration::from_secs(2),
        "list waited for the exec: {el:?}"
    );
    // 응답 없는 서버 대비: channel open 에 타임아웃을 거는 것도 &self 라 그대로 가능.
    let r = tokio::time::timeout(Duration::from_secs(10), handle.channel_open_session()).await;
    println!(
        "[review] handle: timeout(10s, channel_open_session) on healthy server → ok={}",
        matches!(r, Ok(Ok(_)))
    );
}
