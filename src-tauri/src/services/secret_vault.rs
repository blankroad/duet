//! 마스터 비밀번호로 암호화된 비밀 저장소.
//!
//! 파일: `<config_dir>/duet/secrets.age` — age passphrase 포맷
//! (scrypt → ChaCha20-Poly1305). 내부 페이로드는 JSON `{alias: password}`.
//!
//! 상태 머신:
//! - Empty: 파일 없음 → set 시 master 생성 (frontend 가 master 받아 전달)
//! - Locked: 파일 있음, master 미입력 → unlock 만 가능
//! - Unlocked: master 메모리에 캐시 + decrypted map 캐시 → set/get/remove 자유
//!
//! CLAUDE.md §5 — master 와 평문 password 는 메모리에만, log 출력 금지.

use crate::services::settings::duet_config_dir;
use crate::types::DuetError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// vault 의 disk + memory 상태.
struct VaultInner {
    /// 메모리 캐시. None = locked.
    map: Option<HashMap<String, String>>,
    /// 캐시된 master passphrase (re-encrypt 시 사용). None = locked.
    master: Option<String>,
}

/// 마스터 비밀번호로 보호되는 age 암호화 비밀 저장소.
pub struct SecretVault {
    path: PathBuf,
    inner: RwLock<VaultInner>,
}

impl SecretVault {
    /// `<config_dir>/duet/secrets.age` 기본 경로로 로드.
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("secrets.age");
        Self::load_from(&path).await
    }

    /// 지정 경로로 로드 (테스트용).
    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(VaultInner {
                map: None,
                master: None,
            }),
        }))
    }

    /// disk 에 vault 파일 존재?
    pub async fn exists(&self) -> bool {
        tokio::fs::try_exists(&self.path).await.unwrap_or(false)
    }

    /// 메모리에 unlocked 상태?
    pub async fn is_unlocked(&self) -> bool {
        self.inner.read().await.map.is_some()
    }

    /// passphrase 로 vault 복호화 + memory cache.
    /// vault 가 없으면 빈 map 으로 초기화 (master 만 등록 — 다음 set 시 flush).
    pub async fn unlock(&self, passphrase: String) -> Result<(), DuetError> {
        let map = if self.exists().await {
            let bytes = tokio::fs::read(&self.path).await.map_err(DuetError::from)?;
            decrypt_passphrase(&bytes, &passphrase)?
        } else {
            HashMap::new()
        };
        let mut inner = self.inner.write().await;
        inner.map = Some(map);
        inner.master = Some(passphrase);
        Ok(())
    }

    /// 메모리 + master clear. disk 파일은 그대로.
    pub async fn lock(&self) {
        let mut inner = self.inner.write().await;
        inner.map = None;
        // 명시적으로 zero-out 후 drop — best-effort zeroize.
        // Rust 의 String drop 은 메모리 reuse 가능 — 강한 보장 X.
        // 강한 보장 필요하면 secrecy crate 추가 (후속).
        if let Some(mut m) = inner.master.take() {
            // SAFETY: platform/unsafe 외 허용 예외 — String 바이트 직접 zeroize.
            // 안전 조건: m 은 이 스코프 내에서만 접근되며, 바이트 변이 후 즉시 drop.
            unsafe {
                let bytes = m.as_bytes_mut();
                for b in bytes {
                    *b = 0;
                }
            }
            drop(m);
        }
    }

    /// alias 로 저장된 비밀번호 조회. Locked 상태면 Err.
    pub async fn get(&self, alias: &str) -> Result<Option<String>, DuetError> {
        let inner = self.inner.read().await;
        let map = inner
            .map
            .as_ref()
            .ok_or_else(|| DuetError::Io("vault locked".into()))?;
        Ok(map.get(alias).cloned())
    }

    /// alias 에 비밀번호 저장 후 disk flush. Locked 상태면 Err.
    pub async fn set(&self, alias: String, password: String) -> Result<(), DuetError> {
        if alias.trim().is_empty() {
            return Err(DuetError::Io("alias required".into()));
        }
        let mut inner = self.inner.write().await;
        let master = inner
            .master
            .clone()
            .ok_or_else(|| DuetError::Io("vault locked".into()))?;
        let map = inner
            .map
            .as_mut()
            .ok_or_else(|| DuetError::Io("vault locked".into()))?;
        map.insert(alias, password);
        let snapshot = map.clone();
        drop(inner);
        self.flush(&snapshot, &master).await
    }

    /// alias 에 해당하는 항목 제거 후 disk flush. Locked 상태면 Err.
    pub async fn remove(&self, alias: &str) -> Result<(), DuetError> {
        let mut inner = self.inner.write().await;
        let master = inner
            .master
            .clone()
            .ok_or_else(|| DuetError::Io("vault locked".into()))?;
        let map = inner
            .map
            .as_mut()
            .ok_or_else(|| DuetError::Io("vault locked".into()))?;
        map.remove(alias);
        let snapshot = map.clone();
        drop(inner);
        self.flush(&snapshot, &master).await
    }

    /// JSON 직렬화 + age passphrase encrypt + atomic write.
    async fn flush(
        &self,
        map: &HashMap<String, String>,
        passphrase: &str,
    ) -> Result<(), DuetError> {
        let json =
            serde_json::to_vec(map).map_err(|e| DuetError::Io(format!("vault serialize: {e}")))?;
        let encrypted = encrypt_passphrase(&json, passphrase)?;
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        // atomic write — tmp + rename
        let tmp = self.path.with_extension("age.tmp");
        tokio::fs::write(&tmp, encrypted)
            .await
            .map_err(DuetError::from)?;
        tokio::fs::rename(&tmp, &self.path)
            .await
            .map_err(DuetError::from)?;
        Ok(())
    }
}

