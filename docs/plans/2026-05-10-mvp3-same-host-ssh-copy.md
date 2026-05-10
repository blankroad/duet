# MVP-3 Implementation Plan: 같은 호스트 SSH 복사 최적화

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 같은 SSH 호스트 안 SSH↔SSH 복사가 본인 PC를 거치지 않고 서버에서 직접 일어남 (rsync/cp exec). TC 대비 핵심 차별점.

**Architecture:** 새 모듈 4개 (core/copy_strategy, core/copy_progress, ssh/remote_exec, services/progress_events) + core/ops.rs::copy_execute 분기 + ProgressModal 확장. rsync 우선, cp -a fallback. 충돌 시 SFTP rename `.bak.<ts>` (MVP-2 일관). 실패 시 hard error (silent relay 절대 X — CLAUDE.md DON'T).

**Tech Stack:** Rust (russh exec channel for SSH command execution, 이미 deps), `--info=progress2` 라인 파싱 (정규식 또는 split), tokio (line-buffered async stream). Frontend (zustand 5, radix-ui — 이미 있음).

**Spec reference:** `docs/specs/2026-05-10-mvp3-same-host-ssh-copy-design.md`

**현재 상태 (MVP-2 완료):**
- ✅ MVP-2: 파괴적 작업 + undo (60 cargo + 21 vitest passed)
- ✅ MVP-1 보강: ad-hoc connect, password 인증
- ⚠ same-host SSH copy 는 현재 `NotSupported(MVP-3)` 명시 차단 (core/ops.rs::copy_plan)

**완료 조건 (ROADMAP MVP-3 일치):**
- `CopyStrategy` 결정 로직 (Local/Relay/SshSameHost)
- 같은 호스트 감지 (`host_ip` 일치, user 달라도 OK)
- SSH exec 채널로 rsync/cp 실행 — silent relay 절대 안 함
- rsync `--info=progress2` 진행률 파싱 + ProgressEvent emit + ProgressModal 확장
- 충돌은 MVP-2 와 동일 자동 backup
- backend `copy_strategy`/`copy_progress`/`remote_exec` 단위 테스트 통과
- 큰 파일/다수 파일 stress (10GB+, 1만개) 는 docker compose 후속 (MVP-3 범위 외)

---

## 작업 흐름 가이드

각 Task = 독립 커밋. **TDD**: 새 모듈 (copy_strategy, copy_progress, remote_exec) 은 테스트 먼저. 프론트는 컴포넌트 spot-check 만.

**커밋 메시지 scope:**
- `be/core` core/copy_strategy, core/copy_progress, core/ops 분기
- `be/ssh` ssh/remote_exec
- `be/svc` services/progress_events, ActiveConnection 캐시
- `be/cmd` (필요 시) commands 변경
- `fe/store` ui-dialogs progress 필드
- `fe/hook` useProgressEvents
- `fe/ui` ProgressModal, App CopyOrMovePlanBody
- `docs` ROADMAP

**의존성 추가**: 없음 (rsync/cp 는 원격 binary, 새 crate 불필요).

---

## Phase A: Foundation (parser + strategy + event)

### Task 1: core/copy_strategy.rs

**Files:**
- Create: `src-tauri/src/core/copy_strategy.rs`
- Modify: `src-tauri/src/core/mod.rs`

**Why:** MVP-3 의 핵심 결정 로직. ARCHITECTURE.md 의 인라인 plan_copy 코드를 모듈로 분리. shell escape 도 같은 모듈에 (도메인 — copy 명령 인자 안전화).

- [ ] **Step 1: core/mod.rs 등록**

`src-tauri/src/core/mod.rs`:

```rust
//! 도메인 로직. OS / 프로토콜 독립.

pub mod copy_progress;
pub mod copy_strategy;
pub mod ops;
pub mod undo;
```

(copy_progress 는 다음 task. ops, undo 는 기존.)

- [ ] **Step 2: copy_strategy.rs 작성 — 테스트 먼저**

```rust
//! 복사 전략 결정 + path shell escape.
//!
//! `decide(src, dst)` 로 strategy 분기 결정. UI/CopyPlan 에 포함되어
//! 사용자에게 "어떤 경로로 복사할지" 미리 표시.
//!
//! `shell_escape_path` 는 SSH exec 명령 인자에 path 안전 임베딩
//! (CLAUDE.md §7).

use crate::types::{DuetError, SourceId};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

/// 복사 전략. UI 에 표시 + backend 분기 결정.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CopyStrategy {
    /// 로컬 ↔ 로컬 (tokio::fs::copy).
    LocalToLocal,
    /// local↔ssh 또는 ssh↔ssh different-host — 본인 PC 거쳐 stream.
    Relay,
    /// 같은 SSH 호스트 (host_ip 일치) — 서버에서 cp/rsync exec.
    SshSameHost,
}

/// SourceId 쌍으로 strategy 결정.
pub fn decide(src: &SourceId, dst: &SourceId) -> CopyStrategy {
    match (src, dst) {
        (SourceId::Local, SourceId::Local) => CopyStrategy::LocalToLocal,
        (
            SourceId::Ssh { host_ip: a, .. },
            SourceId::Ssh { host_ip: b, .. },
        ) if a == b => CopyStrategy::SshSameHost,
        _ => CopyStrategy::Relay,
    }
}

/// POSIX shell single-quote escape — exec 명령 인자 안전화.
///
/// path 를 `'...'` 로 감싸고, 안에 있는 `'` 는 `'\''` 로.
/// `\0` (null byte) 가 path 에 있으면 거부 (POSIX 도 허용 안 함).
///
/// 예: `/home/u/it's a test` → `'/home/u/it'\''s a test'`
pub fn shell_escape_path(p: &Path) -> Result<String, DuetError> {
    let s = p
        .to_str()
        .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;
    if s.contains('\0') {
        return Err(DuetError::Io("path contains NUL byte".into()));
    }
    let escaped = s.replace('\'', "'\\''");
    Ok(format!("'{escaped}'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ConnectionId;
    use std::net::{IpAddr, Ipv4Addr};

    fn ssh(ip: [u8; 4], user: &str, conn_id: &str) -> SourceId {
        SourceId::Ssh {
            connection_id: ConnectionId(conn_id.into()),
            host_ip: IpAddr::V4(Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3])),
            user: user.into(),
        }
    }

    #[test]
    fn decide_local_to_local() {
        assert_eq!(
            decide(&SourceId::Local, &SourceId::Local),
            CopyStrategy::LocalToLocal
        );
    }

    #[test]
    fn decide_local_to_ssh_is_relay() {
        let dst = ssh([10, 0, 0, 1], "u", "a");
        assert_eq!(decide(&SourceId::Local, &dst), CopyStrategy::Relay);
    }

    #[test]
    fn decide_ssh_to_local_is_relay() {
        let src = ssh([10, 0, 0, 1], "u", "a");
        assert_eq!(decide(&src, &SourceId::Local), CopyStrategy::Relay);
    }

    #[test]
    fn decide_ssh_same_host_same_user() {
        let src = ssh([10, 0, 0, 1], "u", "a");
        let dst = ssh([10, 0, 0, 1], "u", "b");
        assert_eq!(decide(&src, &dst), CopyStrategy::SshSameHost);
    }

    #[test]
    fn decide_ssh_same_host_different_user() {
        let src = ssh([10, 0, 0, 1], "alice", "a");
        let dst = ssh([10, 0, 0, 1], "bob", "b");
        assert_eq!(decide(&src, &dst), CopyStrategy::SshSameHost);
    }

    #[test]
    fn decide_ssh_different_host_is_relay() {
        let src = ssh([10, 0, 0, 1], "u", "a");
        let dst = ssh([10, 0, 0, 2], "u", "b");
        assert_eq!(decide(&src, &dst), CopyStrategy::Relay);
    }

    #[test]
    fn escape_simple_path() {
        assert_eq!(
            shell_escape_path(Path::new("/home/user/file.txt")).unwrap(),
            "'/home/user/file.txt'"
        );
    }

    #[test]
    fn escape_path_with_single_quote() {
        assert_eq!(
            shell_escape_path(Path::new("/home/u/it's a test")).unwrap(),
            "'/home/u/it'\\''s a test'"
        );
    }

    #[test]
    fn escape_path_with_space() {
        assert_eq!(
            shell_escape_path(Path::new("/tmp/foo bar")).unwrap(),
            "'/tmp/foo bar'"
        );
    }

    #[test]
    fn escape_path_with_null_byte_rejected() {
        let p = std::path::PathBuf::from("/tmp/\0bad");
        assert!(shell_escape_path(&p).is_err());
    }
}
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
cd src-tauri && cargo test --lib core::copy_strategy
```

기대: 10 passed.

```bash
git add src-tauri/src/core/
git commit -m "be/core: copy_strategy — CopyStrategy enum + decide() + shell_escape_path

- Local/Relay/SshSameHost 3-variant 결정
- decide(): same host_ip (다른 user OK) → SshSameHost
- shell_escape_path: POSIX single-quote, NUL byte 거부
- 10 tests"
```

---

### Task 2: core/copy_progress.rs

**Files:**
- Create: `src-tauri/src/core/copy_progress.rs`

**Why:** rsync `--info=progress2` 출력 라인을 ProgressEvent payload 로 파싱. parser 가 None 반환 = silent skip (robust).

- [ ] **Step 1: 모듈 작성 + 테스트 먼저**

```rust
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
    let percent = tokens[1].strip_suffix('%').and_then(|s| s.parse().ok())?;
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
        let p =
            parse_rsync_progress2_line("       1,024  10%   500.00kB/s    0:00:05").unwrap();
        assert_eq!(p.speed_bps, 500_000);
    }

    #[test]
    fn parse_gb_speed() {
        let p = parse_rsync_progress2_line(
            "10,000,000,000  50%   1.50GB/s    1:00:00 (xfr#1)",
        )
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
}
```

- [ ] **Step 2: 테스트 + 커밋**

```bash
cargo test --lib core::copy_progress
```

기대: 10 passed.

```bash
git add src-tauri/src/core/copy_progress.rs
git commit -m "be/core: copy_progress — rsync --info=progress2 라인 파서

