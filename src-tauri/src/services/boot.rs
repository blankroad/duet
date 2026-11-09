//! 앱 시작 때 저장 store 들을 한꺼번에 로드한다.
//!
//! 깨진 파일은 각 store 가 스스로 복구(옆으로 보존 + 기본값)하고 [`StartupNotice`] 를 남긴다.
//! 여기서는 그 알림을 모으고, 복구할 수 없는 오류(읽기 권한 없음, 설정 폴더 없음 등)는
//! 어느 저장소에서 났는지 붙여 [`BootError`] 로 돌려준다 — `lib.rs` 가 패닉 대신 오류 창을 띄운다.

use crate::services::{
    app_launchers::AppLaunchersStore, bookmarks::BookmarksStore, frecency::FrecencyStore,
    host_favorites::HostFavoritesStore, host_groups::HostGroupsStore,
    host_nicknames::HostNicknamesStore, journal::Journal, keymap::KeymapStore,
    saved_hosts::SavedHostsStore, secret_vault::SecretVault, settings::SettingsStore,
    startup_notices::StartupNotice, tags::TagsStore, user_aliases::UserAliasesStore,
};
use crate::types::DuetError;
use std::sync::Arc;

/// 시작 때 로드하는 저장 store 묶음.
pub struct BootStores {
    pub settings: Arc<SettingsStore>,
    pub journal: Arc<Journal>,
    pub saved_hosts: Arc<SavedHostsStore>,
    pub secret_vault: Arc<SecretVault>,
    pub bookmarks: Arc<BookmarksStore>,
    pub host_favorites: Arc<HostFavoritesStore>,
    pub host_groups: Arc<HostGroupsStore>,
    pub user_aliases: Arc<UserAliasesStore>,
    pub app_launchers: Arc<AppLaunchersStore>,
    pub keymap: Arc<KeymapStore>,
    pub frecency: Arc<FrecencyStore>,
    pub host_nicknames: Arc<HostNicknamesStore>,
    pub tags: Arc<TagsStore>,
}

/// 복구할 수 없는 시작 로드 오류 — 어느 저장소인지와 원인.
#[derive(Debug)]
pub struct BootError {
    pub store: &'static str,
    pub error: DuetError,
}

impl std::fmt::Display for BootError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.store, self.error)
    }
}

fn tag<T>(store: &'static str, r: Result<T, DuetError>) -> Result<T, BootError> {
    r.map_err(|error| BootError { store, error })
}

impl BootStores {
    /// 각 store 의 `load_default()` 로 `<config_dir>/duet` 에서 로드.
    pub async fn load_default() -> Result<Self, BootError> {
        Ok(Self {
            settings: tag("settings", SettingsStore::load_default().await)?,
            journal: tag("journal", Journal::load_default().await)?,
            saved_hosts: tag("saved hosts", SavedHostsStore::load_default().await)?,
            secret_vault: tag("secret vault", SecretVault::load_default().await)?,
            bookmarks: tag("bookmarks", BookmarksStore::load_default().await)?,
            host_favorites: tag("host favorites", HostFavoritesStore::load_default().await)?,
            host_groups: tag("host groups", HostGroupsStore::load_default().await)?,
            user_aliases: tag("user aliases", UserAliasesStore::load_default().await)?,
            app_launchers: tag("app launchers", AppLaunchersStore::load_default().await)?,
            keymap: tag("keymap", KeymapStore::load_default().await)?,
            frecency: tag("frecency", FrecencyStore::load_default().await)?,
            host_nicknames: tag("host nicknames", HostNicknamesStore::load_default().await)?,
            tags: tag("tags", TagsStore::load_default().await)?,
        })
    }

