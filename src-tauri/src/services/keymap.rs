//! 키 → command id 매핑. `<config_dir>/duet/keymap.toml`.
//!
//! TOML 형식:
//! ```toml
//! [bindings]
//! "Ctrl+T" = "tab.new"
//! "Ctrl+W" = "tab.close"
//! ```

use crate::fs::persist;
use crate::services::settings::duet_config_dir;
use crate::services::startup_notices::StartupNotice;
use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct KeymapBinding {
    pub key: String,
    pub command_id: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct KeymapToml {
    #[serde(default)]
    bindings: BTreeMap<String, String>,
}

pub struct KeymapStore {
    path: PathBuf,
    inner: RwLock<Vec<KeymapBinding>>,
    /// 시작 로드 때 깨진 파일을 옆으로 옮기고 빈 키맵으로 시작했으면 그 내역.
    load_notice: Option<StartupNotice>,
}

impl KeymapStore {
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("keymap.toml");
        Self::load_from(&path).await
    }

    /// 시작 로드. 문법 오류 등으로 못 읽으면 `keymap.toml.corrupt-<시각>` 으로 옮겨 보존하고
    /// 빈 키맵(기본 키)으로 시작한다(shell-settings-01) — [`Self::load_notice`] 로 알린다.
    /// 실행 중 재읽기([`read_file`])는 파일을 옮기지 않는다(사용자가 편집 중일 수 있음).
    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let loaded = persist::load_or_quarantine(path, parse_keymap, Vec::new).await?;
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(loaded.value),
            load_notice: loaded.quarantined.as_ref().map(StartupNotice::from),
        }))
    }

    /// 시작 로드 때 깨진 파일을 격리했으면 그 알림. 정상이면 `None`.
    pub fn load_notice(&self) -> Option<StartupNotice> {
        self.load_notice.clone()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn list(&self) -> Vec<KeymapBinding> {
        self.inner.read().await.clone()
    }

    /// 외부 source (file watcher) 가 호출 — 지금 값과 다르면 통째로 교체하고 `true`.
    /// 비교와 교체를 한 잠금 안에서 한다. 앱 자신의 저장이 일으킨 변경 알림은 같은 값이라 `false`.
    pub async fn replace_if_changed(&self, bindings: Vec<KeymapBinding>) -> bool {
        let mut v = self.inner.write().await;
        if same_bindings(&v, &bindings) {
            return false;
        }
        *v = bindings;
        true
    }

    pub async fn set(
        &self,
        key: String,
        command_id: String,
    ) -> Result<Vec<KeymapBinding>, DuetError> {
        if key.trim().is_empty() {
            return Err(DuetError::Io("key required".into()));
        }
        // 사본에 바꿔 저장 → 성공해야 메모리 교체(shell-settings-02). 잠금을 쥔 채 저장.
        let mut v = self.inner.write().await;
        let mut next = v.clone();
        if let Some(existing) = next.iter_mut().find(|b| b.key == key) {
            existing.command_id = command_id;
        } else {
            next.push(KeymapBinding { key, command_id });
        }
        write_file(&self.path, &next).await?;
        *v = next.clone();
        Ok(next)
    }

    pub async fn unset(&self, key: &str) -> Result<Vec<KeymapBinding>, DuetError> {
        let mut v = self.inner.write().await;
        let mut next = v.clone();
        next.retain(|b| b.key != key);
        write_file(&self.path, &next).await?;
        *v = next.clone();
        Ok(next)
    }

    pub async fn reset(&self) -> Result<Vec<KeymapBinding>, DuetError> {
        let mut v = self.inner.write().await;
        write_file(&self.path, &[]).await?;
        v.clear();
        Ok(Vec::new())
    }
}

/// 파일을 그대로 다시 읽는다(watcher 용). 못 읽으면 `Err` — 파일은 건드리지 않는다.
pub async fn read_file(path: &Path) -> Result<Vec<KeymapBinding>, DuetError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = tokio::fs::read_to_string(path)
        .await
        .map_err(DuetError::from)?;
    parse_keymap(&text).map_err(DuetError::Io)
}

/// keymap.toml 본문 해석. 빈 파일은 빈 키맵.
fn parse_keymap(text: &str) -> Result<Vec<KeymapBinding>, String> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed: KeymapToml = toml::from_str(text).map_err(|e| format!("keymap parse: {e}"))?;
    Ok(parsed
        .bindings
        .into_iter()
        .map(|(key, command_id)| KeymapBinding { key, command_id })
        .collect())
}

/// 같은 키 설정인지 — 순서는 무시(파일은 키 순, 메모리는 추가 순). 키는 양쪽 다 유일하다.
pub fn same_bindings(a: &[KeymapBinding], b: &[KeymapBinding]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let sorted = |v: &[KeymapBinding]| {
        let mut v = v.to_vec();
        v.sort_by(|x, y| x.key.cmp(&y.key));
        v
    };
    sorted(a) == sorted(b)
}

