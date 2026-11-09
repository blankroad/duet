//! 경로 포함 관계 가드 — 폴더를 자기 자신이나 자기 하위로 복사·이동·동기화·병합하는 사고를 막는다.
//!
//! 막지 않으면 복사가 방금 만든 대상 폴더를 다시 읽어 끝없이 자기 복제하고(경로 길이 한계에서야
//! "경로가 너무 깁니다"로 멈춤), 동기화 반대 방향 + 삭제 전파면 원본이 휴지통으로 간다.
//!
//! 두 위치는 **같은 실제 파일시스템**일 때만 비교한다: 로컬↔로컬, 같은 연결, 같은 서버
//! (`copy_strategy::decide_fs == SshSameHost`). 로컬↔원격·다른 서버는 경로 문자열이 겹쳐도
//! 서로 다른 트리라 통과.
//!
//! 정규화:
//! - 로컬: `tokio::fs::canonicalize` 로 실제 경로를 얻는다 — 심볼릭 링크, macOS `/var`→
//!   `/private/var`, Windows `C:/a` vs `C:\a\` 표기 차이를 흡수한다. 경로가 아직 없으면
//!   lexical(`.`/`..` 정리) 후 **존재하는 가장 긴 조상**만 canonicalize 하고 나머지를 붙인다.
//!   OS 분기 없는 tokio 호출이라 `platform/` 을 거치지 않는다(`fs/local.rs` 는 수정 금지 구간).
//! - 원격: POSIX 문자열 lexical (`/` 만 구분자, 이름 속 `\` 는 일반 문자). 네트워크 왕복을
//!   더하지 않으므로 원격 심볼릭 링크로 하위를 가리키는 경우는 못 잡는다(그건 copy_tree 의
//!   lstat 방어가 무한 재귀만 막는다).
//!
//! 포함 판정은 컴포넌트 단위라 `/a/b` 는 `/a/bc` 의 조상이 아니다.

use crate::core::copy_strategy::{decide_fs, CopyStrategy};
use crate::fs::FileSystem;
use crate::types::{DuetError, Location, SourceId};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

/// 두 경로(a, b)의 포함 관계.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nesting {
    /// 같은 경로.
    Same,
    /// a 가 b 의 하위.
    AInsideB,
    /// b 가 a 의 하위.
    BInsideA,
    /// 겹치지 않음(또는 서로 다른 실제 FS).
    Unrelated,
}

/// 두 source 가 같은 실제 파일시스템을 가리키는지 — 경로 비교가 의미 있는 경우.
pub fn same_real_fs(
    a_fs: &dyn FileSystem,
    a: &SourceId,
    b_fs: &dyn FileSystem,
    b: &SourceId,
) -> bool {
    a == b
        || matches!(
            decide_fs(a_fs, a, b_fs, b),
            CopyStrategy::LocalToLocal | CopyStrategy::SshSameHost
        )
}

/// `(a_src, a)` 와 `(b_src, b)` 의 포함 관계. 다른 실제 FS 면 `Unrelated`.
pub async fn nesting(
    a_fs: &dyn FileSystem,
    a_src: &SourceId,
    a: &Path,
    b_fs: &dyn FileSystem,
    b_src: &SourceId,
    b: &Path,
) -> Nesting {
    if !same_real_fs(a_fs, a_src, b_fs, b_src) {
        return Nesting::Unrelated;
    }
    same_fs_nesting(a_src, a, b_src, b).await
}

// The compression guard has one source filesystem, so identity is already known.
async fn same_fs_nesting(a_src: &SourceId, a: &Path, b_src: &SourceId, b: &Path) -> Nesting {
    if matches!((a_src, b_src), (SourceId::Local, SourceId::Local)) {
        let (ka, kb) = (local_key(a).await, local_key(b).await);
        relate_local(&ka, &kb)
    } else {
        relate(&posix_key(a), &posix_key(b))
    }
}

