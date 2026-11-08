//! review/remote (opus R2) — ProxyJump E2E: 호스트키 승인 범위(remote-02), 대상 비밀번호
//! 폴백이 jump 를 버리는지(remote-14).
//!
//! 픽스처(테스트 전용, 끝나면 제거):
//!   docker network create duet-review-net
//!   docker run -d --name duet-ssh-jump --network duet-review-net -p 127.0.0.1:2224:22 ssh-ssh \
//!       /usr/sbin/sshd -D -e -o AllowTcpForwarding=yes
//!   docker run -d --name duet-ssh-target --network duet-review-net ssh-ssh   (+ 호스트키 재생성 → jump 와 다른 키)
//! 대상(`duet-ssh-target`)은 호스트에서 보이지 않고 jump 를 거쳐야만 닿는다.
//!
//! **HOME 격리 필수**: `connect` 는 `~/.ssh/known_hosts` 를 읽고 쓴다. 이 바이너리는
//! `HOME=<빈 폴더>` 로 실행하고, 각 테스트가 그 known_hosts 를 직접 초기화한다.
//! 게이트: DUET_SSH_IT=1 + DUET_SSH_IT_KEY. `--test-threads=1`.

mod ssh_common;

use std::path::PathBuf;

use duet_lib::ssh::config::{load_ssh_hosts_from, SshHostEntry};
use duet_lib::ssh::connection::{connect, connect_with_password};
use duet_lib::types::DuetError;

fn known_hosts_path() -> PathBuf {
    dirs::home_dir().unwrap().join(".ssh").join("known_hosts")
}

fn reset_known_hosts(content: &str) {
    let p = known_hosts_path();
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, content).unwrap();
}

fn known_hosts_lines() -> Vec<String> {
    std::fs::read_to_string(known_hosts_path())
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let mut it = l.split_whitespace();
            let host = it.next().unwrap_or("");
            let kt = it.next().unwrap_or("");
            let key = it.next().unwrap_or("");
            format!("{host} {kt} …{}", &key[key.len().saturating_sub(12)..])
        })
        .collect()
}

fn hosts() -> (Vec<SshHostEntry>, tempfile::TempDir) {
    let key = std::env::var("DUET_SSH_IT_KEY").expect("DUET_SSH_IT_KEY");
    let dir = tempfile::TempDir::new().unwrap();
    let cfg = dir.path().join("config");
    std::fs::write(
        &cfg,
        format!(
            "Host jump\n  HostName 127.0.0.1\n  Port 2224\n  User duet\n  IdentityFile {key}\n\n\
             Host tgt\n  HostName duet-ssh-target\n  User duet\n  IdentityFile {key}\n  ProxyJump jump\n\n\
             Host tgt-pw\n  HostName duet-ssh-target\n  User alt\n  IdentityFile {key}\n  ProxyJump jump\n"
        ),
    )
    .unwrap();
    let all = load_ssh_hosts_from(&cfg).expect("parse config");
    (all, dir)
}

fn find<'a>(all: &'a [SshHostEntry], alias: &str) -> &'a SshHostEntry {
    all.iter()
        .find(|h| h.alias == alias)
        .unwrap_or_else(|| panic!("alias {alias}"))
}

fn describe(r: &Result<duet_lib::ssh::connection::SshSession, DuetError>) -> String {
    match r {
        Ok(s) => format!("Ok(host_ip={})", s.host_ip),
        Err(DuetError::HostKeyUnverified(i)) => format!(
            "HostKeyUnverified(host={}, fp={}, changed={})",
            i.host, i.fingerprint, i.changed
        ),
        Err(e) => format!("Err({e:?})"),
    }
}

/// remote-02 (TOFU): 처음 보는 jump·대상 — 사용자는 몇 번, 무엇을 보고 승인하나.
#[tokio::test]
#[ignore = "remote-02 repro: one TOFU approval trusts both hops (jump fixture)"]
async fn r02_tofu_one_prompt_trusts_both_hops() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let (all, _d) = hosts();
    let tgt = find(&all, "tgt");
    println!(
        "[review] r02 parsed tgt: host={} port={} user={} proxy_jump={:?}",
        tgt.hostname, tgt.port, tgt.user, tgt.proxy_jump
    );
    reset_known_hosts("");

    // 1) 앱의 첫 시도 (trust=false) → 신뢰 대화상자에 뜨는 정보
    let r1 = connect(tgt, &all, false, false).await;
    println!("[review] r02 step1 connect(trust=false): {}", describe(&r1));
    println!(
        "[review] r02   known_hosts after step1: {:?}",
        known_hosts_lines()
    );

    // 2) 사용자가 그 fingerprint 를 보고 [신뢰] → 앱은 trust=true 로 같은 connect 재호출
    //    (ConnectionDialog.tsx 의 doConnect(true) 와 동일)
    let r2 = connect(tgt, &all, true, false).await;
    println!("[review] r02 step2 connect(trust=true): {}", describe(&r2));
    let lines = known_hosts_lines();
    println!("[review] r02   known_hosts after step2: {lines:?}");
    let has_target = lines.iter().any(|l| l.starts_with("duet-ssh-target "));
    let prompts_shown = matches!(r1, Err(DuetError::HostKeyUnverified(_))) as u32;
    println!("[review] r02   prompts shown to user = {prompts_shown}; target key trusted without its own prompt = {has_target}");
    assert!(r2.is_ok(), "jump E2E must connect: {}", describe(&r2));
    assert!(
        !has_target,
        "대상 호스트키가 사용자에게 보여주지 않은 채 known_hosts 에 기록됨"
    );
}