- Progress { bytes_done, percent, speed_bps, eta_sec }
- 단위 변환: kB/MB/GB → bytes/s. eta H:MM:SS → seconds
- comma-separated bytes (1,234,567)
- 잡음 라인 (xfr#/summary/empty) 은 None 으로 silent skip
- 10 tests"
```

---

### Task 3: services/progress_events.rs

**Files:**
- Create: `src-tauri/src/services/progress_events.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/lib.rs` (collect_events!)

- [ ] **Step 1: services/mod.rs 등록**

```rust
//! 앱 서비스 — 비동기 작업 큐, 저널, 연결 풀, 설정.

pub mod connection_events;
pub mod connection_pool;
pub mod connection_supervisor;
pub mod fs_events;
pub mod fs_watcher;
pub mod journal;
pub mod journal_events;
pub mod progress_events;
pub mod settings;
pub mod trash;
```

- [ ] **Step 2: progress_events.rs**

```rust
//! 진행 중 op 의 실시간 progress 이벤트.
//!
//! MVP-3: 같은-host SSH copy 가 rsync `--info=progress2` 출력을 파싱해서
//! emit. cp fallback 또는 다른 op 는 emit 안 함 (ProgressModal 은 spinner).

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ProgressEvent {
    /// copy_execute 진입 시 발급한 임시 UUID (string).
    /// MVP-3 는 단일 active op 가정 — 매칭 무관. MVP-4 TaskQueue 와 함께
    /// 다중 op 식별에 사용.
    pub op_id: String,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub speed_bps: Option<u64>,
    pub eta_sec: Option<u32>,
    /// 0..=100
    pub percent: Option<u8>,
}
```

- [ ] **Step 3: lib.rs make_specta_builder 갱신**

`src-tauri/src/lib.rs` 의 `.events(collect_events![...])` 에 추가:

```rust
.events(collect_events![
    services::connection_events::ConnectionStateEvent,
    services::fs_events::FsChangedEvent,
    services::journal_events::JournalChangedEvent,
    services::progress_events::ProgressEvent,
])
```

- [ ] **Step 4: bindings 재생성 + 컴파일 + 커밋**

```bash
cargo run --bin export_bindings
cargo check --lib --tests
```

기대: bindings.ts 에 `progressEvent: ProgressEvent` + `export type ProgressEvent` 추가.

```bash
git add src-tauri/src/services/ src-tauri/src/lib.rs src/types/bindings.ts
git commit -m "be/svc: ProgressEvent (typed) + lib.rs 등록

MVP-3 same-host SSH copy 가 rsync stdout 파싱 후 emit. MVP-4 TaskQueue 와
함께 다중 op 식별 위해 op_id 필드 포함 (MVP-3 는 단일 active op)."
```

---

## Phase B: Remote exec

### Task 4: ssh/remote_exec.rs

**Files:**
- Create: `src-tauri/src/ssh/remote_exec.rs`
- Modify: `src-tauri/src/ssh/mod.rs`

**Why:** russh `Handle` 위에 exec 채널 + stdout/stderr/exit 캡처. 단발 (`exec`) + streaming (`exec_streaming`) 두 변종.

- [ ] **Step 1: ssh/mod.rs 등록**

```rust
//! SSH 연결 관리. russh 단일 스택 (시스템 ssh 호출 금지 — CLAUDE.md §9).

pub mod config;
pub mod connection;
pub mod remote_exec;
```

- [ ] **Step 2: remote_exec.rs**

```rust
//! 원격 SSH exec 채널 헬퍼.
//!
//! - `exec`: 단발 명령 → ExecOutput { exit_status, stdout, stderr } 모두 수집
//! - `exec_streaming`: stdout 라인 단위 콜백 (stderr 는 전체 수집), exit_status
//!   반환. progress 출력 같은 long-running 명령용.
//!
//! 둘 다 russh `Handle::channel_open_session().exec()` 사용. 시스템 ssh 호출
//! 절대 X (CLAUDE.md §9).

use crate::ssh::connection::AcceptAllHandler;
use crate::types::DuetError;
use russh::client::Handle;
use russh::ChannelMsg;

/// 단발 명령 결과.
#[derive(Debug, Clone)]
pub struct ExecOutput {
    pub exit_status: u32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// 단발 exec — stdout/stderr 전체 수집.
pub async fn exec(
    handle: &Handle<AcceptAllHandler>,
    cmd: &str,
) -> Result<ExecOutput, DuetError> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| DuetError::Ssh(format!("open session: {e}")))?;
    channel
        .exec(true, cmd)
        .await
        .map_err(|e| DuetError::Ssh(format!("exec '{cmd}': {e}")))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_status: Option<u32> = None;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, ext } if ext == 1 => {
                stderr.extend_from_slice(&data)
            }
            ChannelMsg::ExitStatus { exit_status: code } => {
                exit_status = Some(code);
            }
            ChannelMsg::Eof | ChannelMsg::Close => {
                // close 가 와도 ExitStatus 가 아직 안 왔을 수 있음 — 계속 대기
            }
            _ => {}
        }
        // ExitStatus 받았고 추가 메시지 없으면 종료 — wait().await None 으로 자연 종료
    }

    let exit_status = exit_status.unwrap_or(0);
    Ok(ExecOutput {
        exit_status,
        stdout,
        stderr,
    })
}

