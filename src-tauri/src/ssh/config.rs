//! `~/.ssh/config` 파싱 — Host 엔트리 + 호스트별 옵션.
//!
//! `ssh2-config` crate 위에 얇은 래퍼. 와일드카드만(`Host *`) 패턴은 sidebar 표시
//! 대상이 아니므로 skip — 그건 다른 호스트들의 default 적용용.
//!
//! ## ProxyJump 주의사항
//!
//! `ssh2-config` 0.4 는 `ProxyJump` 를 `UnsupportedField` 로 취급하므로
//! `HostParams` 에 직접 필드가 없다. `ALLOW_UNSUPPORTED_FIELDS` 플래그로 파싱하면
//! `host.params.unsupported_fields["ProxyJump"]` 에 raw 문자열로 보관된다.
//! `query()` 는 unsupported_fields 를 merge 하지 않으므로, 호스트 고유 값만 읽는다
//! (wildcard `Host *` ProxyJump 전파는 현재 지원 안 함 — Task 5 시 재검토).

use crate::types::DuetError;
use std::path::{Path, PathBuf};

/// `~/.ssh/config` 의 Host 엔트리 한 개의 해석된 형태.
#[derive(Debug, Clone)]
pub struct SshHostEntry {
    /// `Host` 라인의 패턴 — 사이드바에 이 이름으로 표시.
    pub alias: String,
    /// 실제 연결할 호스트 (Hostname 옵션, 없으면 alias).
    pub hostname: String,
    /// 포트 (기본 22).
    pub port: u16,
    /// 사용자 (User 옵션, 없으면 현재 OS 사용자).
    pub user: String,
    /// IdentityFile 경로 목록.
    pub identity_files: Vec<PathBuf>,
    /// ProxyJump alias 목록 (e.g. ["bastion"]; 빈 배열이면 직접 연결).
    ///
    /// `ssh2-config` 0.4 가 ProxyJump 를 unsupported_fields 에 보관하므로
    /// 쉼표/공백 구분 raw 값을 파싱해서 채운다.
    pub proxy_jump: Vec<String>,
}

/// `~/.ssh/config` 를 읽어서 Host 엔트리 목록 반환.
/// 파일이 없으면 빈 Vec (에러 아님).
pub fn load_ssh_hosts() -> Result<Vec<SshHostEntry>, DuetError> {
    let home = dirs::home_dir().ok_or_else(|| DuetError::Io("home directory not found".into()))?;
    let path = home.join(".ssh").join("config");
    if !path.exists() {
        return Ok(Vec::new());
    }
    load_ssh_hosts_from(&path)
}

/// 명시된 경로의 ssh config 를 파싱. 테스트용 + 향후 사용자 지정 경로 지원용.
pub fn load_ssh_hosts_from(path: &Path) -> Result<Vec<SshHostEntry>, DuetError> {
    let file = std::fs::File::open(path).map_err(DuetError::from)?;
    let mut reader = std::io::BufReader::new(file);

    // ALLOW_UNSUPPORTED_FIELDS: ProxyJump 등을 unsupported_fields 맵에 보관.
    // ALLOW_UNKNOWN_FIELDS: 사용자 config 에 비표준 옵션이 있어도 실패하지 않음.
    let parse_rule = ssh2_config::ParseRule::ALLOW_UNKNOWN_FIELDS
        | ssh2_config::ParseRule::ALLOW_UNSUPPORTED_FIELDS;

    let config = ssh2_config::SshConfig::default()
        .parse(&mut reader, parse_rule)
        .map_err(|e| DuetError::Io(format!("ssh config parse: {e}")))?;

    let current_user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".to_string());

    let mut entries = Vec::new();

    for host in config.get_hosts() {
        // 와일드카드 전용 패턴(`Host *`, `Host *.example.com` 등)은 skip.
        // 실제 연결 대상이 아니라 다른 호스트들에 대한 default 설정용이기 때문.
        let is_real_host = host
            .pattern
            .iter()
            .any(|clause| !clause.pattern.contains('*') && !clause.pattern.contains('?'));
        if !is_real_host {
            continue;
        }

        // 첫 번째 비-와일드카드 패턴을 alias 로 사용.
        let alias = host
            .pattern
            .iter()
            .find(|clause| !clause.pattern.contains('*') && !clause.pattern.contains('?'))
            .map(|clause| clause.pattern.clone())
            .unwrap_or_default();

        if alias.is_empty() {
            continue;
        }

        // query() 로 와일드카드 Host * 의 default 값까지 merge된 결과를 얻는다.
        let params = config.query(&alias);

        let hostname = params.host_name.clone().unwrap_or_else(|| alias.clone());
        let port = params.port.unwrap_or(22);
        let user = params.user.clone().unwrap_or_else(|| current_user.clone());
        let identity_files = params.identity_file.clone().unwrap_or_default();

        // ProxyJump: unsupported_fields 에서 직접 읽음.
        // query() 가 unsupported_fields 를 merge 하지 않으므로 host.params 에서 읽어야 함.
        // ProxyJump 값은 "host1,host2" 또는 "host1 host2" 형식 가능.
        let proxy_jump = host
            .params
            .unsupported_fields
            .get("ProxyJump")
            .map(|args| {
                args.iter()
                    .flat_map(|s| s.split([',', ' ']))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        entries.push(SshHostEntry {
            alias,
            hostname,
            port,
            user,
            identity_files,
            proxy_jump,
        });
    }

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_config(content: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f.flush().unwrap();
        f
    }

    #[test]
    fn empty_config_returns_empty() {
        let f = write_config("");
        let hosts = load_ssh_hosts_from(f.path()).unwrap();
        assert!(hosts.is_empty());
    }

    #[test]
    fn parses_hostname_port_user() {
        let f = write_config("Host myserver\n  Hostname 192.168.1.10\n  Port 2222\n  User admin\n");
        let hosts = load_ssh_hosts_from(f.path()).unwrap();
        assert_eq!(hosts.len(), 1);
        let h = &hosts[0];
        assert_eq!(h.alias, "myserver");
        assert_eq!(h.hostname, "192.168.1.10");
        assert_eq!(h.port, 2222);
        assert_eq!(h.user, "admin");
    }

    #[test]
    fn skips_wildcard_only_patterns() {
        let f = write_config(
            "Host *\n  User defaultuser\n\nHost real-host\n  Hostname real.example.com\n",
        );
        let hosts = load_ssh_hosts_from(f.path()).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "real-host");
        // wildcard 의 default 적용 — `User defaultuser` 가 real-host 에 적용되어야 함
        assert_eq!(hosts[0].user, "defaultuser");
    }

    #[test]
    fn missing_user_falls_back_to_current() {
        let f = write_config("Host noauth\n  Hostname x.example.com\n");
        let hosts = load_ssh_hosts_from(f.path()).unwrap();
        assert_eq!(hosts.len(), 1);
        // current_user 가 채워져야 함 (테스트 환경의 $USER/$USERNAME 또는 fallback "root")
        assert!(!hosts[0].user.is_empty());
    }
}
