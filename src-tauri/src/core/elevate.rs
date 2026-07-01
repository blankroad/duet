//! UAC 승격 복사 — Windows 보호 폴더(Program Files 등) 쓰기.
//!
//! 설계: `docs/specs/2026-07-01-uac-elevated-copy.md`. **정식 UAC 경로만** 사용
//! (멀웨어식 IFileOperation 자동승격 아님). 부모(비승격)가 manifest(작업 명세)를 파일로
//! 쓰고 그 SHA-256 을 커맨드라인으로 넘겨 `platform::spawn_runas` 로 duet.exe 재실행.
//! 승격된 자식(`--elevated-op`)이 해시를 검증(launch 후 변조 차단)하고 op(copy/move/
//! trash/delete) 수행 후 결과 파일 기록. 로컬→로컬, undo 없음(§4 audit journal 만).

use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// manifest 충돌 정책 (FE 에서 이미 해소된 사용자 선택).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ElevatedConflict {
    Overwrite,
    Skip,
    KeepBoth,
}

/// 승격 작업 종류 (화이트리스트). Trash=OS 휴지통, Delete=영구 rm(사용자 영구삭제
/// 게이트 통과분만).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ElevatedOp {
    Copy,
    Move,
    Trash,
    Delete,
}

/// 작업 한 항목 (절대경로). `dst` 는 copy/move 만 사용, trash/delete 는 None.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElevatedItem {
    pub src: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dst: Option<PathBuf>,
}

/// 승격 자식에게 넘기는 작업 명세.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElevatedManifest {
    pub version: u32,
    pub op: ElevatedOp,
    pub conflict: ElevatedConflict,
    pub items: Vec<ElevatedItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElevatedResultItem {
    pub dst: PathBuf,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ElevatedResult {
    pub items: Vec<ElevatedResultItem>,
}

/// 부모→FE 결과 요약.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ElevatedOutcome {
    /// 성공 항목 수.
    pub ok: u32,
    /// 실패 항목 ("dst — error").
    pub failed: Vec<String>,
    /// 사용자가 UAC 를 거부함.
    pub cancelled: bool,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// 승격 작업용 임시 디렉토리 — 현재 사용자만 쓰는 LOCALAPPDATA 하위 (§2.3).
fn elevated_dir() -> Result<PathBuf, DuetError> {
    let base =
        dirs::data_local_dir().ok_or_else(|| DuetError::Io("no local app data dir".into()))?;
    let dir = base.join("duet").join("elevated");
    std::fs::create_dir_all(&dir).map_err(DuetError::from)?;
    Ok(dir)
}

/// **부모(비승격)**: 승격 op(copy/move/trash/delete) 실행. UAC 창 → 자식 실행 → 결과 요약.
/// blocking(프로세스 대기) 이므로 `spawn_blocking` 안에서 호출할 것.
pub fn run_elevated_op(
    op: ElevatedOp,
    items: Vec<ElevatedItem>,
    conflict: ElevatedConflict,
) -> Result<ElevatedOutcome, DuetError> {
    if items.is_empty() {
        return Err(DuetError::Io("no items".into()));
    }
    let exe = std::env::current_exe().map_err(|e| DuetError::Io(format!("current_exe: {e}")))?;
    let dir = elevated_dir()?;
    let token = uuid::Uuid::new_v4().to_string();
    let manifest_path = dir.join(format!("{token}.json"));
    let result_path = dir.join(format!("{token}.result.json"));

    let manifest = ElevatedManifest {
        version: 1,
        op,
        conflict,
        items,
    };
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| DuetError::Io(format!("manifest encode: {e}")))?;
    std::fs::write(&manifest_path, &bytes).map_err(DuetError::from)?;
    let hash = sha256_hex(&bytes);

    // 경로는 공백 포함 가능 → 인용. 해시는 hex 라 인용 불필요.
    let args = format!(
        "--elevated-op \"{}\" --manifest-sha256 {hash}",
        manifest_path.display()
    );

    let spawn = crate::platform::spawn_runas(&exe, &args);
    let _ = std::fs::remove_file(&manifest_path); // 성패 무관 정리(짧은 수명)

    let exit = match spawn {
        Ok(None) => {
            let _ = std::fs::remove_file(&result_path);
            return Ok(ElevatedOutcome {
                ok: 0,
                failed: Vec::new(),
                cancelled: true,
            });
        }
        Ok(Some(code)) => code,
        Err(e) => {
            let _ = std::fs::remove_file(&result_path);
            return Err(e);
        }
    };

    let outcome = match std::fs::read(&result_path) {
        Ok(rb) => {
            let res: ElevatedResult = serde_json::from_slice(&rb)
                .map_err(|e| DuetError::Io(format!("result decode: {e}")))?;
            let mut ok = 0u32;
            let mut failed = Vec::new();
            for it in res.items {
                if it.ok {
                    ok += 1;
                } else {
                    failed.push(format!(
                        "{} — {}",
                        it.dst.display(),
                        it.error.unwrap_or_default()
                    ));
                }
            }
            ElevatedOutcome {
                ok,
                failed,
                cancelled: false,
            }
        }
        Err(_) => {
            return Err(DuetError::Io(format!(
                "elevated op failed (exit {exit}, no result)"
            )));
        }
    };
    let _ = std::fs::remove_file(&result_path);
    Ok(outcome)
}