/// Streaming exec — stdout 라인 단위 콜백, stderr 전체 수집, exit_status 반환.
///
/// 콜백은 `&str` 라인 (newline 미포함). 비-UTF8 stdout 은 `String::from_utf8_lossy`
/// 로 lossy 변환. progress 라인은 ASCII 라 무관.
///
/// stderr 는 전체 수집 후 결과로 반환 — 에러 디버깅용.
pub async fn exec_streaming<F>(
    handle: &Handle<AcceptAllHandler>,
    cmd: &str,
    mut on_stdout_line: F,
) -> Result<(u32, Vec<u8>), DuetError>
where
    F: FnMut(&str),
{
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| DuetError::Ssh(format!("open session: {e}")))?;
    channel
        .exec(true, cmd)
        .await
        .map_err(|e| DuetError::Ssh(format!("exec '{cmd}': {e}")))?;

    let mut stdout_buf = Vec::<u8>::new();
    let mut stderr = Vec::new();
    let mut exit_status: Option<u32> = None;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => {
                stdout_buf.extend_from_slice(&data);
                // 라인 단위 flush. rsync 는 progress update 시 \r 로 같은 줄
                // 갱신 — \r 도 라인 구분자로 취급.
                while let Some(idx) = stdout_buf
                    .iter()
                    .position(|&b| b == b'\n' || b == b'\r')
                {
                    let line_bytes: Vec<u8> = stdout_buf.drain(..=idx).collect();
                    let line_str = String::from_utf8_lossy(&line_bytes);
                    let line_trimmed = line_str.trim_end_matches(['\r', '\n']);
                    if !line_trimmed.is_empty() {
                        on_stdout_line(line_trimmed);
                    }
                }
            }
            ChannelMsg::ExtendedData { data, ext } if ext == 1 => {
                stderr.extend_from_slice(&data)
            }
            ChannelMsg::ExitStatus { exit_status: code } => {
                exit_status = Some(code);
            }
            ChannelMsg::Eof | ChannelMsg::Close => {}
            _ => {}
        }
    }
    // 채널 종료 후 buffer 에 남은 partial line 도 flush
    if !stdout_buf.is_empty() {
        let line_str = String::from_utf8_lossy(&stdout_buf);
        let trimmed = line_str.trim_end_matches(['\r', '\n']);
        if !trimmed.is_empty() {
            on_stdout_line(trimmed);
        }
    }

    Ok((exit_status.unwrap_or(0), stderr))
}

#[cfg(test)]
mod tests {
    // 실제 SSH 통합 테스트는 docker compose 후속 — 컴파일 시그니처만.

    #[test]
    fn exec_signature_compiles() {
        let _ = super::exec;
    }

    #[test]
    fn exec_streaming_signature_compiles() {
        let _ = super::exec_streaming::<fn(&str)>;
    }
}
```

- [ ] **Step 3: 컴파일 + 테스트 + 커밋**

```bash
cargo check --lib --tests
cargo test --lib ssh::remote_exec
```

기대: 컴파일 OK, 2 sanity tests pass.

```bash
git add src-tauri/src/ssh/
git commit -m "be/ssh: remote_exec — exec + exec_streaming via russh channel

- exec(): 단발 명령, stdout/stderr 전체 수집 + exit_status
- exec_streaming(): stdout 라인 단위 콜백 (\\r 도 구분자 — rsync 업데이트
  방식 호환), stderr 전체 수집, exit_status 반환
