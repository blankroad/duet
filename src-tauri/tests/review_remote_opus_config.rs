//! review/remote (opus R2) — remote-13 독립 재확인: 현실 빈도 높은 ssh config 구문 3가지.
//! HOME 격리 필수(이 테스트는 `$HOME/.ssh/` 에 config 를 쓴다): HOME=<빈 폴더>.
//! 게이트 없음(네트워크 X). 실행: env HOME=... cargo test --test review_remote_opus_config -- --nocapture

use duet_lib::ssh::config::load_ssh_hosts_from;

fn ssh_dir() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap();
    assert!(
        home.to_string_lossy().contains("_review"),
        "HOME 을 격리하고 실행하라 (현재 {home:?})"
    );
    let d = home.join(".ssh");
    std::fs::create_dir_all(d.join("config.d")).unwrap();
    d
}

fn dump(label: &str, path: &std::path::Path) -> Vec<duet_lib::ssh::config::SshHostEntry> {
    let hosts = load_ssh_hosts_from(path).expect("load");
    for h in &hosts {
        println!(
            "[review] r13 {label}: alias={:?} host={} port={} user={} proxy_jump={:?}",
            h.alias, h.hostname, h.port, h.user, h.proxy_jump
        );
    }
    hosts
}

#[test]
#[ignore = "remote-13 repro: Include / Host a b / Host * ProxyJump (isolated HOME required)"]
fn r13_three_common_forms() {
    let d = ssh_dir();
    std::fs::write(
        d.join("config.d").join("work"),
        "Host inc-host\n  HostName 10.9.9.9\n  User incuser\n",
    )
    .unwrap();
    let cfg = d.join("config");
    std::fs::write(
        &cfg,
        "Include ~/.ssh/config.d/*\n\n\
         Host web1 web2\n  HostName 10.0.0.5\n  User deploy\n\n\
         Host bastion\n  HostName 203.0.113.10\n  User jumper\n\n\
         Host srv\n  HostName 10.1.1.1\n\n\
         Host *\n  ProxyJump bastion\n  User defaultuser\n",
    )
    .unwrap();
    let hosts = dump("cfg", &cfg);
    let get = |a: &str| hosts.iter().find(|h| h.alias == a);
    let mut problems = Vec::new();
    if get("inc-host").is_none() {
        problems
            .push("Include ~/.ssh/config.d/* : 포함 파일에만 있는 Host 가 목록에 없음".to_string());
    }
    if get("web1").is_none() {
        problems.push("Host web1 web2 : web1 없음".to_string());
    }
    if get("web2").is_none() {
        problems.push("Host web1 web2 : 두 번째 alias web2 없음".to_string());
    }
    match get("srv") {
        Some(h) if h.proxy_jump == vec!["bastion".to_string()] => {}
        Some(h) => problems.push(format!(
            "Host * ProxyJump : srv.proxy_jump = {:?} (기대 [\"bastion\"]), user={}",
            h.proxy_jump, h.user
        )),
        None => problems.push("srv 없음".to_string()),
    }
    println!("[review] r13 problems: {problems:#?}");
    assert!(problems.is_empty(), "{problems:#?}");
}
