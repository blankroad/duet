//! Secret vault IPC — master password 기반 비밀 저장소.

use std::sync::Arc;

use crate::services::secret_vault::SecretVault;
use crate::types::DuetError;
use serde::Serialize;
use specta::Type;

/// vault 의 현재 상태 (존재 여부 + unlock 여부).
#[derive(Debug, Clone, Serialize, Type)]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
}

/// vault 파일 존재 여부와 unlock 상태를 반환한다.
#[tauri::command]
#[specta::specta]
pub async fn vault_status(
    vault: tauri::State<'_, Arc<SecretVault>>,
) -> Result<VaultStatus, DuetError> {
    Ok(VaultStatus {
        exists: vault.exists().await,
        unlocked: vault.is_unlocked().await,
    })
}

/// passphrase 로 vault 를 unlock 한다. 파일이 없으면 빈 vault 로 초기화.
#[tauri::command]
#[specta::specta]
pub async fn vault_unlock(
    passphrase: String,
    vault: tauri::State<'_, Arc<SecretVault>>,
) -> Result<(), DuetError> {
    vault.unlock(passphrase).await
}

/// vault 를 lock (메모리 캐시 + master clear).
#[tauri::command]
#[specta::specta]
pub async fn vault_lock(vault: tauri::State<'_, Arc<SecretVault>>) -> Result<(), DuetError> {
    vault.lock().await;
    Ok(())
}

/// alias 에 저장된 비밀번호가 **있는지만** 반환한다(평문 노출 없음, §5 2026-07).
/// 저장된 비번의 실제 재사용은 backend 가 접속 command 안에서 vault 에서 직접 꺼내 쓴다 —
/// 평문을 프론트로 되돌리지 않는다.
#[tauri::command]
#[specta::specta]
pub async fn vault_has(
    alias: String,
    vault: tauri::State<'_, Arc<SecretVault>>,
) -> Result<bool, DuetError> {
    Ok(vault.has(&alias).await)
}

/// alias 에 비밀번호를 저장하고 disk 에 flush. Locked 이면 Err.
#[tauri::command]
#[specta::specta]
pub async fn vault_set(
    alias: String,
    password: String,
    vault: tauri::State<'_, Arc<SecretVault>>,
) -> Result<(), DuetError> {
    vault.set(alias, password).await
}

/// alias 항목을 삭제하고 disk 에 flush. Locked 이면 Err.
#[tauri::command]
#[specta::specta]
pub async fn vault_remove(
    alias: String,
    vault: tauri::State<'_, Arc<SecretVault>>,
) -> Result<(), DuetError> {
    vault.remove(&alias).await
}
