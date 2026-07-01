//! 원격 sudo 승격 복사 — SSH 서버의 보호 경로(root 소유 `/etc`, `/usr/local/bin` 등)
//! 쓰기. 설계: `docs/specs/2026-07-01-remote-sudo-copy.md`.
//!
//! UAC(로컬 Windows)의 원격판. SFTP 는 권한 상승 개념이 없어 exec 채널로 `sudo` 실행.
//! - Local→Remote: 사용자 홈 staging 에 SFTP 업로드 → `sudo cp -a staging → dest`.
//! - Remote→Remote(same-host): `sudo cp -a src dest` 직접(staging 불필요).
//!
//! §5: sudo 비번은 stdin 전용(cmdline `ps` 노출 X, 로그 X, 사용 직후 zero-fill —
//! `SshFs::sudo_run`). §9: russh exec, 시스템 ssh 바이너리 X. v1: 복사만, undo 없음.

use crate::core::copy_strategy::shell_escape_path;
use crate::core::ops::ConflictPolicy;
use crate::fs::{FileSystem, SshFs};
use crate::types::{DuetError, EntryKind};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

/// sudo 복사 결과 — 3-state (FE 가 비번 다이얼로그 흐름 제어).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SudoOutcome {
    /// 실행됨 — 성공 개수 + 실패 목록.
    Ok { count: u32, failed: Vec<String> },
    /// sudo 가 비번을 요구 (passwordless 아님) — FE 가 비번 받아 재호출.
    NeedPassword,
    /// 제공한 비번이 틀림 — FE 가 재입력.
    WrongPassword,
}

/// stderr 가 sudo 인증 실패를 나타내는지 (비번 틀림/필요).
fn is_auth_failure(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("try again")
        || s.contains("incorrect password")
        || s.contains("authentication failure")
        || s.contains("a password is required")
        || s.contains("a terminal is required")
        || s.contains("sorry, try")
}

/// `/bin/sh -c` 로 실행할 복사 스크립트 — 경로는 shell-escape, 비번은 **포함 안 함**(stdin).
/// Overwrite=`cp -a`, Skip=`[ -e dst ] ||`. KeepBoth 는 v1 에서 Overwrite 로 취급.
fn build_copy_script(
    pairs: &[(PathBuf, PathBuf)],
    conflict: ConflictPolicy,
) -> Result<String, DuetError> {
    let mut s = String::from("set -e\n");
    for (src, dst) in pairs {
        let sq = shell_escape_path(src)?;
        let dq = shell_escape_path(dst)?;
        if let Some(parent) = dst.parent() {
            s.push_str(&format!("mkdir -p {}\n", shell_escape_path(parent)?));
        }
        match conflict {
            ConflictPolicy::Skip => s.push_str(&format!("[ -e {dq} ] || cp -a -- {sq} {dq}\n")),
            // Replace/KeepBoth → 덮어쓰기 (system 배포는 대개 replace; KeepBoth 는 v1 미지원).
            _ => s.push_str(&format!("cp -a -- {sq} {dq}\n")),
        }
    }
    Ok(s)
}

/// 로컬(또는 same-host 원격) 트리를 원격 staging 으로 SFTP 업로드 (재귀). 청크 스트리밍
/// 재사용(`copy_relay_streaming`).
async fn upload_tree(
    src_fs: &dyn FileSystem,
    src: &Path,
    dst_fs: &dyn FileSystem,
    dst: &Path,
    cancel: &CancellationToken,
) -> Result<(), DuetError> {
    let meta = src_fs.metadata(src).await?;
    if meta.kind == EntryKind::Dir {
        let _ = dst_fs.mkdir(dst).await; // staging 하위 생성(멱등)
        for e in src_fs.list(src).await? {
            let s = src_fs.join(src, &e.name);
            let d = dst_fs.join(dst, &e.name);
            Box::pin(upload_tree(src_fs, &s, dst_fs, &d, cancel)).await?;
        }
        Ok(())
    } else {
        let noop_b = |_: u64| {};
        let noop_f = |_: &Path| {};
        crate::fs::copy_relay_streaming(src_fs, src, dst_fs, dst, false, cancel, &noop_b, &noop_f)
            .await
    }
}

