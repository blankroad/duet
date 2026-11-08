//! Remote R1: config parsing through the public loader, with temporary files only.
use duet_lib::ssh::config::{load_ssh_hosts_from, SshHostEntry};
use std::path::PathBuf;

fn parse(text: &str) -> Vec<SshHostEntry> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config");
    std::fs::write(&path, text).unwrap();
    load_ssh_hosts_from(&path).unwrap()
}

#[test]
fn crlf_lowercase_and_common_defaults() {
    let hosts = parse("host app\r\n hostname server\r\nHost *\r\n User alice\r\n Port 2200\r\n IdentityFile ~/review-key\r\n");
    assert_eq!(hosts.len(), 1);
    assert_eq!(hosts[0].hostname, "server");
    assert_eq!(hosts[0].user, "alice");
    assert_eq!(hosts[0].port, 2200);
    assert_eq!(
        hosts[0].identity_files,
        vec![dirs::home_dir().unwrap().join("review-key")]
    );
}

#[test]
fn defaults_must_not_override_earlier_specific_values() {
    let hosts = parse("Host app\n HostName server\n User specific\n Port 2200\n IdentityFile /tmp/review-explicit\nHost *\n User fallback\n Port 22\n IdentityFile /tmp/review-default\n");
    eprintln!("resolved host={:?}", hosts[0]);
    assert_eq!(hosts[0].user, "specific");
    assert_eq!(hosts[0].port, 2200);
    assert!(hosts[0]
        .identity_files
        .contains(&PathBuf::from("/tmp/review-explicit")));
}

#[test]
#[ignore = "remote-13 repro: Host * ProxyJump not inherited"]
fn inherits_proxyjump_default() {
    let hosts = parse("Host app\n HostName internal\nHost *\n ProxyJump bastion\n");
    assert_eq!(hosts[0].proxy_jump, vec!["bastion"]);
}

#[test]
#[ignore = "remote-13 repro: ProxyJump none treated as alias"]
fn proxyjump_none_disables_jump() {
    let hosts = parse("Host app\n ProxyJump none\n");
    assert!(hosts[0].proxy_jump.is_empty());
}

#[test]
#[ignore = "remote-13 repro: Host a b exposes only first alias"]
fn exposes_both_literal_aliases() {
    let hosts = parse("Host a b\n HostName server\n");
    assert_eq!(
        hosts.iter().map(|h| h.alias.as_str()).collect::<Vec<_>>(),
        vec!["a", "b"]
    );
}

#[test]
#[ignore = "remote-13 repro: negated pattern becomes a host"]
fn negated_clause_is_not_a_host() {
    let hosts = parse("Host !excluded *\n User common\nHost app\n HostName server\n");
    assert!(!hosts.iter().any(|h| h.alias == "excluded"));
}

#[test]
#[ignore = "remote-13 repro: IdentityFile %d/%h/%r not expanded"]
fn expands_identity_tokens() {
    let hosts = parse("Host app\n HostName server\n User alice\n IdentityFile %d/keys/%h-%r\n");
    assert_eq!(
        hosts[0].identity_files,
        vec![dirs::home_dir().unwrap().join("keys/server-alice")]
    );
}

#[test]
#[ignore = "remote-13 repro: quoted values are split"]
fn quoted_identity_with_spaces() {
    let hosts = parse("Host app\n IdentityFile \"/tmp/review key\"\n");
    assert_eq!(
        hosts[0].identity_files,
        vec![PathBuf::from("/tmp/review key")]
    );
}

#[test]
#[ignore = "remote-13 repro: Match leaks into preceding host"]
fn match_does_not_change_nonmatching_host() {
    let hosts = parse("Host app\n HostName server\nMatch host other\n User otheruser\n");
    assert_ne!(hosts[0].user, "otheruser");
}

#[test]
#[ignore = "remote-13 repro: hosts defined only in Include are missing"]
fn absolute_glob_include_imports_host_entries() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("one.inc"),
        "Host included\n HostName server\n",
    )
    .unwrap();
    let path = dir.path().join("config");
    std::fs::write(&path, format!("Include {}/*.inc\n", dir.path().display())).unwrap();
    let hosts = load_ssh_hosts_from(&path).unwrap();
    assert!(
        hosts.iter().any(|h| h.alias == "included"),
        "hosts={hosts:?}"
    );
}

#[test]
#[cfg(unix)] // Subprocess HOME isolation is not valid for Windows profile resolution.
#[ignore = "remote-13 repro: relative Include resolved against cwd"]
fn relative_include_updates_matching_host() {
    const CHILD: &str = "DUET_REVIEW_SOL_INCLUDE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "relative_include_updates_matching_host",
                "--ignored",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("HOME", dir.path())
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let ssh = dirs::home_dir().unwrap().join(".ssh");
    std::fs::create_dir_all(&ssh).unwrap();
    std::fs::write(ssh.join("opts.inc"), "Host app\n User includeduser\n").unwrap();
    let path = ssh.join("config");
    std::fs::write(&path, "Host app\n Include opts.inc\n").unwrap();
    let hosts = load_ssh_hosts_from(&path).unwrap();
    assert_eq!(hosts[0].user, "includeduser");
}

#[test]
fn absolute_include_can_update_existing_host_options() {
    let dir = tempfile::tempdir().unwrap();
    let inc = dir.path().join("opts");
    std::fs::write(&inc, "Host app\n User includeduser\n").unwrap();
    let path = dir.path().join("config");
    std::fs::write(&path, format!("Host app\n Include {}\n", inc.display())).unwrap();
    let hosts = load_ssh_hosts_from(&path).unwrap();
    assert_eq!(hosts[0].user, "includeduser");
}