/// **자식(승격, `--elevated-op`)**: manifest 검증 후 복사, 결과 기록. 반환=프로세스 종료코드.
pub fn execute_child(manifest_path: &Path, expected_hash: &str) -> i32 {
    let result_path = manifest_path.with_extension("result.json");
    let bytes = match std::fs::read(manifest_path) {
        Ok(b) => b,
        Err(_) => return 3,
    };
    // ★ 무결성(§2.3): launch 후 manifest 변조를 커맨드라인 해시로 탐지.
    if sha256_hex(&bytes) != expected_hash {
        let _ = write_result(
            &result_path,
            &ElevatedResult {
                items: vec![ElevatedResultItem {
                    dst: manifest_path.to_path_buf(),
                    ok: false,
                    error: Some("integrity check failed".into()),
                }],
            },
        );
        return 2;
    }
    let manifest: ElevatedManifest = match serde_json::from_slice(&bytes) {
        Ok(m) => m,
        Err(_) => return 3,
    };
    // op 화이트리스트는 enum 역직렬화가 강제(알 수 없는 op → from_slice 실패 → return 3).
    let mut items_res = Vec::new();
    let mut all_ok = true;
    for it in &manifest.items {
        // 결과 보고용 대상 경로 — copy/move 는 dst, trash/delete 는 src.
        let target = it.dst.clone().unwrap_or_else(|| it.src.clone());
        let need_dst = |label: &str| it.dst.as_ref().ok_or_else(|| format!("{label} needs dst"));
        let r = match manifest.op {
            ElevatedOp::Copy => {
                need_dst("copy").and_then(|d| copy_one(&it.src, d, manifest.conflict))
            }
            ElevatedOp::Move => {
                need_dst("move").and_then(|d| move_one(&it.src, d, manifest.conflict))
            }
            ElevatedOp::Trash => trash_one(&it.src),
            ElevatedOp::Delete => delete_one(&it.src),
        };
        match r {
            Ok(()) => items_res.push(ElevatedResultItem {
                dst: target,
                ok: true,
                error: None,
            }),
            Err(e) => {
                all_ok = false;
                items_res.push(ElevatedResultItem {
                    dst: target,
                    ok: false,
                    error: Some(e),
                });
            }
        }
    }
    let _ = write_result(&result_path, &ElevatedResult { items: items_res });
    if all_ok {
        0
    } else {
        1
    }
}

fn write_result(path: &Path, res: &ElevatedResult) -> std::io::Result<()> {
    let b = serde_json::to_vec(res).map_err(std::io::Error::other)?;
    std::fs::write(path, b)
}

/// 한 항목 복사(파일/디렉토리) + 충돌 정책. 에러는 문자열.
///
/// Overwrite 는 §4(2026-06) 예외 패턴 — 기존을 임시백업으로 rename → 복사 → 성공 시
/// 백업 영구삭제(undo 없음) / 실패 시 롤백(원본 복원). 실패 안전.
fn copy_one(src: &Path, dst: &Path, conflict: ElevatedConflict) -> Result<(), String> {
    if dst.exists() {
        match conflict {
            ElevatedConflict::Skip => return Ok(()),
            ElevatedConflict::KeepBoth => {
                let target = unique_path(dst);
                return do_copy(src, &target).map_err(|e| e.to_string());
            }
            ElevatedConflict::Overwrite => {
                let bak = backup_temp_path(dst);
                std::fs::rename(dst, &bak).map_err(|e| e.to_string())?;
                return match do_copy(src, dst) {
                    Ok(()) => {
                        let _ = remove_path(&bak); // §4 예외: 백업 영구삭제
                        Ok(())
                    }
                    Err(e) => {
                        let _ = std::fs::rename(&bak, dst); // 롤백
                        Err(e.to_string())
                    }
                };
            }
        }
    }
    do_copy(src, dst).map_err(|e| e.to_string())
}

