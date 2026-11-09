//! shell-settings 점검 재현 테스트 — 디스크 설정 파일이 손상됐을 때 store 로드.
//!
//! `lib.rs::run()` 은 각 store 의 `load_default()` 결과에 `.expect(...)` 를 건다.
//! 따라서 `load_from` 이 Err 를 돌려주면 앱은 창을 띄우기 전에 panic 한다
//! (Windows 릴리스 빌드는 `windows_subsystem = "windows"` 라 콘솔도 없어 아무것도 안 보인다).
//! 아래 테스트는 "손상 파일이어도 로드는 성공해야 한다(기본값/살릴 수 있는 만큼)" 를 단언한다.

use duet_lib::services;
use std::path::Path;
use tempfile::tempdir;

fn write(p: &Path, s: &str) {
    std::fs::write(p, s).unwrap();
}

/// 사용자가 손으로 고친 keymap.toml 에 오타 하나 — 감시 기능이 직접 편집을 권장하는 파일.
#[tokio::test]
async fn keymap_typo_does_not_block_boot() {
    let d = tempdir().unwrap();
    let p = d.path().join("keymap.toml");
    write(
        &p,
        "[bindings]\n\"Ctrl+K\" = \"palette.open\"\n\"Ctrl+J = \"x\"\n",
    );
    assert!(
        services::keymap::KeymapStore::load_from(&p).await.is_ok(),
        "keymap.toml 문법 오류 → load Err → lib.rs .expect(\"keymap load\") panic"
    );
}

/// settings.toml 이 쓰다 만 상태(전원 차단·강제 종료) — 저장은 tokio::fs::write(비원자적).
#[tokio::test]
async fn truncated_settings_does_not_block_boot() {
    let d = tempdir().unwrap();
    let p = d.path().join("settings.toml");
    write(&p, "permanent_delete_enabled = false\ntheme = \"li");
    assert!(services::settings::SettingsStore::load_from(&p)
        .await
        .is_ok());
}

/// settings.toml 의 값 타입이 틀림(손편집) — 필드 하나 때문에 전체 부팅 실패.
#[tokio::test]
async fn wrong_type_settings_does_not_block_boot() {
    let d = tempdir().unwrap();
    let p = d.path().join("settings.toml");
    write(&p, "show_thumbnails = \"yes\"\n");
    assert!(services::settings::SettingsStore::load_from(&p)
        .await
        .is_ok());
}

#[tokio::test]
async fn truncated_bookmarks_does_not_block_boot() {
    let d = tempdir().unwrap();
    let p = d.path().join("bookmarks.json");
    write(&p, "[{\"id\":\"a\",\"name\":\"x\"");
    assert!(services::bookmarks::BookmarksStore::load_from(&p)
        .await
        .is_ok());
}

#[tokio::test]
async fn truncated_app_launchers_does_not_block_boot() {
    let d = tempdir().unwrap();
    let p = d.path().join("app-launchers.json");
    write(&p, "[{\"kind\":\"app\"");
    assert!(services::app_launchers::AppLaunchersStore::load_from(&p)
        .await
        .is_ok());
}

#[tokio::test]
async fn truncated_user_aliases_does_not_block_boot() {
    let d = tempdir().unwrap();
    let p = d.path().join("user-aliases.json");
    write(&p, "[{");
    assert!(services::user_aliases::UserAliasesStore::load_from(&p)
        .await
        .is_ok());
}

#[tokio::test]
async fn truncated_host_favorites_does_not_block_boot() {
    let d = tempdir().unwrap();
    let p = d.path().join("host-favorites.json");
    write(&p, "[{");
    assert!(services::host_favorites::HostFavoritesStore::load_from(&p)
        .await
        .is_ok());
}

#[tokio::test]
async fn truncated_host_groups_does_not_block_boot() {
    let d = tempdir().unwrap();
    let p = d.path().join("host-groups.json");
    write(&p, "[{");
    assert!(services::host_groups::HostGroupsStore::load_from(&p)
        .await
        .is_ok());
}

#[tokio::test]
async fn truncated_saved_hosts_does_not_block_boot() {
    let d = tempdir().unwrap();
    let p = d.path().join("saved-hosts.json");
    write(&p, "[{");
    assert!(services::saved_hosts::SavedHostsStore::load_from(&p)
        .await
        .is_ok());
}

/// journal.jsonl 마지막 줄이 쓰다 만 상태 — 앞의 정상 항목(undo 기록)은 살아야 한다.
#[tokio::test]
async fn journal_with_partial_last_line_does_not_block_boot() {
    let d = tempdir().unwrap();
    let p = d.path().join("journal.jsonl");
    let good = r#"{"type":"Push","id":"00000000-0000-0000-0000-000000000001","timestamp":"2026-01-01T00:00:00Z","op":{"kind":"copy","count":1,"src":{"source":{"kind":"local"},"path":"/a"},"dst":{"source":{"kind":"local"},"path":"/b"}},"undo":{"kind":"undo_copy","target_source":{"kind":"local"},"copied":["/b/x"],"backups_to_restore":[]},"undone":false}"#;
    write(&p, &format!("{good}\n{{\"type\":\"Push\",\"id\":\"0000"));
    let j = services::journal::Journal::load_from(&p).await;
    assert!(
        j.is_ok(),
        "마지막 줄 손상 → load Err → lib.rs .expect(\"journal load\") panic"
    );
}

/// 대조군: 캐시성 store 는 이미 손상을 무시한다(설계 의도 확인).
#[tokio::test]
async fn cache_stores_already_tolerate_corruption() {
    let d = tempdir().unwrap();
    let t = d.path().join("tags.json");
    write(&t, "{");
    assert!(services::tags::TagsStore::load_from(&t).await.is_ok());
    let f = d.path().join("frecency.json");
    write(&f, "[");
    assert!(services::frecency::FrecencyStore::load_from(&f)
        .await
        .is_ok());
    let n = d.path().join("host-nicknames.json");
    write(&n, "{");
    assert!(services::host_nicknames::HostNicknamesStore::load_from(&n)
        .await
        .is_ok());
}
