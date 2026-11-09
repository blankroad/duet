//! review/remote (opus R1) — 연결이 중간에 끊길 때(C-13), 연결 풀 종료/경합(C-12),
//! 자동 재연결이 보는 신호(`Handle::is_closed`, C-11) 실측.
//!
//! **전용 chaos 컨테이너 필요**: `docker run -d --name duet-ssh-chaos -p 127.0.0.1:2223:22 ssh-ssh`
//! 실행: `DUET_SSH_IT=1 DUET_SSH_IT_PORT=2223 cargo test --test review_remote_opus_chaos -- --ignored --nocapture --test-threads=1`
//! 테스트가 `docker pause/unpause/stop/start duet-ssh-chaos` 를 부른다(테스트 하니스 — §9 는 앱 코드 대상).
//! 모든 대기는 `tokio::time::timeout` 으로 상한을 둔다 — "얼마나 멈추는지"를 재기 위함.

mod ssh_common;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use duet_lib::core::ops::{copy_execute, copy_plan, ConflictPolicy};
use duet_lib::core::search::{SearchBackend, SearchOpts, SshFilenameSearch};
use duet_lib::fs::{FileSystem, LocalFs, SshFs};
use duet_lib::services::connection_pool::ActiveConnection;
use duet_lib::types::SourceId;
use tokio_util::sync::CancellationToken;

const CHAOS: &str = "duet-ssh-chaos";
/// 한 작업이 멈춰 있는지 판단하는 상한. keepalive(15s×3)+inactivity(300s) 를 넘겨 본다.
const CAP: Duration = Duration::from_secs(330);

fn docker(args: &[&str]) {
    let out = std::process::Command::new("docker")
        .args(args)
        .output()
        .expect("docker");
    println!(
        "[review] docker {} -> {}{}",
        args.join(" "),
        out.status,
        String::from_utf8_lossy(&out.stderr).trim()
    );
}

/// 테스트가 어떻게 끝나든 컨테이너를 다시 살려 둔다.
struct Revive;
impl Drop for Revive {
    fn drop(&mut self) {
        let _ = std::process::Command::new("docker")
            .args(["unpause", CHAOS])
            .output();
        let _ = std::process::Command::new("docker")
            .args(["start", CHAOS])
            .output();
    }
}

