//! rsync `--info=progress2` 출력 파서.
//!
//! 출력 형식 (rsync 3.x):
//!   `   42,123,456  17%   12.34MB/s    0:01:23 (xfr#5, ir-chk=0/100)`
//!   `  235,000,000 100%   15.42MB/s    0:00:00 (xfr#1, to-chk=0/1)`
//!
//! 잡음 라인 (xfr#, to-chk 등 만, 빈 줄, summary) 은 None 반환 — caller 가
//! 무시. 형식 변경 시 silent skip 으로 robust (copy 자체는 진행).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub bytes_done: u64,
    /// percent (0..=100)
    pub percent: u8,
    /// 초당 bytes — `12.34MB/s` 같은 단위 변환됨
    pub speed_bps: u64,
    /// remaining seconds — `0:01:23` → 83
    pub eta_sec: u32,
}

/// 한 라인을 파싱. 매칭 안 되면 None.
pub fn parse_rsync_progress2_line(line: &str) -> Option<Progress> {
    // line 에서 '\r' 캐리지 리턴 제거 (rsync 가 같은 줄 update 시 \r 사용)
    let line = line.trim_end_matches(['\r', '\n']).trim();
    if line.is_empty() {
        return None;
    }

    // 공백으로 나눔. 최소 4 토큰 필요: bytes, percent, speed, eta.
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.len() < 4 {
        return None;
    }

    let bytes_done = parse_bytes_with_commas(tokens[0])?;
    let percent: u8 = tokens[1].strip_suffix('%').and_then(|s| s.parse().ok())?;
    if percent > 100 {
        return None;
    }
    let speed_bps = parse_speed(tokens[2])?;
    let eta_sec = parse_eta(tokens[3])?;

    Some(Progress {
        bytes_done,
        percent,
        speed_bps,
        eta_sec,
    })
}

fn parse_bytes_with_commas(s: &str) -> Option<u64> {
    s.replace(',', "").parse().ok()
}

/// `12.34MB/s` → 12_340_000 (bytes per second).
fn parse_speed(s: &str) -> Option<u64> {
    let s = s.strip_suffix("/s")?;
    let (num, unit_factor) = if let Some(rest) = s.strip_suffix("GB") {
        (rest, 1_000_000_000.0)
    } else if let Some(rest) = s.strip_suffix("MB") {
        (rest, 1_000_000.0)
    } else if let Some(rest) = s.strip_suffix("kB") {
        (rest, 1_000.0)
    } else if let Some(rest) = s.strip_suffix('B') {
        (rest, 1.0)
    } else {
        return None;
    };
    let n: f64 = num.parse().ok()?;
    if !n.is_finite() || n < 0.0 {
        return None;
    }
    Some((n * unit_factor) as u64)
}

/// `0:01:23` → 83 초. `1:23:45` → 5025.
fn parse_eta(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: u32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    let sec: u32 = parts[2].parse().ok()?;
    Some(h * 3600 + m * 60 + sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_typical_line() {
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
    fn parse_complete_line() {
        let p = parse_rsync_progress2_line(
            "  235,000,000 100%   15.42MB/s    0:00:00 (xfr#1, to-chk=0/1)",
        )
        .unwrap();
        assert_eq!(p.percent, 100);
        assert_eq!(p.eta_sec, 0);
    }

    #[test]
    fn parse_kb_speed() {
        let p = parse_rsync_progress2_line("       1,024  10%   500.00kB/s    0:00:05").unwrap();
        assert_eq!(p.speed_bps, 500_000);
    }

    #[test]
    fn parse_gb_speed() {
        let p = parse_rsync_progress2_line("10,000,000,000  50%   1.50GB/s    1:00:00 (xfr#1)")
            .unwrap();
        assert_eq!(p.speed_bps, 1_500_000_000);
        assert_eq!(p.eta_sec, 3600);
    }

    #[test]
    fn carriage_return_stripped() {
        let p = parse_rsync_progress2_line("   100  50%   10.0MB/s    0:00:01\r").unwrap();
        assert_eq!(p.bytes_done, 100);
    }

    #[test]
    fn empty_line_returns_none() {
        assert!(parse_rsync_progress2_line("").is_none());
        assert!(parse_rsync_progress2_line("   ").is_none());
    }

    #[test]
    fn summary_line_returns_none() {
        // rsync 마지막 summary 류
        assert!(parse_rsync_progress2_line("sent 1,234 bytes  received 56 bytes").is_none());
    }

    #[test]
    fn xfr_only_line_returns_none() {
        // 일부 환경에서 xfr#/ir-chk 만 있는 짧은 라인
        assert!(parse_rsync_progress2_line("(xfr#5, ir-chk=0/100)").is_none());
    }

    #[test]
    fn malformed_speed_returns_none() {
        assert!(parse_rsync_progress2_line("100  50%  fastlol  0:01:23").is_none());
    }

    #[test]
    fn malformed_eta_returns_none() {
        assert!(parse_rsync_progress2_line("100  50%   10MB/s   not-a-time").is_none());
    }

    #[test]
    fn out_of_range_percent_returns_none() {
        // u8 자체는 0-255 허용 — 명시 100 초과 reject
        assert!(parse_rsync_progress2_line("100  200%   1.0MB/s   0:00:01").is_none());
        assert!(parse_rsync_progress2_line("100  255%   1.0MB/s   0:00:01").is_none());
    }

    #[test]
    fn negative_speed_returns_none() {
        // 정상 rsync 출력에 -1.0MB/s 는 안 나오지만, 방어 코드 검증
        assert!(parse_rsync_progress2_line("100  50%   -1.0MB/s   0:00:01").is_none());
    }

    #[test]
    fn parse_b_speed() {
        // 'B' 단위 (slow transfer) — 기존 kB/MB/GB 와 함께 모든 unit 커버
        let p = parse_rsync_progress2_line("512  10%   256B/s   0:00:10").unwrap();
        assert_eq!(p.speed_bps, 256);
    }
}