/// 원격 sudo 복사 실행. `items` = (src 절대경로, 이름), 최종 = `dst_dir/이름`.
/// `same_host`=true 면 src 가 dst 와 같은 원격(직접 sudo cp), false 면 Local→Remote(staging).
pub async fn copy_execute_sudo(
    src_fs: &dyn FileSystem,
    dst_ssh: &SshFs,
    same_host: bool,
    items: Vec<(PathBuf, String)>,
    dst_dir: &Path,
    password: Option<&str>,
    conflict: ConflictPolicy,
) -> Result<SudoOutcome, DuetError> {
    if items.is_empty() {
        return Err(DuetError::Io("no items".into()));
    }
    // staging 업로드용 취소 토큰 — 이 경로는 취소 미지원(v1)이라 내부 생성.
    let cancel = CancellationToken::new();
    // passwordless(캐시된 sudo 타임스탬프/NOPASSWD) 먼저 시도.
    let passwordless = dst_ssh.sudo_probe().await.unwrap_or(false);
    if !passwordless && password.is_none() {
        return Ok(SudoOutcome::NeedPassword);
    }

    // 최종 (src, dst) 쌍 — same-host 는 직접, 아니면 staging 경유.
    let (pairs, staging): (Vec<(PathBuf, PathBuf)>, Option<PathBuf>) = if same_host {
        let p = items
            .iter()
            .map(|(src, name)| (src.clone(), dst_ssh.join(dst_dir, name)))
            .collect();
        (p, None)
    } else {
        // 사용자 홈 아래 랜덤 staging (사용자 소유 → SFTP 업로드 OK).
        let home = dst_ssh.home().await?;
        let root = dst_ssh.join(
            &dst_ssh.join(&home, ".duet-sudo"),
            &uuid::Uuid::new_v4().to_string(),
        );
        let dst_dyn: &dyn FileSystem = dst_ssh;
        let _ = dst_dyn.mkdir(&root).await;
        let mut p = Vec::new();
        for (src, name) in &items {
            let staged = dst_ssh.join(&root, name);
            upload_tree(src_fs, src, dst_dyn, &staged, &cancel).await?;
            p.push((staged, dst_ssh.join(dst_dir, name)));
        }
        (p, Some(root))
    };

    let script = build_copy_script(&pairs, conflict)?;
    // passwordless 면 sudo -n, 아니면 -S 로 stdin 비번.
    let pw = if passwordless { None } else { password };
    let out = dst_ssh.sudo_run(&script, pw).await;

    // staging 정리(사용자 소유 — sudo 불필요). 성패 무관.
    if let Some(root) = &staging {
        let esc = shell_escape_path(root)?;
        let _ = dst_ssh.exec_raw(&format!("rm -rf -- {esc}")).await;
    }

    let out = out?;
    if out.exit_status == 0 {
        return Ok(SudoOutcome::Ok {
            count: items.len() as u32,
            failed: Vec::new(),
        });
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if password.is_some() && is_auth_failure(&stderr) {
        return Ok(SudoOutcome::WrongPassword);
    }
    if !passwordless && password.is_none() && is_auth_failure(&stderr) {
        return Ok(SudoOutcome::NeedPassword);
    }
    Ok(SudoOutcome::Ok {
        count: 0,
        failed: vec![format!("sudo cp failed: {}", stderr.trim())],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_escapes_and_no_password() {
        let pairs = vec![(
            PathBuf::from("/home/u/.duet-sudo/x/app.conf"),
            PathBuf::from("/etc/app/app.conf"),
        )];
        let s = build_copy_script(&pairs, ConflictPolicy::Replace).unwrap();
        assert!(s.contains("cp -a -- '/home/u/.duet-sudo/x/app.conf' '/etc/app/app.conf'"));
        assert!(s.contains("mkdir -p '/etc/app'"));
        // 스크립트에 비번이 절대 안 들어감(§5 — 비번은 stdin).
        assert!(!s.to_lowercase().contains("password"));
    }

    #[test]
    fn skip_guards_existence() {
        let pairs = vec![(PathBuf::from("/a/x"), PathBuf::from("/etc/x"))];
        let s = build_copy_script(&pairs, ConflictPolicy::Skip).unwrap();
        assert!(s.contains("[ -e '/etc/x' ] || cp -a -- '/a/x' '/etc/x'"));
    }

    #[test]
    fn auth_failure_detection() {
        assert!(is_auth_failure("sudo: 1 incorrect password attempt"));
        assert!(is_auth_failure("Sorry, try again."));
        assert!(is_auth_failure("sudo: a password is required"));
        assert!(!is_auth_failure(
            "cp: cannot create regular file: No space left"
        ));
    }
}
