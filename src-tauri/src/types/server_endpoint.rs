//! Backend-only SSH endpoint identity; deliberately absent from IPC bindings.

use std::net::IpAddr;

/// Resolved target address, configured SSH port and ordered ProxyJump route.
/// Users are omitted: two accounts on the same server can use server-side copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerEndpoint {
    /// Target IP captured when establishing the session.
    pub ip: IpAddr,
    /// Target SSH port, including forwarded/container ports.
    pub port: u16,
    /// Comma-separated ProxyJump aliases; None for direct connections.
    pub via: Option<String>,
}

impl ServerEndpoint {
    /// Capture the target and route without exposing authentication material.
    pub fn new(ip: IpAddr, port: u16, proxy_jump: &[String]) -> Self {
        Self {
            ip,
            port,
            via: if proxy_jump.is_empty() {
                None
            } else {
                Some(proxy_jump.join(","))
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_endpoint_records_port_and_ordered_jump_route() {
        let ip = "127.0.0.1".parse().unwrap();
        let direct = ServerEndpoint::new(ip, 2222, &[]);
        assert_eq!(direct.via, None);
        assert_ne!(direct, ServerEndpoint::new(ip, 2200, &[]));
        let jump = ServerEndpoint::new(ip, 2222, &["outer".into(), "inner".into()]);
        assert_eq!(jump.via.as_deref(), Some("outer,inner"));
        assert_ne!(direct, jump);
        assert_ne!(
            jump,
            ServerEndpoint::new(ip, 2222, &["inner".into(), "outer".into()])
        );
    }
}
