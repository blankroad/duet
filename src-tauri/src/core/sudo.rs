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
use crate::core::elevate::ElevatedOp;
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

/// `/bin/sh -c` 로 실행할 op 스크립트 — 경로 shell-escape, 비번은 **포함 안 함**(stdin).
/// Copy=`cp -a`, Move/Trash=`mv`(Trash 는 dst=휴지통경로), Delete=`rm -rf`.
/// Skip=`[ -e dst ] ||`. KeepBoth 는 v1 에서 Overwrite 로 취급.
fn build_script(
    op: ElevatedOp,
    items: &[(PathBuf, Option<PathBuf>)],
    conflict: ConflictPolicy,
) -> Result<String, DuetError> {
    let mut s = String::from("set -e\n");
    for (src, dst) in items {
        let sq = shell_escape_path(src)?;
        if matches!(op, ElevatedOp::Delete) {
            s.push_str(&format!("rm -rf -- {sq}\n"));
            continue;
        }
        let dst = dst
            .as_ref()
            .ok_or_else(|| DuetError::Io("copy/move needs dst".into()))?;
        let dq = shell_escape_path(dst)?;
        if let Some(parent) = dst.parent() {
            s.push_str(&format!("mkdir -p {}\n", shell_escape_path(parent)?));
        }
        let verb = if matches!(op, ElevatedOp::Copy) {
            "cp -a"
        } else {
            "mv" // Move | Trash
        };
        match conflict {
            ConflictPolicy::Skip => s.push_str(&format!("[ -e {dq} ] || {verb} -- {sq} {dq}\n")),
            _ => s.push_str(&format!("{verb} -- {sq} {dq}\n")),
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

/// 원격 sudo op 실행 (copy/move/trash/delete). `items` = (src 절대경로, dst 절대경로 or
/// None). `stage`=true 면 각 src(로컬)를 원격 홈 staging 으로 업로드 후 src 를 staged 로
/// 치환(Local→Remote copy/move). trash/delete 는 dst_none / dst=휴지통경로를 커맨드가 구성.
pub async fn execute_sudo(
    op: ElevatedOp,
    src_fs: &dyn FileSystem,
    dst_ssh: &SshFs,
    stage: bool,
    mut items: Vec<(PathBuf, Option<PathBuf>)>,
    password: Option<&str>,
    conflict: ConflictPolicy,
) -> Result<SudoOutcome, DuetError> {
    if items.is_empty() {
        return Err(DuetError::Io("no items".into()));
    }
    let cancel = CancellationToken::new();
    // passwordless(캐시된 sudo 타임스탬프/NOPASSWD) 먼저 시도.
    let passwordless = dst_ssh.sudo_probe().await.unwrap_or(false);
    if !passwordless && password.is_none() {
        return Ok(SudoOutcome::NeedPassword);
    }

    // staging: 로컬 src 를 원격 홈 staging 으로 업로드 후 src 를 staged 경로로 치환.
    let staging = if stage {
        let home = dst_ssh.home().await?;
        let root = dst_ssh.join(
            &dst_ssh.join(&home, ".duet-sudo"),
            &uuid::Uuid::new_v4().to_string(),
        );
        let dst_dyn: &dyn FileSystem = dst_ssh;
        let _ = dst_dyn.mkdir(&root).await;
        for (src, _dst) in items.iter_mut() {
            let name = src
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let staged = dst_ssh.join(&root, &name);
            upload_tree(src_fs, src, dst_dyn, &staged, &cancel).await?;
            *src = staged;
        }
        Some(root)
    } else {
        None
    };

    let script = build_script(op, &items, conflict)?;
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
        failed: vec![format!("sudo op failed: {}", stderr.trim())],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_escapes_and_no_password() {
        let items = vec![(
            PathBuf::from("/home/u/.duet-sudo/x/app.conf"),
            Some(PathBuf::from("/etc/app/app.conf")),
        )];
        let s = build_script(ElevatedOp::Copy, &items, ConflictPolicy::Replace).unwrap();
        assert!(s.contains("cp -a -- '/home/u/.duet-sudo/x/app.conf' '/etc/app/app.conf'"));
        assert!(s.contains("mkdir -p '/etc/app'"));
        // 스크립트에 비번이 절대 안 들어감(§5 — 비번은 stdin).
        assert!(!s.to_lowercase().contains("password"));
    }

    #[test]
    fn skip_guards_existence() {
        let items = vec![(PathBuf::from("/a/x"), Some(PathBuf::from("/etc/x")))];
        let s = build_script(ElevatedOp::Copy, &items, ConflictPolicy::Skip).unwrap();
        assert!(s.contains("[ -e '/etc/x' ] || cp -a -- '/a/x' '/etc/x'"));
    }

    #[test]
    fn move_uses_mv_delete_uses_rm() {
        let mv = build_script(
            ElevatedOp::Move,
            &[(PathBuf::from("/a/x"), Some(PathBuf::from("/etc/x")))],
            ConflictPolicy::Replace,
        )
        .unwrap();
        assert!(mv.contains("mv -- '/a/x' '/etc/x'"));
        let rm = build_script(
            ElevatedOp::Delete,
            &[(PathBuf::from("/etc/x"), None)],
            ConflictPolicy::Replace,
        )
        .unwrap();
        assert!(rm.contains("rm -rf -- '/etc/x'"));
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