/// copy/move: 받는 폴더(`dst`)가 옮길 항목 자신이거나 그 하위면 `IntoItself`.
///
/// `items` 는 항목의 전체 경로(부모 + 이름, 각 fs 의 join 으로 만든 것). 받는 폴더는 한 번만
/// 정규화한다(항목이 수천 개여도 dst canonicalize 는 1회).
pub async fn ensure_not_into_itself(
    src_fs: &dyn FileSystem,
    src_source: &SourceId,
    items: &[PathBuf],
    dst_fs: &dyn FileSystem,
    dst: &Location,
) -> Result<(), DuetError> {
    if !same_real_fs(src_fs, src_source, dst_fs, &dst.source) {
        return Ok(());
    }
    let local = matches!(
        (src_source, &dst.source),
        (SourceId::Local, SourceId::Local)
    );
    let dst_local = if local {
        Some(local_key(&dst.path).await)
    } else {
        None
    };
    let dst_posix = posix_key(&dst.path);
    for item in items {
        let rel = match &dst_local {
            Some(d) => relate_local(&local_item_key(item).await, d),
            None => relate(&posix_key(item), &dst_posix),
        };
        // a=항목, b=받는 폴더. 받는 폴더가 항목 자신(Same)이거나 항목 하위(BInsideA)면 거부.
        if matches!(rel, Nesting::Same | Nesting::BInsideA) {
            return Err(DuetError::IntoItself(format!(
                "destination '{}' is inside '{}'",
                dst.path.display(),
                item.display()
            )));
        }
    }
    Ok(())
}

/// sync/merge/apply/three-way: 두 루트가 같거나 **어느 방향이든** 상·하위면 `IntoItself`.
///
/// 한쪽이 다른 쪽 안에 있으면 비교 목록에 상대 루트 자신이 "한쪽에만 있음"으로 잡혀 그 폴더를
/// 자기 안으로 복사하거나, 삭제 전파 시 상대 루트를 휴지통으로 보낸다.
pub async fn ensure_roots_unrelated(
    a_fs: &dyn FileSystem,
    a: &Location,
    b_fs: &dyn FileSystem,
    b: &Location,
) -> Result<(), DuetError> {
    let msg = match nesting(a_fs, &a.source, &a.path, b_fs, &b.source, &b.path).await {
        Nesting::Unrelated => return Ok(()),
        Nesting::Same => format!(
            "'{}' and '{}' are the same folder",
            a.path.display(),
            b.path.display()
        ),
        Nesting::AInsideB => format!("'{}' is inside '{}'", a.path.display(), b.path.display()),
        Nesting::BInsideA => format!("'{}' is inside '{}'", b.path.display(), a.path.display()),
    };
    Err(DuetError::IntoItself(msg))
}

/// compress: 만들 결과 파일(`output`)이 고른 항목 자신이거나 고른 폴더 안이면 `IntoItself`.
///
/// 결과 파일을 쓰는 동안 그 파일을 원본으로 읽게 되어(충돌 백업이 기존 파일을 치운 뒤라)
/// 사용자가 고른 기존 내용 대신 쓰는 중인 자기 자신이 들어간다(archive-22).
pub async fn ensure_output_not_in_selection(
    source: &SourceId,
    items: &[PathBuf],
    output: &Path,
) -> Result<(), DuetError> {
    for item in items {
        if matches!(
            same_fs_nesting(source, item, source, output).await,
            Nesting::Same | Nesting::BInsideA
        ) {
            return Err(DuetError::IntoItself(format!(
                "archive '{}' would be written into the selected item '{}'",
                output.display(),
                item.display()
            )));
        }
    }
    Ok(())
}

/// 옮길 **항목 자신**의 로컬 비교 키 — 부모만 정규화하고 마지막 이름은 따라가지 않는다(lstat).
///
/// 항목이 심볼릭 링크면 복사·이동되는 것은 링크 자체다(copy_tree 는 lstat 로 링크 폴더 안으로
/// 들어가지 않는다). 링크 대상을 따라가 비교하면 `lnk -> real` 을 `real/sub` 로 옮기는 정상
/// 작업까지 막는다.
async fn local_item_key(p: &Path) -> PathBuf {
    let lex = lexical_local(p);
    match (lex.parent(), lex.file_name()) {
        (Some(parent), Some(name)) => {
            let mut key = local_key(parent).await;
            key.push(name);
            key
        }
        _ => local_key(&lex).await,
    }
}

