//! SSH 통합 — `SshFilenameSearch` (MVP-5 원격 `find -iname`).
//!
//! 게이트: `DUET_SSH_IT=1` + `#[ignore]`. 실행은 `scripts/ssh-it.sh`.

mod ssh_common;

use duet_lib::core::search::{SearchBackend, SearchOpts, SshFilenameSearch};
use std::path::Path;
use tokio_util::sync::CancellationToken;

#[tokio::test]
#[ignore = "docker sshd 필요 — scripts/ssh-it.sh"]
async fn remote_find_matches_substring_recursively() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let root = format!("{home}/it-search");
    ssh_common::run(
        &sess.conn,
        &format!(
            "rm -rf '{root}' && mkdir -p '{root}/sub' && \
             : > '{root}/alpha.txt' && : > '{root}/sub/alpha_inner.md' && \
             : > '{root}/beta.txt' && : > '{root}/.alpha_hidden'"
        ),
    )
    .await;

    let backend = SshFilenameSearch {
        conn: sess.conn.clone(),
    };

    // 기본 — dotfile 제외, 하위 디렉토리까지.
    let hits = backend
        .search(
            Path::new(&root),
            "alpha",
            &SearchOpts::default(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
    assert!(names.contains(&"alpha.txt"), "alpha.txt 누락: {names:?}");
    assert!(
        names.contains(&"alpha_inner.md"),
        "하위 alpha_inner.md 누락: {names:?}"
    );
    assert!(!names.contains(&"beta.txt"), "beta.txt 가 매칭됨");
    assert!(
        !names.contains(&".alpha_hidden"),
        "include_hidden=false 인데 dotfile 매칭됨"
    );

    // include_hidden=true — dotfile 포함.
    let with_hidden = backend
        .search(
            Path::new(&root),
            "alpha",
            &SearchOpts {
                include_hidden: true,
                ..SearchOpts::default()
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let hidden_names: Vec<&str> = with_hidden.iter().map(|h| h.name.as_str()).collect();
    assert!(
        hidden_names.contains(&".alpha_hidden"),
        "include_hidden=true 인데 dotfile 누락: {hidden_names:?}"
    );
}