    /// 로드 중 복구한 내역 — 프론트가 시작 후 경고로 띄운다.
    pub fn notices(&self) -> Vec<StartupNotice> {
        [
            self.settings.load_notice(),
            self.journal.load_notice(),
            self.saved_hosts.load_notice(),
            self.secret_vault.load_notice(),
            self.bookmarks.load_notice(),
            self.host_favorites.load_notice(),
            self.host_groups.load_notice(),
            self.user_aliases.load_notice(),
            self.app_launchers.load_notice(),
            self.keymap.load_notice(),
            self.frecency.load_notice(),
            self.host_nicknames.load_notice(),
            self.tags.load_notice(),
        ]
        .into_iter()
        .flatten()
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::startup_notices::StartupNoticeKind;
    use std::path::Path;
    use tempfile::tempdir;

    /// 테스트용 — 한 폴더에서 로드(파일 이름은 각 store `load_default` 와 같게).
    async fn load_from_dir(dir: &Path) -> Result<BootStores, BootError> {
        Ok(BootStores {
            settings: tag(
                "settings",
                SettingsStore::load_from(&dir.join("settings.toml")).await,
            )?,
            journal: tag(
                "journal",
                Journal::load_from(&dir.join("journal.jsonl")).await,
            )?,
            saved_hosts: tag(
                "saved hosts",
                SavedHostsStore::load_from(&dir.join("saved-hosts.json")).await,
            )?,
            secret_vault: tag(
                "secret vault",
                SecretVault::load_from(&dir.join("secrets.age")).await,
            )?,
            bookmarks: tag(
                "bookmarks",
                BookmarksStore::load_from(&dir.join("bookmarks.json")).await,
            )?,
            host_favorites: tag(
                "host favorites",
                HostFavoritesStore::load_from(&dir.join("host-favorites.json")).await,
            )?,
            host_groups: tag(
                "host groups",
                HostGroupsStore::load_from(&dir.join("host-groups.json")).await,
            )?,
            user_aliases: tag(
                "user aliases",
                UserAliasesStore::load_from(&dir.join("user-aliases.json")).await,
            )?,
            app_launchers: tag(
                "app launchers",
                AppLaunchersStore::load_from(&dir.join("app-launchers.json")).await,
            )?,
            keymap: tag(
                "keymap",
                KeymapStore::load_from(&dir.join("keymap.toml")).await,
            )?,
            frecency: tag(
                "frecency",
                FrecencyStore::load_from(&dir.join("frecency.json")).await,
            )?,
            host_nicknames: tag(
                "host nicknames",
                HostNicknamesStore::load_from(&dir.join("host-nicknames.json")).await,
            )?,
            tags: tag("tags", TagsStore::load_from(&dir.join("tags.json")).await)?,
        })
    }

    #[tokio::test]
    async fn empty_dir_boots_without_notices() {
        let d = tempdir().unwrap();
        let s = load_from_dir(d.path()).await.unwrap();
        assert!(s.notices().is_empty());
    }

    #[tokio::test]
    async fn every_corrupt_file_boots_and_is_reported() {
        let d = tempdir().unwrap();
        for (name, text) in [
            ("settings.toml", "theme = \"li"),
            ("keymap.toml", "[bindings]\n\"Ctrl+J = \"x\"\n"),
            ("bookmarks.json", "[{"),
            ("host-favorites.json", "[{"),
            ("host-groups.json", "[{"),
            ("saved-hosts.json", "[{"),
            ("user-aliases.json", "[{"),
            ("app-launchers.json", "[{"),
            ("tags.json", "{"),
            ("host-nicknames.json", "{"),
            ("journal.jsonl", "{\"type\":\"Push\",\"id\":\"0"),
        ] {
            std::fs::write(d.path().join(name), text).unwrap();
        }
        let s = load_from_dir(d.path()).await.unwrap();
        let notices = s.notices();
        assert_eq!(notices.len(), 11, "{notices:#?}");
        let skipped = notices
            .iter()
            .filter(|n| matches!(n.action, StartupNoticeKind::SkippedLines { .. }))
            .count();
        assert_eq!(skipped, 1, "journal reports skipped lines");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_file_is_a_boot_error_naming_the_store() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempdir().unwrap();
        let p = d.path().join("bookmarks.json");
        std::fs::write(&p, "[]").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o000)).unwrap();
        // root 로 돌면 권한이 무시된다 — 그때는 이 검사를 건너뛴다.
        if std::fs::read(&p).is_ok() {
            return;
        }
        let err = load_from_dir(d.path()).await.err().expect("boot error");
        assert_eq!(err.store, "bookmarks");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}