/// 로컬 경로 비교 키 — canonicalize, 실패하면 lexical 후 존재하는 가장 긴 조상만 canonicalize.
async fn local_key(p: &Path) -> PathBuf {
    if let Ok(c) = tokio::fs::canonicalize(p).await {
        return c;
    }
    let lex = lexical_local(p);
    let mut base: &Path = &lex;
    let mut tail: Vec<OsString> = Vec::new();
    loop {
        if let Ok(mut c) = tokio::fs::canonicalize(base).await {
            for name in tail.iter().rev() {
                c.push(name);
            }
            return c;
        }
        match (base.parent(), base.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_os_string());
                base = parent;
            }
            _ => return lex,
        }
    }
}

/// `.` 제거·`..` 로 한 칸 올라가기(루트 위로는 안 감). 파일시스템을 보지 않는다.
fn lexical_local(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                // 루트/드라이브 위로는 못 올라간다.
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn relate_local(a: &Path, b: &Path) -> Nesting {
    if a == b {
        Nesting::Same
    } else if a.starts_with(b) {
        Nesting::AInsideB
    } else if b.starts_with(a) {
        Nesting::BInsideA
    } else {
        Nesting::Unrelated
    }
}

/// 원격(POSIX) 경로 비교 키 — `/` 로만 나누고 `.`/`..` 정리. 절대경로면 첫 칸이 `/`.
fn posix_key(p: &Path) -> Vec<String> {
    let s = p.to_string_lossy();
    let mut out: Vec<String> = Vec::new();
    if s.starts_with('/') {
        out.push("/".into());
    }
    for part in s.split('/') {
        match part {
            "" | "." => {}
            ".." => match out.last().map(String::as_str) {
                Some("/") => {}
                Some("..") | None => out.push("..".into()),
                Some(_) => {
                    out.pop();
                }
            },
            name => out.push(name.into()),
        }
    }
    out
}

fn relate(a: &[String], b: &[String]) -> Nesting {
    if a == b {
        Nesting::Same
    } else if a.starts_with(b) {
        Nesting::AInsideB
    } else if b.starts_with(a) {
        Nesting::BInsideA
    } else {
        Nesting::Unrelated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::LocalFs;
    use crate::types::ConnectionId;
    use std::net::{IpAddr, Ipv4Addr};

    fn ssh(conn: &str, ip: [u8; 4]) -> SourceId {
        SourceId::Ssh {
            connection_id: ConnectionId(conn.into()),
            host_ip: IpAddr::V4(Ipv4Addr::from(ip)),
            user: "u".into(),
        }
    }
    fn local(p: &Path) -> Location {
        Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        }
    }

    #[tokio::test]
    async fn sibling_with_common_prefix_is_not_nested() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("a/b")).unwrap();
        std::fs::create_dir_all(t.path().join("a/bc")).unwrap();
        let l = SourceId::Local;
        assert_eq!(
            nesting(
                &LocalFs,
                &l,
                &t.path().join("a/b"),
                &LocalFs,
                &l,
                &t.path().join("a/bc")
            )
            .await,
            Nesting::Unrelated
        );
        // 원격도 컴포넌트 단위.
        let s = ssh("c1", [10, 0, 0, 1]);
        assert_eq!(
            nesting(
                &LocalFs,
                &s,
                Path::new("/a/b"),
                &LocalFs,
                &s,
                Path::new("/a/bc")
            )
            .await,
            Nesting::Unrelated
        );
    }

    #[tokio::test]
    async fn same_child_and_parent_detected_both_ways() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("p");
        std::fs::create_dir_all(p.join("child")).unwrap();
        let l = SourceId::Local;
        assert_eq!(
            nesting(&LocalFs, &l, &p, &LocalFs, &l, &p).await,
            Nesting::Same
        );
        assert_eq!(
            nesting(&LocalFs, &l, &p.join("child"), &LocalFs, &l, &p).await,
            Nesting::AInsideB
        );
        assert_eq!(
            nesting(&LocalFs, &l, &p, &LocalFs, &l, &p.join("child")).await,
            Nesting::BInsideA
        );
        assert!(
            ensure_roots_unrelated(&LocalFs, &local(&p), &LocalFs, &local(&p.join("child")))
                .await
                .is_err()
        );
        assert!(
            ensure_roots_unrelated(&LocalFs, &local(&p.join("child")), &LocalFs, &local(&p))
                .await
                .is_err()
        );
        assert!(matches!(
            ensure_roots_unrelated(&LocalFs, &local(&p), &LocalFs, &local(&p)).await,
            Err(DuetError::IntoItself(_))
        ));
    }

    #[tokio::test]
    async fn dot_dot_and_dot_are_resolved() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("p");
        std::fs::create_dir_all(p.join("x/y")).unwrap();
        let l = SourceId::Local;
        // p/x/y/../.  == p/x  → p/x 는 p 의 하위.
        let dotted = p.join("x").join("y").join("..").join(".");
        assert_eq!(
            nesting(&LocalFs, &l, &dotted, &LocalFs, &l, &p).await,
            Nesting::AInsideB
        );
        // 아직 없는 경로에 `..` — lexical 로 정리.
        let ghost = p.join("nope").join("..").join("x").join("new");
        assert_eq!(
            nesting(&LocalFs, &l, &ghost, &LocalFs, &l, &p).await,
            Nesting::AInsideB
        );
        // 원격 POSIX.
        let s = ssh("c1", [10, 0, 0, 1]);
        assert_eq!(
            nesting(
                &LocalFs,
                &s,
                Path::new("/srv/a/./b/../c"),
                &LocalFs,
                &s,
                Path::new("/srv/a/")
            )
            .await,
            Nesting::AInsideB
        );
        assert_eq!(
            nesting(
                &LocalFs,
                &s,
                Path::new("/../srv"),
                &LocalFs,
                &s,
                Path::new("/srv")
            )
            .await,
            Nesting::Same
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_pointing_into_source_is_detected() {
        let t = tempfile::tempdir().unwrap();
        let a = t.path().join("a");
        std::fs::create_dir_all(a.join("sub")).unwrap();
        // 바깥의 링크가 a/sub 를 가리킨다 — 링크 경로로 고른 받는 폴더도 a 의 하위.
        let link = t.path().join("link-to-sub");
        std::os::unix::fs::symlink(a.join("sub"), &link).unwrap();
        let r = ensure_not_into_itself(
            &LocalFs,
            &SourceId::Local,
            std::slice::from_ref(&a),
            &LocalFs,
            &local(&link),
        )
        .await;
        assert!(matches!(r, Err(DuetError::IntoItself(_))), "{r:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_item_is_compared_as_the_link_not_its_target() {
        let t = tempfile::tempdir().unwrap();
        let real = t.path().join("real");
        std::fs::create_dir_all(real.join("sub")).unwrap();
        // 옮기는 것은 링크 자체 — 링크 대상(real)의 하위로 옮겨도 자기 안으로가 아니다.
        let lnk = t.path().join("lnk");
        std::os::unix::fs::symlink(&real, &lnk).unwrap();
        let r = ensure_not_into_itself(
            &LocalFs,
            &SourceId::Local,
            std::slice::from_ref(&lnk),
            &LocalFs,
            &local(&real.join("sub")),
        )
        .await;
        assert!(r.is_ok(), "{r:?}");
        // 진짜 폴더를 자기 하위로는 여전히 거부.
        let r = ensure_not_into_itself(
            &LocalFs,
            &SourceId::Local,
            std::slice::from_ref(&real),
            &LocalFs,
            &local(&real.join("sub")),
        )
        .await;
        assert!(matches!(r, Err(DuetError::IntoItself(_))), "{r:?}");
    }

    #[tokio::test]
    async fn into_itself_only_rejects_same_or_descendant_destination() {
        let t = tempfile::tempdir().unwrap();
        let a = t.path().join("a");
        std::fs::create_dir_all(a.join("sub")).unwrap();
        let l = SourceId::Local;
        for bad in [a.clone(), a.join("sub")] {
            assert!(matches!(
                ensure_not_into_itself(
                    &LocalFs,
                    &l,
                    std::slice::from_ref(&a),
                    &LocalFs,
                    &local(&bad)
                )
                .await,
                Err(DuetError::IntoItself(_))
            ));
        }
        // 부모로 복사(같은 폴더에 사본)·형제로 복사는 허용.
        assert!(ensure_not_into_itself(
            &LocalFs,
            &l,
            std::slice::from_ref(&a),
            &LocalFs,
            &local(t.path())
        )
        .await
        .is_ok());
        assert!(ensure_not_into_itself(
            &LocalFs,
            &l,
            &[a.join("sub")],
            &LocalFs,
            &local(&a.join(".."))
        )
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn different_real_fs_passes() {
        let l = SourceId::Local;
        let s1 = ssh("c1", [10, 0, 0, 1]);
        let s2 = ssh("c2", [10, 0, 0, 2]);
        let p = Path::new("/srv/a");
        // 로컬↔원격: 같은 문자열이어도 다른 트리.
        assert_eq!(
            nesting(&LocalFs, &l, p, &LocalFs, &s1, p).await,
            Nesting::Unrelated
        );
        // 다른 서버.
        assert_eq!(
            nesting(&LocalFs, &s1, p, &LocalFs, &s2, &p.join("b")).await,
            Nesting::Unrelated
        );
        // 같은 서버(다른 연결) — 같은 FS 로 본다.
        let s1b = ssh("c9", [10, 0, 0, 1]);
        assert_eq!(
            nesting(&LocalFs, &s1, p, &LocalFs, &s1b, &p.join("b")).await,
            Nesting::BInsideA
        );
        // 같은 연결이면 host_ip 가 미해석(0.0.0.0)이어도 같은 FS.
        let u = ssh("cu", [0, 0, 0, 0]);
        assert_eq!(
            nesting(&LocalFs, &u, p, &LocalFs, &u, p).await,
            Nesting::Same
        );
    }

    #[tokio::test]
    async fn remote_backslash_is_a_name_char() {
        // 원격에서 `\` 는 이름 문자 — `/srv/a\b` 는 `/srv/a` 의 하위가 아니다.
        let s = ssh("c1", [10, 0, 0, 1]);
        assert_eq!(
            nesting(
                &LocalFs,
                &s,
                Path::new("/srv/a\\b"),
                &LocalFs,
                &s,
                Path::new("/srv/a")
            )
            .await,
            Nesting::Unrelated
        );
    }

    /// macOS 기본 APFS(대소문자 무시)에서 canonicalize 가 디스크의 실제 대소문자를 돌려주는지
    /// 기록한다 — 돌려준다면 `/T/A` 와 `/t/a/sub` 같은 표기 차이도 하위로 잡힌다.
    /// 대소문자 구분 FS(Linux 등)에선 `Unrelated` 가 맞는 답이라 단언하지 않고 관찰만 한다.
    #[tokio::test]
    async fn observe_case_variant_on_this_fs() {
        let t = tempfile::tempdir().unwrap();
        let real = t.path().join("CaseDir");
        std::fs::create_dir_all(real.join("sub")).unwrap();
        let variant = t.path().join("casedir").join("sub");
        let case_insensitive = variant.exists();
        let canon = tokio::fs::canonicalize(&variant).await;
        let n = nesting(
            &LocalFs,
            &SourceId::Local,
            &real,
            &LocalFs,
            &SourceId::Local,
            &variant,
        )
        .await;
        eprintln!(
            "case-insensitive fs={case_insensitive} canonicalize({variant:?})={canon:?} nesting={n:?}"
        );
        if case_insensitive {
            assert_eq!(n, Nesting::BInsideA);
        }
    }
}