/// age passphrase 모드 encrypt — scrypt + ChaCha20-Poly1305.
fn encrypt_passphrase(plaintext: &[u8], passphrase: &str) -> Result<Vec<u8>, DuetError> {
    use age::secrecy::SecretString;
    use std::io::Write;
    let pass = SecretString::from(passphrase.to_owned());
    let encryptor = age::Encryptor::with_user_passphrase(pass);
    let mut encrypted = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut encrypted)
        .map_err(|e| DuetError::Io(format!("vault encrypt init: {e}")))?;
    writer
        .write_all(plaintext)
        .map_err(|e| DuetError::Io(format!("vault encrypt write: {e}")))?;
    writer
        .finish()
        .map_err(|e| DuetError::Io(format!("vault encrypt finish: {e}")))?;
    Ok(encrypted)
}

/// age passphrase 모드 decrypt. 잘못된 passphrase → Err.
fn decrypt_passphrase(
    encrypted: &[u8],
    passphrase: &str,
) -> Result<HashMap<String, String>, DuetError> {
    use age::secrecy::SecretString;
    use std::io::Read;
    let pass = SecretString::from(passphrase.to_owned());
    let decryptor = age::Decryptor::new(encrypted)
        .map_err(|e| DuetError::Io(format!("vault decrypt parse: {e}")))?;
    let identity = age::scrypt::Identity::new(pass);
    let mut reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|e| DuetError::Io(format!("vault decrypt: {e}")))?;
    let mut plaintext = Vec::new();
    reader
        .read_to_end(&mut plaintext)
        .map_err(|e| DuetError::Io(format!("vault decrypt read: {e}")))?;
    serde_json::from_slice::<HashMap<String, String>>(&plaintext)
        .map_err(|e| DuetError::Io(format!("vault json parse: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn empty_vault_unlocks_with_any_master() {
        let dir = tempdir().unwrap();
        let v = SecretVault::load_from(&dir.path().join("v.age"))
            .await
            .unwrap();
        assert!(!v.exists().await);
        v.unlock("anything".into()).await.unwrap();
        assert!(v.is_unlocked().await);
        assert_eq!(v.get("x").await.unwrap(), None);
    }

    #[tokio::test]
    async fn set_get_roundtrip_after_reload() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.age");
        let v = SecretVault::load_from(&path).await.unwrap();
        v.unlock("pw1".into()).await.unwrap();
        v.set("alpha".into(), "secret-alpha".into()).await.unwrap();
        v.set("beta".into(), "secret-beta".into()).await.unwrap();

        // reload + unlock
        let v2 = SecretVault::load_from(&path).await.unwrap();
        v2.unlock("pw1".into()).await.unwrap();
        assert_eq!(
            v2.get("alpha").await.unwrap().as_deref(),
            Some("secret-alpha")
        );
        assert_eq!(
            v2.get("beta").await.unwrap().as_deref(),
            Some("secret-beta")
        );
    }

    #[tokio::test]
    async fn wrong_passphrase_fails() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.age");
        let v = SecretVault::load_from(&path).await.unwrap();
        v.unlock("correct".into()).await.unwrap();
        v.set("k".into(), "p".into()).await.unwrap();

        let v2 = SecretVault::load_from(&path).await.unwrap();
        assert!(v2.unlock("wrong".into()).await.is_err());
    }

    #[tokio::test]
    async fn locked_get_set_fail() {
        let dir = tempdir().unwrap();
        let v = SecretVault::load_from(&dir.path().join("v.age"))
            .await
            .unwrap();
        // 미unlock
        assert!(v.get("x").await.is_err());
        assert!(v.set("x".into(), "y".into()).await.is_err());
    }

    #[tokio::test]
    async fn remove_persists() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.age");
        let v = SecretVault::load_from(&path).await.unwrap();
        v.unlock("m".into()).await.unwrap();
        v.set("a".into(), "1".into()).await.unwrap();
        v.set("b".into(), "2".into()).await.unwrap();
        v.remove("a").await.unwrap();

        let v2 = SecretVault::load_from(&path).await.unwrap();
        v2.unlock("m".into()).await.unwrap();
        assert!(v2.get("a").await.unwrap().is_none());
        assert_eq!(v2.get("b").await.unwrap().as_deref(), Some("2"));
    }

    #[tokio::test]
    async fn lock_clears_memory() {
        let dir = tempdir().unwrap();
        let v = SecretVault::load_from(&dir.path().join("v.age"))
            .await
            .unwrap();
        v.unlock("m".into()).await.unwrap();
        assert!(v.is_unlocked().await);
        v.lock().await;
        assert!(!v.is_unlocked().await);
        assert!(v.get("any").await.is_err());
    }
}