/// 이동 = 복사(충돌 정책 적용) 후 원본 제거. Skip 이면 원본 유지(둘 다 남김).
fn move_one(src: &Path, dst: &Path, conflict: ElevatedConflict) -> Result<(), String> {
    if matches!(conflict, ElevatedConflict::Skip) && dst.exists() {
        return Ok(()); // skip — 원본 유지
    }
    copy_one(src, dst, conflict)?;
    remove_path(src).map_err(|e| e.to_string())
}

/// OS 휴지통으로 이동 (복구 가능). 승격 프로세스라 보호 경로 파일도 가능.
fn trash_one(src: &Path) -> Result<(), String> {
    trash::delete(src).map_err(|e| e.to_string())
}

/// 영구 삭제 (rm) — 커맨드에서 영구삭제 게이트(모드+단어타이핑)를 이미 통과한 항목만.
fn delete_one(src: &Path) -> Result<(), String> {
    remove_path(src).map_err(|e| e.to_string())
}

/// 파일/디렉토리 복사(부모 디렉토리 보장). dst 는 미존재(또는 Overwrite 로 비워진) 상태.
fn do_copy(src: &Path, dst: &Path) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::symlink_metadata(src)?.is_dir() {
        copy_dir_recursive(src, dst)
    } else {
        std::fs::copy(src, dst).map(|_| ())
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let from = e.path();
        let to = dst.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn remove_path(p: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(p)?.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    }
}

/// `<dst>.duet-elevbak` — Overwrite 임시백업 경로. 이미 있으면 숫자 suffix.
fn backup_temp_path(dst: &Path) -> PathBuf {
    let base = format!("{}.duet-elevbak", dst.to_string_lossy());
    let cand = PathBuf::from(&base);
    if !cand.exists() {
        return cand;
    }
    for n in 1..10000 {
        let c = PathBuf::from(format!("{base}.{n}"));
        if !c.exists() {
            return c;
        }
    }
    cand
}

/// `name (1).ext` 식 유니크 이름 (KeepBoth).
fn unique_path(dst: &Path) -> PathBuf {
    let parent = dst.parent().unwrap_or_else(|| Path::new("."));
    let stem = dst
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = dst
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for n in 1..10000 {
        let cand = parent.join(format!("{stem} ({n}){ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    dst.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_hash_roundtrip_and_tamper_detect() {
        let m = ElevatedManifest {
            version: 1,
            op: ElevatedOp::Copy,
            conflict: ElevatedConflict::Overwrite,
            items: vec![ElevatedItem {
                src: PathBuf::from("/a/x.txt"),
                dst: Some(PathBuf::from("/b/x.txt")),
            }],
        };
        let bytes = serde_json::to_vec(&m).unwrap();
        let h = sha256_hex(&bytes);
        assert_eq!(sha256_hex(&bytes), h, "동일 입력 동일 해시");
        // 1바이트 변조 → 해시 불일치 (무결성 탐지).
        let mut tampered = bytes.clone();
        *tampered.last_mut().unwrap() ^= 0x01;
        assert_ne!(sha256_hex(&tampered), h);
        // 라운드트립.
        let back: ElevatedManifest = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.op, ElevatedOp::Copy);
        assert_eq!(back.conflict, ElevatedConflict::Overwrite);
    }

    #[test]
    fn conflict_serde_lowercase() {
        assert_eq!(
            serde_json::to_string(&ElevatedConflict::KeepBoth).unwrap(),
            "\"keepboth\""
        );
    }

    #[test]
    fn copy_file_and_conflict_policies() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src.txt");
        std::fs::write(&src, b"hello").unwrap();
        let dst = tmp.path().join("out.txt");

        // 신규 복사.
        copy_one(&src, &dst, ElevatedConflict::Overwrite).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"hello");

        // Skip — 기존 유지.
        std::fs::write(&src, b"changed").unwrap();
        copy_one(&src, &dst, ElevatedConflict::Skip).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"hello");

        // Overwrite — 교체 + 백업 정리.
        copy_one(&src, &dst, ElevatedConflict::Overwrite).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"changed");
        assert!(!dst.with_file_name("out.txt.duet-elevbak").exists());

        // KeepBoth — 새 이름.
        copy_one(&src, &dst, ElevatedConflict::KeepBoth).unwrap();
        assert!(tmp.path().join("out (1).txt").exists());
    }
}