async fn wait_ssh_ready(host: &ssh_common::Host) {
    for _ in 0..60 {
        if tokio::net::TcpStream::connect((host.host.as_str(), host.port))
            .await
            .is_ok()
            && duet_lib::ssh::connection::connect_with_password(
                &host.host, host.port, &host.user, &host.pass, true, false,
            )
            .await
            .is_ok()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("chaos container not ready");
}

/// 1초마다 `is_closed()` 를 본다 (supervisor 가 5초마다 보는 그 신호). 처음 true 가 된 시각 반환.
fn watch_closed(
    conn: Arc<ActiveConnection>,
    t0: Instant,
) -> tokio::task::JoinHandle<Option<Duration>> {
    tokio::spawn(async move {
        loop {
            // supervisor 와 같은 방식: 세션 Mutex 를 잡고 확인. 잡는 데 걸린 시간도 기록.
            let lock_t = Instant::now();
            let closed = {
                let h = conn.session.as_ref().unwrap().lock().await;
                h.is_closed()
            };
            let waited = lock_t.elapsed();
            if waited > Duration::from_secs(2) {
                println!("[review]   is_closed() check waited {waited:?} for session mutex");
            }
            if closed {
                return Some(t0.elapsed());
            }
            if t0.elapsed() > CAP {
                return None;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
}

async fn seed_big(sess: &ssh_common::Session, mb: u32) -> String {
    let home = ssh_common::home(&sess.conn).await;
    let dir = format!("{home}/review-opus-chaos");
    ssh_common::run(
        &sess.conn,
        &format!("mkdir -p '{dir}' && [ -f '{dir}/big.bin' ] || head -c {}000000 /dev/urandom > '{dir}/big.bin'", mb),
    )
    .await;
    dir
}

fn fmt<T>(r: &Result<T, duet_lib::types::DuetError>) -> String {
    match r {
        Ok(_) => "Ok".into(),
        Err(e) => format!("Err({e:?})"),
    }
}

/// 원격 → 로컬 relay 복사 중 끊김. `action` = "pause" | "stop".
async fn relay_copy_interrupted(action: &str) {
    let _revive = Revive;
    let host = ssh_common::Host::from_env();
    wait_ssh_ready(&host).await;
    let sess = ssh_common::connect_password(&host).await;
    let dir = seed_big(&sess, 800).await;
    let ssh_fs = SshFs::new(sess.conn.clone());
    let local = LocalFs::new();
    let tmp = tempfile::TempDir::new().unwrap();
    let plan = copy_plan(
        &ssh_fs,
        &local,
        vec![ssh_common::entry(sess.source.clone(), &dir, "big.bin")],
        ssh_common::loc(SourceId::Local, tmp.path()),
    )
    .await
    .unwrap();
    println!(
        "[review] c13 relay({action}) strategy={:?} total={}",
        plan.strategy, plan.total_size_bytes
    );
    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    let t0 = Instant::now();
    let watcher = watch_closed(sess.conn.clone(), t0);
    let cancel = CancellationToken::new();
    let copy = {
        let cancel = cancel.clone();
        tokio::spawn(async move {
            let ssh_fs = SshFs::new(sess.conn.clone());
            let r = copy_execute(
                &ssh_fs,
                &LocalFs::new(),
                plan,
                ConflictPolicy::Replace,
                &ctx,
                cancel,
                None,
            )
            .await;
            (r.map(|_| ()), sess)
        })
    };
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let part_before = dir_bytes(tmp.path());
    docker(&[action, CHAOS]);
    let t_cut = t0.elapsed();
    println!("[review] c13 relay({action}) cut at {t_cut:?}, local bytes so far {part_before}");
    let res = tokio::time::timeout(CAP, copy).await;
    match res {
        Ok(Ok((r, sess))) => {
            println!(
                "[review] c13 relay({action}) copy_execute returned after {:?} (since cut {:?}): {}",
                t0.elapsed(),
                t0.elapsed() - t_cut,
                fmt(&r)
            );
            println!(
                "[review] c13 relay({action}) local dir after: {:?}",
                list_local(tmp.path())
            );
            let closed_at = tokio::time::timeout(CAP, watcher)
                .await
                .ok()
                .and_then(|r| r.ok())
                .flatten();
            println!("[review] c13 relay({action}) Handle::is_closed() became true at {closed_at:?} (cut at {t_cut:?})");
            // (d) 끊긴 같은 ActiveConnection 으로 다음 작업
            if action == "pause" {
                docker(&["unpause", CHAOS]);
            } else {
                docker(&["start", CHAOS]);
                wait_ssh_ready(&host).await;
            }
            let t = Instant::now();
            let fs = SshFs::new(sess.conn.clone());
            let next =
                tokio::time::timeout(Duration::from_secs(60), fs.list(Path::new(&dir))).await;
            println!(
                "[review] c13 relay({action}) next list on SAME connection after recovery: {:?} in {:?}",
                next.as_ref().map(fmt),
                t.elapsed()
            );
        }
        Ok(Err(join)) => println!("[review] c13 relay({action}) task panicked: {join}"),
        Err(_) => {
            println!("[review] c13 relay({action}) copy STILL RUNNING after {CAP:?} — hang");
            cancel.cancel();
            panic!("relay copy hang on {action}");
        }
    }
}

fn dir_bytes(p: &Path) -> u64 {
    std::fs::read_dir(p)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

fn list_local(p: &Path) -> Vec<(String, u64)> {
    std::fs::read_dir(p)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| {
                    (
                        e.file_name().to_string_lossy().into_owned(),
                        e.metadata().map(|m| m.len()).unwrap_or(0),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "remote-23 measure: relay copy during server pause (chaos container)"]
async fn c13a_pause_during_relay_copy() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    relay_copy_interrupted("pause").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "remote-23 measure: relay copy during server stop (chaos container)"]
async fn c13a_stop_during_relay_copy() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    relay_copy_interrupted("stop").await;
}

/// (b) list / (c) exec·검색 이 응답 없는 피어(pause)에서 얼마나 멈추나.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "remote-05 measure: list/exec/search hang while server paused (chaos container)"]
async fn c13bc_pause_during_list_exec_search() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let _revive = Revive;
    let host = ssh_common::Host::from_env();
    wait_ssh_ready(&host).await;
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    // 각 작업은 별도 연결로 — 하나의 세션 Mutex 에 서로 줄 서는 효과를 배제.
    let s_list = ssh_common::connect_password(&host).await;
    let s_exec = ssh_common::connect_password(&host).await;
    let s_search = ssh_common::connect_password(&host).await;
    let t0 = Instant::now();
    let watcher = watch_closed(s_list.conn.clone(), t0);
    docker(&["pause", CHAOS]);

    let h_list = {
        let conn = s_list.conn.clone();
        let home = home.clone();
        tokio::spawn(async move {
            let t = Instant::now();
            let r = tokio::time::timeout(CAP, SshFs::new(conn).list(Path::new(&home))).await;
            (t.elapsed(), r.map(|r| fmt(&r)))
        })
    };
    let h_exec = {
        let conn = s_exec.conn.clone();
        tokio::spawn(async move {
            let t = Instant::now();
            let r = tokio::time::timeout(CAP, SshFs::new(conn).exec_raw("echo hi")).await;
            (t.elapsed(), r.map(|r| fmt(&r)))
        })
    };
    let h_search = {
        let conn = s_search.conn.clone();
        let home = home.clone();
        tokio::spawn(async move {
            let t = Instant::now();
            let b = SshFilenameSearch { conn };
            let r = tokio::time::timeout(
                CAP,
                b.search(
                    Path::new(&home),
                    "x",
                    &SearchOpts {
                        max_results: 10,
                        ..SearchOpts::default()
                    },
                    CancellationToken::new(),
                ),
            )
            .await;
            (t.elapsed(), r.map(|r| fmt(&r)))
        })
    };
    let (tl, rl) = h_list.await.unwrap();
    let (te, re) = h_exec.await.unwrap();
    let (ts, rs) = h_search.await.unwrap();
    println!("[review] c13b list during pause: {tl:?} -> {rl:?}");
    println!("[review] c13c exec during pause: {te:?} -> {re:?}");
    println!("[review] c13c search during pause: {ts:?} -> {rs:?}");
    let closed_at = watcher.await.unwrap();
    println!("[review] c13 is_closed() (list conn) became true at {closed_at:?}");
    docker(&["unpause", CHAOS]);
}

/// 긴 exec(같은 호스트 cp/rsync, 검색 find 와 같은 경로)가 세션 Mutex 를 쥔 동안
/// 같은 연결의 다른 작업(목록, supervisor 확인, 종료)이 얼마나 기다리나.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "remote-07 measure: long exec blocks same-connection list (chaos container)"]
async fn c13_long_exec_blocks_other_ops_on_same_connection() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let _revive = Revive;
    let host = ssh_common::Host::from_env();
    wait_ssh_ready(&host).await;
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let fs = Arc::new(SshFs::new(sess.conn.clone()));
    // 기준: 아무 것도 안 할 때 list
    let t = Instant::now();
    fs.list(Path::new(&home)).await.unwrap();
    let base = t.elapsed();

    // 8초 걸리는 원격 명령 (예: 큰 폴더 cp, find /)
    let long = {
        let fs = fs.clone();
        tokio::spawn(async move { fs.exec_raw("sleep 8").await.map(|o| o.exit_status) })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t = Instant::now();
    let r = fs.list(Path::new(&home)).await;
    let during = t.elapsed();
    let t = Instant::now();
    let closed = {
        let h = sess.conn.session.as_ref().unwrap().lock().await;
        h.is_closed()
    };
    let lock_wait = t.elapsed();
    let _ = long.await;
    println!(
        "[review] c13 list baseline {base:?}; list while an 8s exec runs on same connection: {during:?} ({}); session-mutex wait after: {lock_wait:?} closed={closed}",
        fmt(&r)
    );

    // 검색(find) 이 도는 동안 취소 → 언제 돌아오나 (취소는 exec 전/후에만 확인)
    ssh_common::run(&sess.conn, "mkdir -p \"$HOME/review-opus-slowfind\"").await;
    let cancel = CancellationToken::new();
    let search = {
        let conn = sess.conn.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            let b = SshFilenameSearch { conn };
            let t = Instant::now();
            // root 이름에 `$(sleep 6)` 같은 걸 넣을 수 없으니 넓은 범위 find 로: 루트 `/`
            let r = b
                .search(
                    Path::new("/"),
                    "zzzz-nope",
                    &SearchOpts {
                        max_results: 10,
                        include_hidden: true,
                        ..SearchOpts::default()
                    },
                    cancel,
                )
                .await;
            (t.elapsed(), fmt(&r))
        })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    cancel.cancel();
    let (ts, rs) = search.await.unwrap();
    println!("[review] c21 search '/' cancelled at 200ms -> returned after {ts:?}: {rs}");
}

/// C-12: 진행 중 relay 복사가 있을 때 사용자가 연결을 닫으면(=connection_close 와 같은
/// 순서: pool.remove + disconnect) 복사는 어떻게 끝나나. 그리고 긴 exec 이 있으면 close 자체가
/// 얼마나 기다리나.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "remote-07 measure: close waits for in-flight exec (chaos container)"]
async fn c12_close_with_inflight_ops() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let _revive = Revive;
    let host = ssh_common::Host::from_env();
    wait_ssh_ready(&host).await;

    // (1) 긴 exec 진행 중 close — connection_close 는 세션 Mutex 를 잡아야 disconnect 한다.
    let sess = ssh_common::connect_password(&host).await;
    let fs = Arc::new(SshFs::new(sess.conn.clone()));
    let long = {
        let fs = fs.clone();
        tokio::spawn(async move { fs.exec_raw("sleep 10").await.map(|o| o.exit_status) })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t = Instant::now();
    {
        let h = sess.conn.session.as_ref().unwrap().lock().await;
        let _ = h
            .disconnect(russh::Disconnect::ByApplication, "user closed", "")
            .await;
    }
    sess.pool.remove(&sess.conn_id).await;
    println!(
        "[review] c12 close (lock+disconnect) while 10s exec in flight took {:?}",
        t.elapsed()
    );
    println!(
        "[review] c12   in-flight exec result: {:?}",
        long.await.unwrap()
    );
    let r = SshFs::new(sess.conn.clone()).list(Path::new("/")).await;
    println!(
        "[review] c12 op on closed connection (stale Arc): {}",
        fmt(&r)
    );
    let r = sess.pool.get(&sess.conn_id).await;
    println!("[review] c12 pool.get after close: {}", fmt(&r));

    // (2) relay 복사 진행 중 close
    let sess = ssh_common::connect_password(&host).await;
    let dir = seed_big(&sess, 800).await;
    let tmp = tempfile::TempDir::new().unwrap();
    let ssh_fs = SshFs::new(sess.conn.clone());
    let plan = copy_plan(
        &ssh_fs,
        &LocalFs::new(),
        vec![ssh_common::entry(sess.source.clone(), &dir, "big.bin")],
        ssh_common::loc(SourceId::Local, tmp.path()),
    )
    .await
    .unwrap();
    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    let conn = sess.conn.clone();
    let copy = tokio::spawn(async move {
        let t = Instant::now();
        let r = copy_execute(
            &SshFs::new(conn),
            &LocalFs::new(),
            plan,
            ConflictPolicy::Replace,
            &ctx,
            CancellationToken::new(),
            None,
        )
        .await;
        (t.elapsed(), r.map(|_| ()))
    });
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let t = Instant::now();
    {
        let h = sess.conn.session.as_ref().unwrap().lock().await;
        let _ = h
            .disconnect(russh::Disconnect::ByApplication, "user closed", "")
            .await;
    }
    sess.pool.remove(&sess.conn_id).await;
    println!(
        "[review] c12 close during relay copy took {:?}",
        t.elapsed()
    );
    match tokio::time::timeout(Duration::from_secs(120), copy).await {
        Ok(Ok((el, r))) => println!(
            "[review] c12   relay copy ended after {el:?}: {}; local: {:?}",
            fmt(&r),
            list_local(tmp.path())
        ),
        Ok(Err(e)) => println!("[review] c12   copy task panicked {e}"),
        Err(_) => println!("[review] c12   relay copy STILL RUNNING 120s after close"),
    }
}

/// C-11/C-10: 재연결(supervisor 의 `connect`, 배너의 connection_open) 이 응답 없는 호스트에
/// 얼마나 매달리나. `connect` 경로엔 TCP/핸드셰이크 타임아웃이 없다(ssh/connection.rs 349·413·481·666).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "remote-06 measure: connect has no deadline (chaos container)"]
async fn c11_connect_to_unresponsive_host_duration() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let _revive = Revive;
    let host = ssh_common::Host::from_env();
    wait_ssh_ready(&host).await;

    // (1) 멈춘 호스트 (TCP 는 붙지만 SSH 배너가 안 옴)
    docker(&["pause", CHAOS]);
    let t = Instant::now();
    let r = tokio::time::timeout(
        CAP,
        duet_lib::ssh::connection::connect_with_password(
            &host.host, host.port, &host.user, &host.pass, false, false,
        ),
    )
    .await;
    println!(
        "[review] c11 connect to PAUSED host: {:?} after {:?}",
        r.as_ref().map(fmt),
        t.elapsed()
    );
    docker(&["unpause", CHAOS]);

    // (2) 라우팅 안 되는 주소 (TEST-NET-1, RFC 5737) — SYN 이 버려지는 네트워크 단절 흉내
    let t = Instant::now();
    let r = tokio::time::timeout(
        Duration::from_secs(150),
        duet_lib::ssh::connection::connect_with_password("192.0.2.1", 22, "u", "p", false, false),
    )
    .await;
    println!(
        "[review] c11 connect to blackholed 192.0.2.1:22: {:?} after {:?}",
        r.as_ref().map(fmt),
        t.elapsed()
    );
}
