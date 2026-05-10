//! MVP-3 smoke tests — strategy 결정 + rsync progress 파서.
//!
//! 실제 SSH↔SSH 통합 검증은 docker compose 후속.

use duet_lib::core::copy_progress::parse_rsync_progress2_line;
use duet_lib::core::copy_strategy::{decide, shell_escape_path, CopyStrategy};
use duet_lib::types::{ConnectionId, SourceId};
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;

fn ssh(ip: [u8; 4], user: &str) -> SourceId {
    SourceId::Ssh {
        connection_id: ConnectionId(format!("{user}@{ip:?}")),
        host_ip: IpAddr::V4(Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3])),
        user: user.into(),
    }
}

#[test]
fn smoke_strategy_matrix() {
    // 6 combinations
    assert_eq!(
        decide(&SourceId::Local, &SourceId::Local),
        CopyStrategy::LocalToLocal
    );
    assert_eq!(
        decide(&SourceId::Local, &ssh([10, 0, 0, 1], "u")),
        CopyStrategy::Relay
    );
    assert_eq!(
        decide(&ssh([10, 0, 0, 1], "u"), &SourceId::Local),
        CopyStrategy::Relay
    );
    assert_eq!(
        decide(&ssh([10, 0, 0, 1], "u"), &ssh([10, 0, 0, 1], "u")),
        CopyStrategy::SshSameHost
    );
    assert_eq!(
        decide(&ssh([10, 0, 0, 1], "alice"), &ssh([10, 0, 0, 1], "bob")),
        CopyStrategy::SshSameHost
    );
    assert_eq!(
        decide(&ssh([10, 0, 0, 1], "u"), &ssh([10, 0, 0, 2], "u")),
        CopyStrategy::Relay
    );
}

#[test]
fn smoke_progress_parser_typical() {
    let p = parse_rsync_progress2_line(
        "   42,123,456  17%   12.34MB/s    0:01:23 (xfr#5, ir-chk=0/100)",
    )
    .unwrap();
    assert_eq!(p.bytes_done, 42_123_456);
    assert_eq!(p.percent, 17);
    assert_eq!(p.speed_bps, 12_340_000);
    assert_eq!(p.eta_sec, 83);
}

#[test]
fn smoke_progress_parser_complete() {
    let p =
        parse_rsync_progress2_line("  235,000,000 100%   15.42MB/s    0:00:00 (xfr#1, to-chk=0/1)")
            .unwrap();
    assert_eq!(p.percent, 100);
}

#[test]
fn smoke_progress_parser_silent_skip_on_summary() {
    assert!(parse_rsync_progress2_line("sent 1,234 bytes  received 56 bytes").is_none());
    assert!(parse_rsync_progress2_line("").is_none());
    assert!(parse_rsync_progress2_line("(xfr#5, ir-chk=0/100)").is_none());
}

#[test]
fn smoke_shell_escape_special_chars() {
    assert_eq!(
        shell_escape_path(Path::new("/home/user/foo bar")).unwrap(),
        "'/home/user/foo bar'"
    );
    assert_eq!(
        shell_escape_path(Path::new("/home/u/it's a test")).unwrap(),
        "'/home/u/it'\\''s a test'"
    );
    assert!(shell_escape_path(&std::path::PathBuf::from("/x/\0bad")).is_err());
}