- 시스템 ssh 호출 X (CLAUDE.md §9)
- 시그니처 sanity 테스트 2개 (실제 통합은 docker 후속)"
```

---

## Phase C: copy_execute 분기 + same_host_copy

### Task 5: ActiveConnection.rsync_available 캐시

**Files:**
- Modify: `src-tauri/src/services/connection_pool.rs`

**Why:** rsync detect 결과를 connection 수명동안 캐시. 매 same-host copy 마다 `command -v rsync` exec 비용 회피.

- [ ] **Step 1: 필드 추가**

`src-tauri/src/services/connection_pool.rs` 의 `ActiveConnection` struct:

```rust
pub struct ActiveConnection {
    pub id: ConnectionId,
    pub alias: String,
    pub host_ip: IpAddr,
    pub user: String,
    pub session: Option<tokio::sync::Mutex<russh::client::Handle<AcceptAllHandler>>>,
    /// rsync 가 원격에 설치되어 있는지 캐시. None = 미확인, Some(true/false) = 확인됨.
    /// MVP-3 same-host copy 의 첫 호출 때 detect 후 채움.
    pub rsync_available: tokio::sync::Mutex<Option<bool>>,
}
```

- [ ] **Step 2: 모든 ActiveConnection 생성 지점에 새 필드 추가**

검색: `ActiveConnection {`

해당 지점 (`commands/connection.rs::open_and_register`, `services/connection_supervisor.rs::reconnect_loop`, 테스트의 `mk_conn`) 에 추가:

```rust
ActiveConnection {
    id: id.clone(),
    alias: ...,
    host_ip,
    user: ...,
    session: Some(tokio::sync::Mutex::new(session.handle)),
    rsync_available: tokio::sync::Mutex::new(None),  // ← 신규
}
```

- [ ] **Step 3: Debug impl 갱신 (mod.rs 의 manual Debug)**

`connection_pool.rs` 의 `impl Debug for ActiveConnection` 안에 한 줄 추가:

```rust
.field("rsync_available", &"<cached>")
```

- [ ] **Step 4: 컴파일 + 테스트 + 커밋**

```bash
cargo check --lib --tests
cargo test --lib services::connection_pool
```

기대: 기존 5 connection_pool tests pass.

```bash
git add src-tauri/src/services/connection_pool.rs src-tauri/src/commands/connection.rs src-tauri/src/services/connection_supervisor.rs
git commit -m "be/svc: ActiveConnection.rsync_available 캐시 필드

per-connection rsync detect 결과 (None=미확인 / Some(bool)=확인됨).
MVP-3 same-host copy 가 첫 호출 때 detect, 이후 재사용.
모든 생성 지점 + Debug impl 갱신."
```

---

### Task 6: CopyPlan/MovePlan.strategy 필드

**Files:**
- Modify: `src-tauri/src/core/ops.rs`

**Why:** UI 가 ConfirmDialog 에 strategy 표시. plan 단계에서 결정.

- [ ] **Step 1: import + 필드 추가**

`src-tauri/src/core/ops.rs` 상단:

```rust
use crate::core::copy_strategy::{decide as decide_strategy, CopyStrategy};
```

`CopyPlan` / `MovePlan` 에 필드 추가:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CopyPlan {
    pub src_source: SourceId,
    pub dst: Location,
    pub items: Vec<EntryRef>,
    pub conflicts: Vec<Conflict>,
    pub total_size_bytes: u64,
    pub strategy: CopyStrategy,  // ← 신규
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MovePlan {
    pub src_source: SourceId,
    pub dst: Location,
    pub items: Vec<EntryRef>,
    pub conflicts: Vec<Conflict>,
    pub is_same_fs: bool,
    pub total_size_bytes: u64,
    pub strategy: CopyStrategy,  // ← 신규
}
```

- [ ] **Step 2: copy_plan 갱신 — 같은-host SSH 차단 제거 + strategy 채움**

기존:

```rust
// 같은 호스트 SSH↔SSH 차단 (CLAUDE.md DON'T list)
if let (SourceId::Ssh { host_ip: a, .. }, SourceId::Ssh { host_ip: b, .. }) =
    (&src_source, &dst.source)
{
    if a == b {
        return Err(DuetError::NotSupported(
            "same-host SSH copy: MVP-3 에서 지원".into(),
        ));
    }
}
```

→ 삭제. 대신 strategy 결정:

```rust
let strategy = decide_strategy(&src_source, &dst.source);
```

`Ok(CopyPlan { ... })` 에 `strategy` 추가.

- [ ] **Step 3: move_plan 갱신**

move_plan 은 copy_plan 호출 후 결과 활용:

```rust
pub async fn move_plan(...) -> Result<MovePlan, DuetError> {
    let copy = copy_plan(src_fs, dst_fs, items, dst.clone()).await?;
    let is_same_fs = copy.src_source == dst.source;
    Ok(MovePlan {
        src_source: copy.src_source,
        dst: copy.dst,
        items: copy.items,
        conflicts: copy.conflicts,
        is_same_fs,
        total_size_bytes: copy.total_size_bytes,
        strategy: copy.strategy,  // ← 신규
    })
}
```

- [ ] **Step 4: 기존 테스트 갱신 — same-host SSH copy 차단 테스트는 의미 변경됨**

```rust
#[tokio::test]
async fn copy_plan_same_host_ssh_now_uses_ssh_same_host_strategy() {
    use crate::core::copy_strategy::CopyStrategy;
    use crate::types::ConnectionId;
    use std::net::Ipv4Addr;

    let local = LocalFs::new();
    let src = SourceId::Ssh {
        connection_id: ConnectionId("a".into()),
        host_ip: std::net::IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
        user: "u".into(),
    };
    let dst_src = src.clone();

    let item = EntryRef {
        location: Location {
            source: src,
            path: PathBuf::from("/x"),
        },
        name: "f".into(),
    };
    let dst = Location {
        source: dst_src,
        path: PathBuf::from("/y"),
    };

    // metadata 호출은 LocalFs 가 받지만 path 가 존재 안 해서 unwrap_or(0).
    // strategy 결정만 검증.
    let plan = copy_plan(&local, &local, vec![item], dst).await.unwrap();
    assert_eq!(plan.strategy, CopyStrategy::SshSameHost);
}
```

(기존 `copy_plan_blocks_same_host_ssh` 테스트는 위로 교체.)

- [ ] **Step 5: bindings 재생성 + 컴파일 + 테스트 + 커밋**

```bash
cargo run --bin export_bindings
cargo test --lib core::ops
```

기대: 기존 ops tests pass + 신규 strategy 테스트 1개.

```bash
git add src-tauri/src/core/ops.rs src/types/bindings.ts
git commit -m "be/core: CopyPlan/MovePlan.strategy 필드 + same-host SSH 차단 제거

- decide_strategy 호출로 plan.strategy 결정
- 기존 'NotSupported(MVP-3)' 차단 제거 — Task 7 의 same_host_copy 가 처리
- copy_plan 테스트: 차단 검증 → SshSameHost strategy 검증으로 교체"
```

---

### Task 7: copy_execute 분기 + same_host_copy

**Files:**
- Modify: `src-tauri/src/core/ops.rs`

**Why:** MVP-3 의 핵심. strategy 별로 분기하고 same-host 면 rsync/cp exec.

- [ ] **Step 1: copy_execute 분기**

기존 `copy_execute` 본체:

```rust
pub async fn copy_execute(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: CopyPlan,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    match plan.strategy {
        CopyStrategy::LocalToLocal | CopyStrategy::Relay => {
            copy_execute_relay(src_fs, dst_fs, plan, ctx).await
        }
        CopyStrategy::SshSameHost => {
            copy_execute_same_host(plan, ctx).await
        }
    }
}

/// 기존 relay 경로 (LocalToLocal + Relay 공통).
async fn copy_execute_relay(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: CopyPlan,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    // ... 기존 copy_execute 본체 그대로 (충돌 backup → copy_relay → journal push)
}
```

기존 copy_execute 의 본체를 `copy_execute_relay` 로 이름만 바꾸고 새 thin wrapper 가 분기.

- [ ] **Step 2: same-host copy 본체 + helper**

`core/ops.rs` 끝에 추가:

```rust
/// Same-host SSH copy — server-side rsync 또는 cp exec.
///
/// 1. ConnectionPool 에서 active session 가져옴 (src/dst 같은 connection 가정 X —
///    src 측 connection 사용. user 가 다를 수 있는데 src 의 권한으로 dst 까지
///    읽기/쓰기 되어야 함; 안 되면 cp/rsync 가 자연 실패)
/// 2. rsync 캐시 확인 → 없으면 exec("command -v rsync") detect
/// 3. SFTP rename 으로 dst 충돌 backup (MVP-2 와 동일)
/// 4. exec_streaming 으로 rsync/cp 실행 + progress 파싱 emit
/// 5. exit !=0 → DuetError::Ssh(stderr) hard error
async fn copy_execute_same_host(
    plan: CopyPlan,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    use crate::core::copy_progress::parse_rsync_progress2_line;
    use crate::core::copy_strategy::shell_escape_path;
    use crate::services::progress_events::ProgressEvent;
    use crate::ssh::remote_exec::{exec, exec_streaming};
    use tauri_specta::Event;

    // src_source 에서 connection_id 추출
    let SourceId::Ssh { connection_id, .. } = &plan.src_source else {
        return Err(DuetError::Io("same_host_copy on non-ssh source".into()));
    };
    let conn = ctx
        .pool
        .as_ref()
        .ok_or_else(|| DuetError::Io("OpCtx.pool required for same-host copy".into()))?
        .get(connection_id)
        .await?;
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;

    // rsync detect (캐시)
    let use_rsync = {
        let mut cache = conn.rsync_available.lock().await;
        match *cache {
            Some(v) => v,
            None => {
                let handle = session_mutex.lock().await;
                let detected = match exec(&*handle, "command -v rsync").await {
                    Ok(out) => out.exit_status == 0,
                    Err(_) => false,
                };
                *cache = Some(detected);
                detected
            }
        }
    };

    // dst 측 충돌 감지 + backup (SFTP) — dst_fs 는 SshFs 가 필요.
    // copy_execute_relay 가 dst_fs 를 받지만 same_host 분기는 plan 만 받음 →
    // dst_fs 를 plan.dst.source 에서 재구성. SshFs 이미 구현됨.
    let dst_fs = crate::fs::SshFs::new(
        ctx.pool.as_ref().unwrap().get(connection_id).await?,
    );
    use crate::fs::FileSystem;

    let mut backups = Vec::new();
    for it in &plan.items {
        let dst_path = plan.dst.path.join(&it.name);
        if dst_fs.metadata(&dst_path).await.is_ok() {
            let backup = pick_backup_path(&dst_fs, &plan.dst.path, &it.name).await?;
            dst_fs.rename(&dst_path, &backup).await?;
            backups.push(BackupRestore {
                backup_path: backup,
                original_path: dst_path,
            });
        }
    }

    // op_id (single active op 가정 — UUID 임시)
    let op_id = uuid::Uuid::now_v7().to_string();
    let mut copied = Vec::new();

    // app handle for emit (OpCtx 에 추가 필요 — Task 8 에서 통합)
    let app = ctx
        .app
        .as_ref()
        .ok_or_else(|| DuetError::Io("OpCtx.app required for same-host copy".into()))?;

    for it in &plan.items {
        let src_path = it.location.path.join(&it.name);
        let dst_path = plan.dst.path.join(&it.name);
        let src_arg = shell_escape_path(&src_path)?;
        let dst_arg = shell_escape_path(&dst_path)?;

        let cmd = if use_rsync {
            format!("rsync -a --info=progress2 -- {src_arg} {dst_arg}")
        } else {
            format!("cp -a -- {src_arg} {dst_arg}")
        };

        // progress emit throttle: 1초
        let mut last_emit = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(2))
            .unwrap_or_else(std::time::Instant::now);
        let total_bytes = plan.total_size_bytes;
        let app_for_cb = app.clone();
        let op_id_cb = op_id.clone();

        let (exit, stderr) = {
            let handle = session_mutex.lock().await;
            exec_streaming(&*handle, &cmd, |line| {
                if let Some(p) = parse_rsync_progress2_line(line) {
                    let now = std::time::Instant::now();
                    let is_final = p.percent == 100;
                    if is_final
                        || now.duration_since(last_emit)
                            >= std::time::Duration::from_secs(1)
                    {
                        last_emit = now;
                        let _ = ProgressEvent {
                            op_id: op_id_cb.clone(),
                            bytes_done: p.bytes_done,
                            bytes_total: if total_bytes > 0 {
                                Some(total_bytes)
                            } else {
                                None
                            },
                            speed_bps: Some(p.speed_bps),
                            eta_sec: Some(p.eta_sec),
                            percent: Some(p.percent),
                        }
                        .emit(&app_for_cb);
                    }
                }
            })
            .await?
        };

        if exit != 0 {
            return Err(DuetError::Ssh(format!(
                "{} failed (exit {}): {}",
                if use_rsync { "rsync" } else { "cp" },
                exit,
                String::from_utf8_lossy(&stderr).trim()
            )));
        }
        copied.push(dst_path);
    }

    // Journal push (기존 schema)
    let undo = UndoAction::UndoCopy {
        target_source: plan.dst.source.clone(),
        copied,
        backups_to_restore: backups,
    };
    let op = OpKind::Copy {
        count: plan.items.len() as u32,
        src: plan.items[0].location.clone(),
        dst: plan.dst.clone(),
    };
    ctx.journal.push(op, undo).await
}
```

- [ ] **Step 3: OpCtx 확장 — pool + app 추가**

`OpCtx` struct 갱신:

```rust
pub struct OpCtx {
    pub journal: Arc<Journal>,
    pub settings: Arc<SettingsStore>,
    /// MVP-3 same-host copy 가 SSH session 접근에 필요. Local-only op 는 None.
    pub pool: Option<Arc<crate::services::connection_pool::ConnectionPool>>,
    /// MVP-3 progress emit 에 필요. Local-only op 는 None.
    pub app: Option<tauri::AppHandle>,
}
```

기존 테스트의 `OpCtx { journal, settings }` 직접 생성 지점 (core/ops.rs::tests::mk_ctx) 갱신:

```rust
async fn mk_ctx() -> (OpCtx, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let settings = ...;
    let journal = ...;
    (
        OpCtx {
            settings,
            journal,
            pool: None,
            app: None,
        },
        dir,
    )
}
```

smoke test (`tests/mvp2_smoke.rs::Env::ctx`) 도 동일 갱신.

- [ ] **Step 4: move_execute 도 같은 분기 추가**

`move_execute` 안의 충돌 backup 후 실제 copy 부분 — same fs 면 rename 으로 끝, 다른 fs 면 copy_relay + trash. SshSameHost 인 경우 rename 도 같은 fs 인데, 그건 src_source == dst.source 라서 is_same_fs=true → rename 경로로 자연스럽게 떨어짐. 즉 SshSameHost move 는 rename (atomic) 으로 충분 — 변경 불요.

다만 SshSameHost 인데 is_same_fs=false 인 경우는 없음 (host_ip 같으면 src_source == dst.source 일 가능성 — 아니, user 가 다를 수 있음. 그러면 src_source != dst.source 인데 host_ip 만 같음. 즉 SshSameHost ∧ !is_same_fs 가능).

이 경우 move_execute 의 else 가지가 copy_relay + trash 호출 — 이건 same-host 인데 relay 로 떨어짐 (느림). MVP-3 에서 fix:

```rust
if plan.is_same_fs {
    src_fs.rename(&src_path, &dst_path).await?;
} else if plan.strategy == CopyStrategy::SshSameHost {
    // 같은-host 인데 user 가 다른 경우 — rename 안 되니 cp + trash
    // copy 부분만 copy_execute_same_host 의 helper 로 — 또는 그냥 cp/rsync exec
    // (간단화: same_host_copy 의 inner 호출하기 위해 pseudo-CopyPlan 만들기)
    let mini_plan = CopyPlan {
        src_source: plan.src_source.clone(),
        dst: plan.dst.clone(),
        items: vec![it.clone()],
        conflicts: vec![],
        total_size_bytes: 0,
        strategy: CopyStrategy::SshSameHost,
    };
    // copy_execute_same_host 는 journal push 함 — 우리 move 는 이미 journal 따로
    // 작성. 헬퍼로 분리 필요. 시간 문제로 MVP-3 v1 은 fallback Relay copy_relay
    // (warning log + 에러 toast 추천 후속)
    // 일단 hard error 로 두고 MVP-3 v2 에서 분리
    return Err(DuetError::NotSupported(
        "same-host SSH move with different user: not yet (MVP-3 v2)".into(),
    ));
} else {
    crate::fs::copy_relay(src_fs, &src_path, dst_fs, &dst_path).await?;
    let batch_id = crate::services::trash::new_batch_id();
    src_fs.trash(&src_path, &batch_id).await?;
}
```

(MVP-3 핵심은 copy. move + 다른 user 는 흔하지 않은 corner — 명시 NotSupported 로 에러 명확화.)

- [ ] **Step 5: 컴파일 + 테스트 + 커밋**

```bash
cargo check --lib --tests
cargo test --lib core::ops
```

기대: 기존 + 신규 SshSameHost strategy 테스트 통과.

```bash
git add src-tauri/src/core/ops.rs
git commit -m "be/core: copy_execute 분기 + same_host_copy (MVP-3 핵심)

- copy_execute 가 plan.strategy 분기:
  - LocalToLocal/Relay → 기존 copy_execute_relay (rename)
  - SshSameHost → 신규 copy_execute_same_host
- copy_execute_same_host:
  1. ActiveConnection.rsync_available 캐시 확인 → 없으면 exec(command -v rsync)
  2. SFTP 로 dst 충돌 감지 + .bak.<ts> rename (MVP-2 일관)
  3. shell_escape_path 로 path quote → rsync/cp -a exec_streaming
  4. parse_rsync_progress2_line + 1초 throttle + ProgressEvent emit
  5. exit !=0 → DuetError::Ssh(stderr) hard error (silent relay X)
- OpCtx 에 pool + app Option 추가 (same-host copy 가 필요)
- move_execute 의 same-host different-user case: NotSupported (MVP-3 v2)"
```

---

### Task 8: commands/fs_ops 갱신 — OpCtx 의 pool/app 채움

**Files:**
- Modify: `src-tauri/src/commands/fs_ops.rs`

**Why:** Task 7 의 OpCtx 가 pool/app 필드를 받게 됨. command 가 Tauri State + AppHandle 에서 채워줘야 함.

- [ ] **Step 1: ctx 헬퍼 갱신**

기존:

```rust
fn ctx(settings: Arc<SettingsStore>, journal: Arc<Journal>) -> OpCtx {
    OpCtx { settings, journal }
}
```

→ pool + app 받도록:

```rust
fn ctx(
    settings: Arc<SettingsStore>,
    journal: Arc<Journal>,
    pool: Arc<ConnectionPool>,
    app: tauri::AppHandle,
) -> OpCtx {
    OpCtx {
        settings,
        journal,
        pool: Some(pool),
        app: Some(app),
    }
}
```

- [ ] **Step 2: 모든 호출 지점 갱신**

`fs_copy_execute`, `fs_move_execute`, `fs_delete_execute`, `fs_rename`, `fs_mkdir` — `ctx(settings, journal)` 호출을 `ctx(settings, journal, pool, app)` 로. pool/app 은 이미 함수 인자로 들어와 있음 (settings/journal 옆).

예시 (`fs_copy_execute`):

```rust
let entry = ops::copy_execute(
    &*src_fs,
    &*dst_fs,
    plan,
    &ctx(
        settings.inner().clone(),
        journal.inner().clone(),
        pool.inner().clone(),
        app.clone(),
    ),
)
.await?;
```

- [ ] **Step 3: 컴파일 + 테스트**

```bash
cargo check --lib --tests --bins
cargo test --lib
```

기대: 60+ tests pass.

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/commands/fs_ops.rs
git commit -m "be/cmd: fs_ops ctx 헬퍼 — OpCtx.pool/app 주입

Task 7 의 OpCtx 확장 (pool, app Option) 에 맞춰 ctx() 헬퍼 4 인자.
모든 _execute / fs_rename / fs_mkdir 갱신."
```

---

## Phase D: Frontend

### Task 9: useProgressEvents hook + ui-dialogs progress 필드

**Files:**
- Modify: `src/stores/ui-dialogs.ts`
- Create: `src/hooks/useProgressEvents.ts`

**Why:** ProgressEvent 받아 ProgressModal 에 데이터 흐름.

- [ ] **Step 1: ui-dialogs 의 progress dialog 에 progress 필드 추가**

`src/stores/ui-dialogs.ts`:

```typescript
export type DialogState =
  | { kind: "none" }
  | { kind: "rename"; target: EntryRef }
  | { kind: "mkdir"; parent: Location }
  | { kind: "delete-confirm"; plan: DeletePlan }
  | { kind: "delete-danger"; plan: DeletePlan }
  | { kind: "copy-confirm"; plan: CopyPlan }
  | { kind: "move-confirm"; plan: MovePlan }
  | { kind: "progress"; title: string; progress?: ProgressInfo }  // ← progress 추가
  | { kind: "settings" };

export interface ProgressInfo {
  bytesDone: number;
  bytesTotal: number | null;
  speedBps: number | null;
  etaSec: number | null;
  percent: number | null;
}

interface State {
  dialog: DialogState;
  open: (d: DialogState) => void;
  close: () => void;
  /** Update progress on current 'progress' dialog. No-op otherwise. */
  setProgress: (p: ProgressInfo) => void;
}

export const useUIDialogs = create<State>((set) => ({
  dialog: { kind: "none" },
  open: (d) => set({ dialog: d }),
  close: () => set({ dialog: { kind: "none" } }),
  setProgress: (p) =>
    set((s) =>
      s.dialog.kind === "progress"
        ? { dialog: { ...s.dialog, progress: p } }
        : s,
    ),
}));
```

`ProgressInfo` 와 `ProgressPlan` import 필요. `ProgressEvent` 타입은 bindings.ts 에서.

- [ ] **Step 2: useProgressEvents hook**

```typescript
// src/hooks/useProgressEvents.ts
import { useEffect } from "react";
import { events } from "@/types/bindings";
import { useUIDialogs } from "@/stores/ui-dialogs";

/**
 * `progress-event` 구독 → ui-dialogs 의 'progress' dialog 에 update.
 * MVP-3 는 단일 active op 가정 — op_id 매칭 안 함.
 */
export function useProgressEvents() {
  const setProgress = useUIDialogs((s) => s.setProgress);

  useEffect(() => {
    const unlistenP = events.progressEvent.listen(({ payload }) => {
      setProgress({
        bytesDone: payload.bytes_done,
        bytesTotal: payload.bytes_total ?? null,
        speedBps: payload.speed_bps ?? null,
        etaSec: payload.eta_sec ?? null,
        percent: payload.percent ?? null,
      });
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [setProgress]);
}
```

- [ ] **Step 3: 테스트**

ui-dialogs.test.ts 에 setProgress 동작 1개 추가:

```typescript
it("setProgress updates progress on progress dialog only", () => {
  useUIDialogs.getState().open({ kind: "progress", title: "Copying" });
  useUIDialogs.getState().setProgress({
    bytesDone: 100, bytesTotal: 200, speedBps: 50, etaSec: 2, percent: 50,
  });
  const d = useUIDialogs.getState().dialog;
  expect(d.kind).toBe("progress");
  if (d.kind === "progress") {
    expect(d.progress?.percent).toBe(50);
  }

  // settings dialog 면 no-op
  useUIDialogs.getState().open({ kind: "settings" });
  useUIDialogs.getState().setProgress({
    bytesDone: 999, bytesTotal: null, speedBps: null, etaSec: null, percent: null,
  });
  expect(useUIDialogs.getState().dialog.kind).toBe("settings");
});
```

- [ ] **Step 4: 테스트 + 커밋**

```bash
pnpm test --run src/stores/ui-dialogs.test.ts
```

기대: 3 passed (기존 2 + 신규 1).

```bash
git add src/stores/ui-dialogs.ts src/stores/ui-dialogs.test.ts src/hooks/useProgressEvents.ts
git commit -m "fe/store + fe/hook: ui-dialogs progress 필드 + useProgressEvents

- ui-dialogs: 'progress' dialog 에 ProgressInfo 옵셔널 필드 + setProgress
  action (다른 dialog 면 no-op)
- useProgressEvents: events.progressEvent.listen → setProgress
- 3 vitest passed"
```

---

### Task 10: ProgressModal 확장 (bar + speed + ETA)

**Files:**
- Modify: `src/components/dialogs/ProgressModal.tsx`

**Why:** progress 데이터 있으면 percentage bar + bytes + speed + ETA 표시. 없으면 기존 spinner.

- [ ] **Step 1: ProgressModal 갱신**

```tsx
// src/components/dialogs/ProgressModal.tsx
import * as Dialog from "@radix-ui/react-dialog";
import { Loader } from "lucide-react";
import { formatSize } from "@/lib/format";
import type { ProgressInfo } from "@/stores/ui-dialogs";

export function ProgressModal({
  title,
  progress,
}: {
  title: string;
  progress?: ProgressInfo;
}) {
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <Dialog.Title className="text-title font-medium">{title}</Dialog.Title>

          {progress ? <ProgressBody p={progress} /> : <SpinnerBody />}

          <Dialog.Description className="sr-only">{title}</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SpinnerBody() {
  return (
    <div className="mt-3 flex items-center gap-2 text-base text-fg-muted">
      <Loader size={14} className="animate-spin" />
      <span>Working…</span>
    </div>
  );
}

function ProgressBody({ p }: { p: ProgressInfo }) {
  const pct = p.percent ?? 0;
  return (
    <div className="mt-3 space-y-2">
      <div className="h-2 w-full overflow-hidden rounded bg-subtle">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="flex justify-between text-meta text-fg-muted">
        <span>
          {formatSize(p.bytesDone)}
          {p.bytesTotal ? ` / ${formatSize(p.bytesTotal)}` : ""}
        </span>
        <span>
          {p.speedBps ? `${formatSize(p.speedBps)}/s` : ""}
          {p.etaSec != null ? ` · ETA ${formatEta(p.etaSec)}` : ""}
        </span>
      </div>
    </div>
  );
}

function formatEta(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
```

- [ ] **Step 2: tsc + 컴파일 + 커밋**

```bash
pnpm tsc --noEmit
```

기대: 0 errors.

```bash
git add src/components/dialogs/ProgressModal.tsx
git commit -m "fe/ui: ProgressModal 확장 — progress bar + speed + ETA

progress 없으면 기존 spinner. 있으면 % bar + bytes_done/total +
speed/s + ETA. cp fallback / 시작 직후는 spinner 유지."
```

---

### Task 11: App.tsx 통합 — useProgressEvents + CopyOrMovePlanBody strategy 라벨

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: hook 호출 추가**

App 컴포넌트의 hook 부트스트랩 부분 (useDestructiveKeys 옆):

```tsx
useDestructiveKeys();
useJournalEvents();
useProgressEvents();  // ← 신규
```

import 추가:

```tsx
import { useProgressEvents } from "@/hooks/useProgressEvents";
```

- [ ] **Step 2: ProgressModal 호출 시 progress 전달**

기존:

```tsx
{dialog.kind === "progress" && <ProgressModal title={dialog.title} />}
```

→

```tsx
{dialog.kind === "progress" && (
  <ProgressModal title={dialog.title} progress={dialog.progress} />
)}
```

- [ ] **Step 3: CopyOrMovePlanBody 에 strategy 라벨**

`CopyOrMovePlanBody` 함수 갱신 — props 에 `strategy` 추가:

```tsx
function CopyOrMovePlanBody({
  count,
  totalSize,
  dstPath,
  conflicts,
  strategy,
}: {
  count: number;
  totalSize: number;
  dstPath: string;
  conflicts: number;
  strategy: import("@/types/bindings").CopyStrategy;
}) {
  return (
    <div className="space-y-1">
      <div>
        {count} item(s), {formatSize(totalSize)} →{" "}
        <span className="font-mono">{dstPath}</span>
      </div>
      <div className="text-meta text-fg-muted">
        Strategy: {strategyLabel(strategy)}
      </div>
      {conflicts > 0 && (
        <div className="text-meta text-fg-muted">
          {conflicts} conflict(s) — existing file(s) will be backed up to{" "}
          <span className="font-mono">.bak.&lt;ts&gt;</span>
        </div>
      )}
    </div>
  );
}

function strategyLabel(s: import("@/types/bindings").CopyStrategy): string {
  switch (s.kind) {
    case "local_to_local":
      return "local";
    case "relay":
      return "relay (via this PC)";
    case "ssh_same_host":
      return "same-host (fast, server-side)";
  }
}
```

호출 지점 두 곳 (copy-confirm, move-confirm) 에서 `strategy={dialog.plan.strategy}` 추가:

```tsx
{dialog.kind === "copy-confirm" && (
  <ConfirmDialog
    title="Copy"
    body={
      <CopyOrMovePlanBody
        count={dialog.plan.items.length}
        totalSize={dialog.plan.total_size_bytes}
        dstPath={dialog.plan.dst.path}
        conflicts={dialog.plan.conflicts.length}
        strategy={dialog.plan.strategy}
      />
    }
    ...
  />
)}
{dialog.kind === "move-confirm" && (
  <ConfirmDialog
    ...
    body={
      <CopyOrMovePlanBody
        ...
        strategy={dialog.plan.strategy}
      />
    }
    ...
  />
)}
```

- [ ] **Step 4: tsc + lint + 커밋**

```bash
pnpm tsc --noEmit
pnpm lint
pnpm test --run
```

기대: 0 errors / 0 warnings / 모든 vitest pass.

```bash
git add src/App.tsx
git commit -m "fe: App 통합 — useProgressEvents + CopyOrMovePlanBody strategy 라벨

- useProgressEvents 부트스트랩
- ProgressModal 에 progress 전달
- CopyOrMovePlanBody: 'Strategy: same-host (fast, server-side) / relay
  (via this PC) / local' 한 줄 표시 — 사용자 confirm 전에 어느 경로인지 보임"
```

---

## Phase E: Smoke + 마무리

### Task 12: smoke test (parser + strategy 매트릭스)

**Files:**
- Create: `src-tauri/tests/mvp3_smoke.rs`

**Why:** 별도 smoke 파일로 strategy decision matrix + parser edge cases 검증. 실제 SSH 통합은 docker compose 후속.

- [ ] **Step 1: smoke test 작성**

```rust
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
    let p = parse_rsync_progress2_line(
        "  235,000,000 100%   15.42MB/s    0:00:00 (xfr#1, to-chk=0/1)",
    )
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
```

- [ ] **Step 2: 테스트 + 커밋**

```bash
cargo test --test mvp3_smoke
```

기대: 5 passed.

```bash
git add src-tauri/tests/mvp3_smoke.rs
git commit -m "test/smoke: MVP-3 — strategy matrix + rsync parser + shell escape

5 시나리오. 실제 SSH↔SSH 통합 검증은 docker compose 후속."
```

---

### Task 13: 최종 quality gates + ROADMAP

- [ ] **Step 1: cargo + pnpm 최종**

```bash
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --lib && cargo test --tests
cd .. && pnpm tsc --noEmit && pnpm lint && pnpm test --run
```

모두 통과 확인.

- [ ] **Step 2: ROADMAP MVP-3 [x]**

`ROADMAP.md` MVP-3 섹션 갱신:

```markdown
## MVP-3: 같은 호스트 복사 최적화 (핵심 차별점)

**완료 조건**: 같은 SSH 호스트 내에서 복사하면 본인 PC를 거치지 않는다.

- [x] `core::CopyStrategy` 결정 로직 (Local/Relay/SshSameHost)
- [x] 같은 호스트 감지 (`host_ip` 일치 시 same-host, user 달라도 OK)
- [x] SSH exec 채널로 `rsync` 또는 `cp -a` 실행 (russh exec, 시스템 ssh X)
- [x] 진행률 파싱 (rsync `--info=progress2`) + ProgressEvent + ProgressModal
- [ ] 큰 파일 / 많은 파일에서 검증 (10GB+, 1만개 파일+) — docker compose 후속
- [x] 실패 시 폴백 정책: hard error (silent relay 절대 X — CLAUDE.md DON'T)

**완료 시 일상 사용**: TC보다 명백히 빠른 일상 도구.
```

`현재 단계` 갱신:

```markdown
**MVP-4 시작 직전.** MVP-3 핵심 완료 — same-host SSH 복사가 server-side
rsync/cp 로 실행됨. 큰 파일 stress test 는 docker 환경 마련 후 후속.
```

- [ ] **Step 3: 커밋**

```bash
git add ROADMAP.md
git commit -m "docs: MVP-3 핵심 완료 표시 (큰 파일 stress 는 후속)"
```

---

## 자기 점검 (작성자용)

**Spec 커버리지:**

| Spec section | Task |
|---|---|
| copy_strategy decide + shell_escape_path | 1 |
| copy_progress parser | 2 |
| ProgressEvent typed event | 3 |
| remote_exec (exec + exec_streaming) | 4 |
| ActiveConnection.rsync_available 캐시 | 5 |
| CopyPlan/MovePlan.strategy 필드 | 6 |
| copy_execute 분기 + same_host_copy | 7 |
| OpCtx pool/app + commands ctx 갱신 | 7, 8 |
| useProgressEvents + ui-dialogs progress | 9 |
| ProgressModal 확장 | 10 |
| App 통합 + strategy 라벨 | 11 |
| smoke test | 12 |
| ROADMAP | 13 |

**위험 영역:**
- Task 7 (same_host_copy): russh `Channel::exec` / `wait` API 정확한 시그니처는 docs.rs 확인 필요. exit_status 캡처 시점 (Eof/Close 전후) 미묘.
- Task 7 의 `OpCtx.pool/app` Option — Local op 는 None 으로 OK 지만 SshSameHost 분기에서 `unwrap` 대신 Err 반환. 호출자가 항상 채워주는지 ctx() 헬퍼 (Task 8) 가 보장.
- Task 7 의 move_execute SshSameHost ∧ different-user 케이스: 현재 NotSupported. 사용자 케이스가 흔하면 후속에서 분리 헬퍼.
- Task 11 의 `CopyStrategy` import — bindings.ts 의 union variant `kind: "ssh_same_host"` 는 serde rename_all snake_case 결과. 매칭 누락 시 ts-pattern exhaustiveness 안 잡아주므로 switch case 신중.

---

## 실행 핸드오프

Plan complete and saved to `docs/plans/2026-05-10-mvp3-same-host-ssh-copy.md`.

**Phase 단위 권장 분할:**
- Session 1: Phase A (Task 1-3) — Foundation (parser + strategy + event)
- Session 2: Phase B + C (Task 4-8) — Remote exec + copy_execute 분기 (큼 — 잘게 나눠 진행)
- Session 3: Phase D + E (Task 9-13) — Frontend + smoke + 마무리

각 Session 끝에 `cargo test --lib && cargo test --tests` + `pnpm test --run` 베이스라인.