/// remote-02 (변경 교체): jump·대상 키가 **둘 다** 바뀐 상황에서, 사용자가 본 것은 jump 의
/// 새 fingerprint 하나뿐인데 [교체 승인] 한 번에 대상 키까지 교체되나.
#[tokio::test]
#[ignore = "remote-02 repro: jump key replace also replaces target (jump fixture)"]
async fn r02_replace_approval_for_jump_also_replaces_target() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let (all, _d) = hosts();
    let tgt = find(&all, "tgt");
    // 정상 키를 먼저 배운다 (이 단계는 승인 범위와 무관 — 준비).
    reset_known_hosts("");
    connect(tgt, &all, true, false)
        .await
        .expect("seed known_hosts");
    // 두 호스트 줄을 "옛 키"(다른 유효 ed25519 공개키 = 테스트 키)로 바꿔 '둘 다 변경됨' 상황을 만든다.
    let fake =
        std::fs::read_to_string(format!("{}.pub", std::env::var("DUET_SSH_IT_KEY").unwrap()))
            .unwrap();
    let fake_key = fake.split_whitespace().nth(1).unwrap().to_string();
    let content = std::fs::read_to_string(known_hosts_path()).unwrap();
    let rewritten: String = content
        .lines()
        .map(|l| {
            let mut p: Vec<&str> = l.split_whitespace().collect();
            if p.len() >= 3 && p[1] == "ssh-ed25519" {
                p[2] = &fake_key;
            }
            p.join(" ") + "\n"
        })
        .collect();
    reset_known_hosts(&rewritten);
    println!(
        "[review] r02r known_hosts before (both 'old'): {:?}",
        known_hosts_lines()
    );

    let r1 = connect(tgt, &all, false, false).await;
    println!("[review] r02r step1 connect: {}", describe(&r1));
    // 사용자는 위 (jump) fingerprint 하나를 검증하고 [교체] → replace=true 로 재연결
    let r2 = connect(tgt, &all, false, true).await;
    println!(
        "[review] r02r step2 connect(replace=true): {}",
        describe(&r2)
    );
    let lines = known_hosts_lines();
    println!("[review] r02r known_hosts after: {lines:?}");
    let target_still_old = lines.iter().any(|l| {
        l.starts_with("duet-ssh-target ") && l.ends_with(&fake_key[fake_key.len() - 12..])
    });
    let backups: Vec<_> = std::fs::read_dir(known_hosts_path().parent().unwrap())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != "known_hosts")
        .collect();
    println!("[review] r02r backups in ~/.ssh: {backups:?}");
    assert!(
        target_still_old || r2.is_err(),
        "대상의 변경된 키가 사용자가 본 적 없는데 교체됨 (승인은 jump fingerprint 하나)"
    );
}

/// remote-14: 대상은 비밀번호만 통과(키 거부) — 앱 순서(open_and_register): connect → AuthFailed →
/// connect_with_password(host.hostname, host.port, …) 가 jump 를 버리는지.
#[tokio::test]
#[ignore = "remote-14 repro: password fallback bypasses ProxyJump (jump fixture)"]
async fn r14_password_fallback_drops_proxyjump() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let (all, _d) = hosts();
    let tgt = find(&all, "tgt-pw");
    reset_known_hosts("");
    // 호스트키는 미리 신뢰(이 테스트 관심사 아님)
    let _ = connect(find(&all, "tgt"), &all, true, false).await;

    let r1 = connect(tgt, &all, false, false).await;
    println!(
        "[review] r14 step1 connect(tgt-pw, key/agent): {}",
        describe(&r1)
    );
    assert!(
        matches!(r1, Err(DuetError::AuthFailed)),
        "precondition: key auth must fail for alt"
    );

    // commands/connection.rs open_and_register 의 폴백과 같은 호출
    let r2 =
        connect_with_password(&tgt.hostname, tgt.port, &tgt.user, "altpass", false, false).await;
    println!(
        "[review] r14 step2 password fallback (as app does): {}",
        describe(&r2)
    );
    assert!(
        r2.is_ok(),
        "jump 뒤 대상의 비밀번호 접속이 실패 — 폴백이 jump 를 버리고 직접 {}:{} 로 감",
        tgt.hostname,
        tgt.port
    );
}