/// 원자적 저장(같은 폴더 임시 파일 → rename) — 쓰는 도중 끊겨도, watcher 가 중간에 읽어도
/// 잘린 파일이 보이지 않는다(shell-settings-18).
async fn write_file(path: &Path, items: &[KeymapBinding]) -> Result<(), DuetError> {
    let mut bindings = BTreeMap::new();
    for b in items {
        bindings.insert(b.key.clone(), b.command_id.clone());
    }
    let toml_doc = KeymapToml { bindings };
    let text = toml::to_string_pretty(&toml_doc)
        .map_err(|e| DuetError::Io(format!("keymap serialize: {e}")))?;
    persist::write_atomic(path, text.as_bytes()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn empty_file_returns_empty() {
        let dir = tempdir().unwrap();
        let s = KeymapStore::load_from(&dir.path().join("k.toml"))
            .await
            .unwrap();
        assert!(s.list().await.is_empty());
    }

    #[tokio::test]
    async fn set_and_unset() {
        let dir = tempdir().unwrap();
        let s = KeymapStore::load_from(&dir.path().join("k.toml"))
            .await
            .unwrap();
        s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        s.set("Ctrl+W".into(), "tab.close".into()).await.unwrap();
        assert_eq!(s.list().await.len(), 2);
        s.unset("Ctrl+T").await.unwrap();
        assert_eq!(s.list().await.len(), 1);
    }

    #[tokio::test]
    async fn set_same_key_replaces() {
        let dir = tempdir().unwrap();
        let s = KeymapStore::load_from(&dir.path().join("k.toml"))
            .await
            .unwrap();
        s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        s.set("Ctrl+T".into(), "tab.close".into()).await.unwrap();
        let list = s.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].command_id, "tab.close");
    }

    #[tokio::test]
    async fn reset_clears_all() {
        let dir = tempdir().unwrap();
        let s = KeymapStore::load_from(&dir.path().join("k.toml"))
            .await
            .unwrap();
        s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        s.reset().await.unwrap();
        assert!(s.list().await.is_empty());
    }

    fn b(key: &str, cmd: &str) -> KeymapBinding {
        KeymapBinding {
            key: key.into(),
            command_id: cmd.into(),
        }
    }

    #[test]
    fn same_bindings_ignores_order() {
        let x = vec![b("Ctrl+W", "tab.close"), b("Ctrl+A", "select.all")];
        let y = vec![b("Ctrl+A", "select.all"), b("Ctrl+W", "tab.close")];
        assert!(same_bindings(&x, &y));
        assert!(!same_bindings(&x, &y[..1]));
        assert!(!same_bindings(
            &x,
            &[b("Ctrl+A", "x"), b("Ctrl+W", "tab.close")]
        ));
        assert!(same_bindings(&[], &[]));
    }

    #[tokio::test]
    async fn replace_if_changed_applies_external_clear_from_start() {
        // shell-settings-18: 시작 후 첫 외부 편집이 "전부 비우기" 여도 반영돼야 한다.
        let dir = tempdir().unwrap();
        let path = dir.path().join("k.toml");
        std::fs::write(&path, "[bindings]\n\"Ctrl+T\" = \"tab.new\"\n").unwrap();
        let s = KeymapStore::load_from(&path).await.unwrap();
        assert!(s.replace_if_changed(Vec::new()).await);
        assert!(s.list().await.is_empty());
        assert!(!s.replace_if_changed(Vec::new()).await);
    }

    #[tokio::test]
    async fn own_save_is_not_seen_as_external_change() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("k.toml");
        let s = KeymapStore::load_from(&path).await.unwrap();
        s.set("Ctrl+W".into(), "tab.close".into()).await.unwrap();
        s.set("Ctrl+A".into(), "select.all".into()).await.unwrap();
        // watcher 가 다시 읽은 값(키 순)은 메모리(추가 순)와 같은 설정이다.
        let reread = read_file(&path).await.unwrap();
        assert!(!s.replace_if_changed(reread).await);
    }

    #[tokio::test]
    async fn failed_unset_and_reset_keep_memory() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("k.toml");
        let s = KeymapStore::load_from(&path).await.unwrap();
        let before = s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        // 대상 자리를 폴더로 막아 rename 을 실패시킨다.
        std::fs::rename(&path, dir.path().join("moved")).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(s.unset("Ctrl+T").await.is_err());
        assert!(s.reset().await.is_err());
        assert_eq!(s.list().await, before);
    }

    #[tokio::test]
    async fn corrupt_file_at_start_is_moved_aside() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("k.toml");
        let text = "[bindings\n\"Ctrl+T\" = \"tab.new\"";
        std::fs::write(&path, text).unwrap();
        let s = KeymapStore::load_from(&path).await.unwrap();
        assert!(s.list().await.is_empty());
        let notice = s.load_notice().expect("notice");
        let crate::services::startup_notices::StartupNoticeKind::Reset { backup } = notice.action
        else {
            panic!("expected Reset");
        };
        assert_eq!(std::fs::read_to_string(backup).unwrap(), text);
        assert!(notice.detail.contains("keymap parse"));
    }

    #[tokio::test]
    async fn roundtrip_persists() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("k.toml");
        let s = KeymapStore::load_from(&path).await.unwrap();
        s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        let s2 = KeymapStore::load_from(&path).await.unwrap();
        let list = s2.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].key, "Ctrl+T");
        assert_eq!(list[0].command_id, "tab.new");
    }
}
