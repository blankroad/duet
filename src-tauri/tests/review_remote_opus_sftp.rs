//! review/remote (opus R1) — SFTP 실검증: 특수 파일명 목록/메타(C-14), 파일 작업과
//! 실패 문구(C-15), 원격 휴지통(C-16), 원격 검색(C-21), 같은 호스트 복사(C-19).
//!
//! 게이트: `DUET_SSH_IT=1` + `#[ignore]`. 파괴적 준비(`~/.duet-trash` chmod 등)가 있어
//! 공유 컨테이너(2222) 대신 전용 컨테이너로 돌린다: `DUET_SSH_IT_PORT=2223`.
//! 결과 대부분을 `[review]` 줄로 출력한다 — 보고서에 그대로 인용하기 위함.

mod ssh_common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use duet_lib::core::copy_strategy::CopyStrategy;
use duet_lib::core::ops::{copy_execute, copy_plan, delete_execute, delete_plan, ConflictPolicy};
use duet_lib::core::search::{SearchBackend, SearchOpts, SshFilenameSearch};
use duet_lib::core::undo::{execute_undo, UndoKind};
use duet_lib::fs::{FileSystem, SshFs};
use duet_lib::services::connection_pool::{ActiveConnection, ConnectionPool};
use duet_lib::services::trash::new_batch_id;
use duet_lib::ssh::connection;
use duet_lib::types::{ChecksumAlgo, ConnectionId, DeleteMode, EntryKind, TrashLocation};
use sha2::Digest;
use tokio_util::sync::CancellationToken;

/// 셸 작은따옴표 인용 (테스트 준비 명령용).
fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 홈 아래 고유 작업 폴더 생성 후 절대경로 반환.
async fn workdir(sess: &ssh_common::Session, topic: &str) -> String {
    let home = ssh_common::home(&sess.conn).await;
    let base = format!("{home}/review-opus-{topic}-{}", std::process::id());
    ssh_common::run(&sess.conn, &format!("mkdir -p {}", q(&base))).await;
    base
}

/// 테스트에 쓰는 특수 이름들 (라벨, 실제 이름).
fn special_names() -> Vec<(&'static str, String)> {
    vec![
        ("korean+space", "한글 파일.txt".to_string()),
        ("space", "a b.txt".to_string()),
        ("newline", "nl\nname".to_string()),
        ("quote", "it's".to_string()),
        ("backslash", "back\\slash".to_string()),
        ("leading-dash", "-dash".to_string()),
    ]
}

/// 원격에 이름 그대로 파일 생성 — 이름을 printf 로 만들어 줄바꿈도 넣는다.
async fn make_file(conn: &Arc<ActiveConnection>, dir: &str, name: &str, body: &str) {
    // printf %s 로 정확한 이름을 만들고 ./ 를 붙여 앞 `-` 도 안전하게.
    let cmd = format!(
        "cd {} && n=$(printf '%s.' {}) && n=${{n%.}} && printf %s {} > \"./$n\"",
        q(dir),
        q(name),
        q(body)
    );
    ssh_common::run(conn, &cmd).await;
}

#[tokio::test]
#[ignore = "remote-03 repro: symlinks listed as files (docker sshd)"]
async fn c14_list_and_metadata_special_names_and_links() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let base = workdir(&sess, "c14").await;
    for (_, n) in special_names() {
        make_file(&sess.conn, &base, &n, "x").await;
    }
    ssh_common::run(
        &sess.conn,
        &format!(
            "cd {} && mkdir realdir && : > realdir/inner && ln -s realdir dirlink && \
             ln -s nowhere broken && ln -s loop loop && mkdir locked && : > locked/f && chmod 000 locked",
            q(&base)
        ),
    )
    .await;

    let fs = SshFs::new(sess.conn.clone());
    let entries = fs.list(Path::new(&base)).await.expect("list base");
    let mut problems = Vec::new();
    for e in &entries {
        println!(
            "[review] c14 list name={:?} kind={:?} size={:?} perms={:?}",
            e.name, e.kind, e.size, e.permissions
        );
    }
    for (label, n) in special_names() {
        match entries.iter().find(|e| e.name == n) {
            Some(e) if e.kind == EntryKind::File => {}
            Some(e) => problems.push(format!("{label}: kind {:?}", e.kind)),
            None => problems.push(format!("{label}: missing from list")),
        }
        let p = fs.join(Path::new(&base), &n);
        match fs.metadata(&p).await {
            Ok(m) if m.kind == EntryKind::File => {}
            Ok(m) => problems.push(format!("{label}: metadata kind {:?}", m.kind)),
            Err(e) => problems.push(format!("{label}: metadata err {e}")),
        }
    }
    let kind_of = |name: &str| entries.iter().find(|e| e.name == name).map(|e| e.kind);
    assert_eq!(kind_of("dirlink"), Some(EntryKind::Dir), "디렉터리 링크");
    assert_eq!(kind_of("broken"), Some(EntryKind::Symlink), "깨진 링크");
    assert_eq!(kind_of("loop"), Some(EntryKind::Symlink), "자기 루프 링크");
    assert_eq!(kind_of("locked"), Some(EntryKind::Dir));

    // 링크 메타: metadata(stat) / symlink_metadata(lstat)
    for name in ["dirlink", "broken", "loop"] {
        let p = fs.join(Path::new(&base), name);
        let m = fs.metadata(&p).await;
        let l = fs.symlink_metadata(&p).await;
        println!(
            "[review] c14 link {name}: metadata={:?} symlink_metadata={:?}",
            m.as_ref().map(|m| m.kind).map_err(|e| e.to_string()),
            l.as_ref().map(|m| m.kind).map_err(|e| e.to_string())
        );
        assert_eq!(l.unwrap().kind, EntryKind::Symlink, "{name} lstat");
    }
    // 디렉터리 링크 안으로 이동 가능
    let inner = fs.list(&fs.join(Path::new(&base), "dirlink")).await;
    println!(
        "[review] c14 list(dirlink) = {:?}",
        inner.as_ref().map(|v| v.len()).map_err(|e| e.to_string())
    );
    assert!(inner.is_ok());

    // 권한 없는 폴더 목록 — 사용자에게 갈 오류.
    let locked = fs.list(&fs.join(Path::new(&base), "locked")).await;
    println!(
        "[review] c14 list(locked chmod 000) = {:?}",
        locked.as_ref().map(|v| v.len())
    );
    match &locked {
        Err(duet_lib::types::DuetError::PermissionDenied(_)) => {}
        other => problems.push(format!("locked: expected PermissionDenied, got {other:?}")),
    }
    ssh_common::run(&sess.conn, &format!("chmod 755 {}/locked", q(&base))).await;
    assert!(problems.is_empty(), "C-14 problems: {problems:#?}");
}

#[tokio::test]
#[ignore = "remote C-14 measure: large dir listing (docker sshd)"]
async fn c14_large_dir_list_timing() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let base = workdir(&sess, "c14big").await;
    ssh_common::run(
        &sess.conn,
        &format!(
            "cd {} && mkdir files links && cd files && seq 1 5000 | sed 's/^/f/' | xargs touch && \
             cd ../links && : > target && seq 1 2000 | sed 's/^/l/' | xargs -n1 ln -s target",
            q(&base)
        ),
    )
    .await;
    let fs = SshFs::new(sess.conn.clone());
    let t = Instant::now();
    let files = fs.list(&fs.join(Path::new(&base), "files")).await.unwrap();
    let t_files = t.elapsed();
    let t = Instant::now();
    let links = fs.list(&fs.join(Path::new(&base), "links")).await.unwrap();
    let t_links = t.elapsed();
    println!(
        "[review] c14 list 5000 files: n={} {:?}; 2000 symlinks: n={} {:?}",
        files.len(),
        t_files,
        links.len(),
        t_links
    );
    assert_eq!(files.len(), 5000);
    assert_eq!(links.len(), 2001);
}

#[tokio::test]
#[ignore = "remote-03 repro: lstat reports symlink as file (docker sshd)"]
async fn c15_file_ops_with_special_names() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let base = workdir(&sess, "c15").await;
    let fs = SshFs::new(sess.conn.clone());
    let b = Path::new(&base);
    let mut problems = Vec::new();

    for (label, n) in special_names() {
        let p = fs.join(b, &n);
        let payload = format!("payload for {label}\n").into_bytes();
        let step = async {
            fs.write_full(&p, &payload)
                .await
                .map_err(|e| format!("write: {e}"))?;
            let back = fs.read_full(&p).await.map_err(|e| format!("read: {e}"))?;
            if back != payload {
                return Err("read != written".to_string());
            }
            let want = hex::encode(sha2::Sha256::digest(&payload));
            let got = fs
                .checksum(&p, ChecksumAlgo::Sha256)
                .await
                .map_err(|e| format!("checksum: {e}"))?;
            if got != want {
                return Err(format!("checksum mismatch {got} != {want}"));
            }
            fs.set_mode(&p, 0o600, false)
                .await
                .map_err(|e| format!("chmod: {e}"))?;
            let m = fs.metadata(&p).await.map_err(|e| format!("meta: {e}"))?;
            if m.permissions != Some(0o600) {
                return Err(format!("perms {:?}", m.permissions));
            }
            fs.set_owner(&p, Some("duet"), Some("duet"), false)
                .await
                .map_err(|e| format!("chown: {e}"))?;
            let ren = fs.join(b, &format!("{n}.ren"));
            fs.rename(&p, &ren)
                .await
                .map_err(|e| format!("rename: {e}"))?;
            let d = fs.join(b, &format!("{n}_dir"));
            fs.mkdir(&d).await.map_err(|e| format!("mkdir: {e}"))?;
            let nf = fs.join(b, &format!("{n}_new"));
            fs.create_new_file(&nf)
                .await
                .map_err(|e| format!("create_new: {e}"))?;
            let lnk = fs.join(b, &format!("{n}_lnk"));
            let target = format!("{n}.ren");
            fs.make_symlink(&lnk, &target)
                .await
                .map_err(|e| format!("symlink: {e}"))?;
            let lm = fs
                .symlink_metadata(&lnk)
                .await
                .map_err(|e| format!("lstat: {e}"))?;
            let tm = fs
                .metadata(&lnk)
                .await
                .map_err(|e| format!("stat link: {e}"))?;
            if lm.kind != EntryKind::Symlink || tm.kind != EntryKind::File {
                return Err(format!("link kinds lstat={:?} stat={:?}", lm.kind, tm.kind));
            }
            Ok::<(), String>(())
        }
        .await;
        println!("[review] c15 ops {label}: {step:?}");
        if let Err(e) = step {
            problems.push(format!("{label}: {e}"));
        }
    }

    // --- 실패 경로: 사용자에게 갈 오류 문자열 ---
    let a = fs.join(b, "exists-a");
    let bb = fs.join(b, "exists-b");
    fs.write_full(&a, b"A").await.unwrap();
    fs.write_full(&bb, b"B").await.unwrap();
    let r = fs.rename(&a, &bb).await;
    println!(
        "[review] c15 rename onto existing file -> {:?}",
        r.as_ref().map_err(|e| e.to_string())
    );
    let after_b = fs.read_full(&bb).await.unwrap();
    println!(
        "[review] c15   target content after = {:?}",
        String::from_utf8_lossy(&after_b)
    );
    let r = fs.mkdir(&a).await;
    println!(
        "[review] c15 mkdir over existing file -> {:?}",
        r.map_err(|e| e.to_string())
    );
    let r = fs.create_new_file(&a).await;
    println!(
        "[review] c15 create_new_file existing -> {:?}",
        r.map_err(|e| e.to_string())
    );
    assert_eq!(
        fs.read_full(&a).await.unwrap(),
        b"A",
        "create_new_file must not truncate"
    );
    let r = fs.read_full(b).await;
    println!(
        "[review] c15 read_full(dir) -> {:?}",
        r.map(|v| v.len()).map_err(|e| e.to_string())
    );
    let r = fs.set_owner(&a, Some("nosuchuser"), None, false).await;
    println!(
        "[review] c15 chown nosuchuser -> {:?}",
        r.map_err(|e| e.to_string())
    );
    let r = fs.set_owner(&a, Some("root"), None, false).await;
    println!(
        "[review] c15 chown root (not permitted) -> {:?}",
        r.map_err(|e| e.to_string())
    );
    let r = fs.make_symlink(&a, "x").await;
    println!(
        "[review] c15 make_symlink over existing -> {:?}",
        r.map_err(|e| e.to_string())
    );
    let r = fs
        .checksum(&fs.join(b, "missing"), ChecksumAlgo::Sha256)
        .await;
    println!(
        "[review] c15 checksum missing -> {:?}",
        r.map_err(|e| e.to_string())
    );
    // 권한 없음
    ssh_common::run(
        &sess.conn,
        &format!("mkdir {0}/ro && chmod 555 {0}/ro", q(&base)),
    )
    .await;
    let ro = fs.join(b, "ro");
    let r = fs.write_full(&fs.join(&ro, "f"), b"x").await;
    println!(
        "[review] c15 write into ro dir -> {:?}",
        r.as_ref().map_err(|e| e.to_string())
    );
    let r2 = fs.mkdir(&fs.join(&ro, "d")).await;
    println!(
        "[review] c15 mkdir into ro dir -> {:?}",
        r2.as_ref().map_err(|e| e.to_string())
    );
    let r3 = fs.rename(&a, &fs.join(&ro, "moved")).await;
    println!(
        "[review] c15 rename into ro dir -> {:?}",
        r3.as_ref().map_err(|e| e.to_string())
    );
    let r4 = fs.read_full(Path::new("/etc/shadow")).await;
    println!(
        "[review] c15 read /etc/shadow -> {:?}",
        r4.as_ref().map(|v| v.len()).map_err(|e| e.to_string())
    );
    ssh_common::run(&sess.conn, &format!("chmod 755 {}/ro", q(&base))).await;
    assert!(problems.is_empty(), "C-15 problems: {problems:#?}");
}

#[tokio::test]
#[ignore = "remote C-16 baseline: trash location/collision/restore (docker sshd)"]
async fn c16_trash_location_collisions_restore() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let base = workdir(&sess, "c16").await;
    let home = ssh_common::home(&sess.conn).await;
    let fs = SshFs::new(sess.conn.clone());
    let b = Path::new(&base);
    let name = "같은 이름's.txt";
    let p = fs.join(b, name);

    // 1) 위치
    fs.write_full(&p, b"first").await.unwrap();
    let batch1 = new_batch_id();
    let loc1 = fs.trash(&p, &batch1).await.expect("trash 1");
    let TrashLocation::Remote { trash_path: t1 } = &loc1 else {
        panic!()
    };
    println!("[review] c16 trash path = {}", t1.display());
    let expected = format!("{home}/.duet-trash/{batch1}{base}/{name}");
    assert_eq!(t1.to_string_lossy(), expected);
    assert!(fs.metadata(&p).await.is_err(), "원본이 남음");

    // 2) 같은 이름 다시 trash — 다른 batch 라 둘 다 남아야.
    fs.write_full(&p, b"second").await.unwrap();
    let batch2 = new_batch_id();
    let loc2 = fs.trash(&p, &batch2).await.expect("trash 2");
    let TrashLocation::Remote { trash_path: t2 } = &loc2 else {
        panic!()
    };
    assert_ne!(t1, t2);
    assert_eq!(fs.read_full(t1).await.unwrap(), b"first");
    assert_eq!(fs.read_full(t2).await.unwrap(), b"second");

    // 3) 원래 자리에 같은 이름이 생긴 뒤 복원 → 거부, 아무것도 안 덮음.
    fs.write_full(&p, b"newcomer").await.unwrap();
    let r = fs.restore_from_trash(&loc2, &p).await;
    println!(
        "[review] c16 restore onto existing -> {:?}",
        r.as_ref().map_err(|e| e.to_string())
    );
    assert!(r.is_err());
    assert_eq!(fs.read_full(&p).await.unwrap(), b"newcomer");
    assert_eq!(fs.read_full(t2).await.unwrap(), b"second");

    // 4) 부모 폴더가 사라진 뒤 복원 → 부모 재생성.
    let sub = fs.join(b, "gone");
    fs.mkdir(&sub).await.unwrap();
    let sp = fs.join(&sub, "child.txt");
    fs.write_full(&sp, b"c").await.unwrap();
    let loc3 = fs.trash(&sp, &new_batch_id()).await.unwrap();
    fs.remove_empty_dir(&sub).await.unwrap();
    fs.restore_from_trash(&loc3, &sp)
        .await
        .expect("restore with missing parent");
    assert_eq!(fs.read_full(&sp).await.unwrap(), b"c");

    // 5) 폴더 trash/restore
    let d = fs.join(b, "dir with 한글");
    fs.mkdir(&d).await.unwrap();
    fs.write_full(&fs.join(&d, "a"), b"a").await.unwrap();
    let locd = fs.trash(&d, &new_batch_id()).await.unwrap();
    fs.restore_from_trash(&locd, &d).await.unwrap();
    assert_eq!(fs.read_full(&fs.join(&d, "a")).await.unwrap(), b"a");
}

#[tokio::test]
#[ignore = "remote C-16 baseline: trash failure never falls back to rm (docker sshd)"]
async fn c16_trash_failure_never_falls_back_to_rm() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let base = workdir(&sess, "c16fail").await;
    let home = ssh_common::home(&sess.conn).await;
    let fs = SshFs::new(sess.conn.clone());
    let b = Path::new(&base);

    // (a) 휴지통 폴더 쓰기 불가 → 실패 + 원본 그대로.
    let p = fs.join(b, "keep-me.txt");
    fs.write_full(&p, b"keep").await.unwrap();
    ssh_common::run(
        &sess.conn,
        &format!(
            "mkdir -p {0}/.duet-trash && chmod 555 {0}/.duet-trash",
            q(&home)
        ),
    )
    .await;
    let r = fs.trash(&p, &new_batch_id()).await;
    ssh_common::run(&sess.conn, &format!("chmod 755 {}/.duet-trash", q(&home))).await;
    println!(
        "[review] c16 trash with unwritable ~/.duet-trash -> {:?}",
        r.as_ref().map_err(|e| e.to_string())
    );
    assert!(r.is_err());
    assert_eq!(
        fs.read_full(&p).await.unwrap(),
        b"keep",
        "원본이 사라짐 (rm 폴백?)"
    );

    // (b) delete_execute(Trash) 경로도 같은 상황에서 원본 보존 + journal 없음.
    ssh_common::run(&sess.conn, &format!("chmod 555 {}/.duet-trash", q(&home))).await;
    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    let plan = delete_plan(
        &fs,
        vec![ssh_common::entry(sess.source.clone(), &base, "keep-me.txt")],
        DeleteMode::Trash,
    )
    .await
    .unwrap();
    let r = delete_execute(&fs, plan, &ctx, "", None).await;
    ssh_common::run(&sess.conn, &format!("chmod 755 {}/.duet-trash", q(&home))).await;
    println!(
        "[review] c16 delete_execute(Trash) unwritable trash -> {:?}",
        r.as_ref().map(|_| ()).map_err(|e| e.to_string())
    );
    assert!(r.is_err());
    assert_eq!(fs.read_full(&p).await.unwrap(), b"keep");

    // (c) 원본 부모가 읽기전용 → rename PermissionDenied, cp 폴백 안 함.
    ssh_common::run(
        &sess.conn,
        &format!(
            "mkdir {0}/rodir && echo k > {0}/rodir/f && chmod 555 {0}/rodir",
            q(&base)
        ),
    )
    .await;
    let rf = fs.join(&fs.join(b, "rodir"), "f");
    let r = fs.trash(&rf, &new_batch_id()).await;
    println!(
        "[review] c16 trash from read-only parent -> {:?}",
        r.as_ref().map_err(|e| e.to_string())
    );
    let leftovers = ssh_common::stdout_str(
        &sess.conn,
        &format!("find {}/.duet-trash -path '*rodir/f' | wc -l", q(&home)),
    )
    .await;
    println!("[review] c16   copies of rodir/f left in trash = {leftovers}");
    ssh_common::run(&sess.conn, &format!("chmod 755 {}/rodir", q(&base))).await;
    assert!(r.is_err());
    assert!(fs.metadata(&rf).await.is_ok());
}

/// 다른 파일시스템(/dev/shm tmpfs → 홈 overlay)에서의 trash = EXDEV → cp -a + SFTP 제거 폴백.
/// 폴더 안에 지울 수 없는 하위 폴더가 있으면 cp 는 성공하고 원본 제거가 **중간에** 실패한다.
#[tokio::test]
#[ignore = "remote-08 repro: cross-device trash partial removal without journal (docker sshd)"]
async fn c16_cross_device_trash_partial_removal() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let home = ssh_common::home(&sess.conn).await;
    let fs = SshFs::new(sess.conn.clone());
    let fstype = ssh_common::stdout_str(
        &sess.conn,
        "stat -f -c %T /dev/shm; stat -f -c %T \"$HOME\"",
    )
    .await;
    println!("[review] c16 fs types (/dev/shm, $HOME) = {fstype:?}");
    let shm = format!("/dev/shm/review-opus-{}", std::process::id());
    ssh_common::run(&sess.conn, &format!("mkdir -p {}", q(&shm))).await;

    // (a) 단일 파일 cross-device trash + 복원
    let f = PathBuf::from(format!("{shm}/xdev.txt"));
    fs.write_full(&f, b"xdev").await.unwrap();
    let loc = fs.trash(&f, &new_batch_id()).await;
    println!(
        "[review] c16 xdev file trash -> {:?}",
        loc.as_ref().map_err(|e| e.to_string())
    );
    let loc = loc.unwrap();
    assert!(fs.metadata(&f).await.is_err());
    fs.restore_from_trash(&loc, &f).await.expect("xdev restore");
    assert_eq!(fs.read_full(&f).await.unwrap(), b"xdev");

    // (b) 폴더: top 파일들 + 쓰기불가 하위폴더(안에 파일) → 원본 제거가 중간 실패.
    let d = format!("{shm}/xdir");
    ssh_common::run(
        &sess.conn,
        &format!(
            "mkdir -p {0}/zz_locked && echo 1 > {0}/a.txt && echo 2 > {0}/b.txt && echo 3 > {0}/zz_locked/c.txt && chmod 555 {0}/zz_locked",
            q(&d)
        ),
    )
    .await;
    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    let plan = delete_plan(
        &fs,
        vec![ssh_common::entry(sess.source.clone(), &shm, "xdir")],
        DeleteMode::Trash,
    )
    .await
    .unwrap();
    let r = delete_execute(&fs, plan, &ctx, "", None).await;
    let left = ssh_common::stdout_str(
        &sess.conn,
        &format!("cd {} && find . | sort | tr '\\n' ' '", q(&d)),
    )
    .await;
    let in_trash = ssh_common::stdout_str(
        &sess.conn,
        &format!(
            "find {}/.duet-trash -path '*xdir*' -type f | wc -l",
            q(&home)
        ),
    )
    .await;
    let journal = ctx.journal.history(100).await;
    println!(
        "[review] c16 xdev dir trash -> {:?}; original now: [{left}]; files in trash: {in_trash}; journal entries: {}",
        r.as_ref().map(|_| ()).map_err(|e| e.to_string()),
        journal.len()
    );
    ssh_common::run(&sess.conn, &format!("chmod 755 {}/zz_locked", q(&d))).await;
    // 기대(§4): 실패했다면 원본이 온전하거나, 아니면 journal 로 되돌릴 수 있어야 한다.
    let original_intact = left.contains("a.txt") && left.contains("b.txt");
    assert!(
        original_intact || !journal.is_empty(),
        "원본 일부가 사라졌는데 undo 기록이 없다 — 원본: [{left}]"
    );
}

#[tokio::test]
#[ignore = "remote-10 evidence: undo after connection id gone (docker sshd)"]
async fn c16_delete_then_journal_undo_roundtrip() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let base = workdir(&sess, "c16undo").await;
    let fs = SshFs::new(sess.conn.clone());
    let b = Path::new(&base);
    for n in ["u1.txt", "u 2 한글.txt"] {
        fs.write_full(&fs.join(b, n), n.as_bytes()).await.unwrap();
    }
    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    let plan = delete_plan(
        &fs,
        vec![
            ssh_common::entry(sess.source.clone(), &base, "u1.txt"),
            ssh_common::entry(sess.source.clone(), &base, "u 2 한글.txt"),
        ],
        DeleteMode::Trash,
    )
    .await
    .unwrap();
    let entry = delete_execute(&fs, plan, &ctx, "", None).await.unwrap();
    assert!(fs.metadata(&fs.join(b, "u1.txt")).await.is_err());
    let out = execute_undo(&entry, &sess.pool).await;
    println!(
        "[review] c16 undo -> kind={:?} msg={:?}",
        out.kind, out.message
    );
    assert!(matches!(out.kind, UndoKind::Ok));
    assert_eq!(
        fs.read_full(&fs.join(b, "u1.txt")).await.unwrap(),
        b"u1.txt"
    );

    // 재삭제 후 같은 이름이 생기면 undo 결과/문구
    let plan = delete_plan(
        &fs,
        vec![ssh_common::entry(sess.source.clone(), &base, "u1.txt")],
        DeleteMode::Trash,
    )
    .await
    .unwrap();
    let entry = delete_execute(&fs, plan, &ctx, "", None).await.unwrap();
    fs.write_full(&fs.join(b, "u1.txt"), b"newer")
        .await
        .unwrap();
    let out = execute_undo(&entry, &sess.pool).await;
    println!(
        "[review] c16 undo when original name re-created -> kind={:?} msg={:?}",
        out.kind, out.message
    );
    assert_eq!(fs.read_full(&fs.join(b, "u1.txt")).await.unwrap(), b"newer");

    // 연결이 pool 에서 사라진 뒤(배너 재연결 = 새 connection id) undo
    let plan = delete_plan(
        &fs,
        vec![ssh_common::entry(
            sess.source.clone(),
            &base,
            "u 2 한글.txt",
        )],
        DeleteMode::Trash,
    )
    .await
    .unwrap();
    let entry = delete_execute(&fs, plan, &ctx, "", None).await.unwrap();
    let other_pool = ConnectionPool::new(); // 새 연결만 있는 pool 을 흉내 — 이전 id 없음
    let out = execute_undo(&entry, &other_pool).await;
    println!(
        "[review] c16 undo after connection id gone -> kind={:?} msg={:?}",
        out.kind, out.message
    );
}

#[tokio::test]
#[ignore = "remote-11/25 repro: hidden root and newline names in remote search (docker sshd)"]
async fn c21_search_korean_space_hidden_root_backslash() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let base = workdir(&sess, "c21").await;
    ssh_common::run(
        &sess.conn,
        &format!(
            "cd {} && mkdir -p '보고서 폴더' .config/app 'root\\dir' && : > '보고서 폴더/2026 결산 보고서.txt' && \
             : > .config/app/settings.json && : > 'root\\dir/inside.txt' && : > \"$(printf 'nl\\nreport.txt')\"",
            q(&base)
        ),
    )
    .await;
    let backend = SshFilenameSearch {
        conn: sess.conn.clone(),
    };
    let opts = SearchOpts {
        max_results: 100,
        ..SearchOpts::default()
    };
    let names = |hits: &Vec<duet_lib::core::search::SearchHit>| {
        hits.iter().map(|h| h.name.clone()).collect::<Vec<_>>()
    };
    let mut problems = Vec::new();

    let h = backend
        .search(
            Path::new(&base),
            "결산 보고",
            &opts,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    println!(
        "[review] c21 '결산 보고' -> {:?} loc={:?}",
        names(&h),
        h.first().map(|x| x.location.path.clone())
    );
    if !names(&h).contains(&"2026 결산 보고서.txt".to_string()) {
        problems.push("korean+space search missed".to_string());
    }

    let h = backend
        .search(Path::new(&base), "report", &opts, CancellationToken::new())
        .await
        .unwrap();
    println!("[review] c21 'report' (newline name) -> {:?}", names(&h));
    if !names(&h).contains(&"nl\nreport.txt".to_string()) {
        problems.push(format!("newline name search -> {:?}", names(&h)));
    }

    // 숨김 폴더 *안에서* 검색 (사용자가 ~/.config 를 열어두고 검색)
    let hidden_root = format!("{base}/.config");
    let h = backend
        .search(
            Path::new(&hidden_root),
            "settings",
            &opts,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    println!("[review] c21 search inside hidden root .config for 'settings' (include_hidden=false) -> {:?}", names(&h));
    if h.is_empty() {
        problems.push("search rooted inside a hidden folder returns nothing".to_string());
    }

    // 폴더 이름에 `\` 가 들어간 루트
    let bs_root = format!("{base}/root\\dir");
    let h = backend
        .search(
            Path::new(&bs_root),
            "inside",
            &opts,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    println!(
        "[review] c21 search rooted at 'root\\dir' -> {:?}",
        names(&h)
    );
    if h.is_empty() {
        problems.push(
            "search rooted at a folder whose name has a backslash returns nothing".to_string(),
        );
    }
    assert!(problems.is_empty(), "C-21 problems: {problems:#?}");
}

/// 같은 호스트 복사 — 이름에 `\` 가 든 파일. `shell_escape_path` 가 `\`→`/` 로 바꿔
/// 다른 파일(`a/b.txt`)이 복사되는지 확인.
#[tokio::test]
#[ignore = "remote-01 repro: same-host copy of backslash name copies another file (docker sshd)"]
async fn c19_same_host_copy_backslash_name_copies_wrong_file() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let base = workdir(&sess, "c19bs").await;
    ssh_common::run(
        &sess.conn,
        &format!(
            "cd {} && mkdir -p src/a dst && echo WRONG > src/a/b.txt && echo RIGHT > 'src/a\\b.txt'",
            q(&base)
        ),
    )
    .await;
    let fs = SshFs::new(sess.conn.clone());
    let src = format!("{base}/src");
    let dst = format!("{base}/dst");
    for use_rsync in [true, false] {
        ssh_common::run(
            &sess.conn,
            &format!("cd {} && find dst -mindepth 1 -delete", q(&base)),
        )
        .await;
        *sess.conn.rsync_available.lock().await = Some(use_rsync);
        let plan = copy_plan(
            &fs,
            &fs,
            vec![ssh_common::entry(sess.source.clone(), &src, "a\\b.txt")],
            ssh_common::loc(sess.source.clone(), &dst),
        )
        .await
        .unwrap();
        assert_eq!(plan.strategy, CopyStrategy::SshSameHost);
        let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
        let r = copy_execute(
            &fs,
            &fs,
            plan,
            ConflictPolicy::Skip,
            &ctx,
            CancellationToken::new(),
            None,
        )
        .await;
        let listing = ssh_common::stdout_str(
            &sess.conn,
            &format!(
                "cd {}/dst && for f in *; do printf '%s=%s ' \"$f\" \"$(cat \"$f\")\"; done",
                q(&base)
            ),
        )
        .await;
        println!(
            "[review] c19 same-host copy of 'a\\b.txt' rsync={use_rsync} -> {:?}; dst now: {listing}",
            r.as_ref().map(|_| ()).map_err(|e| e.to_string())
        );
        assert_eq!(listing.trim(), "a\\b.txt=RIGHT", "rsync={use_rsync}");
    }
}

/// 같은 호스트, 다른 유저(duet ↔ alt) — 판정은 SshSameHost. 실행은 **원본 연결의 유저**로.
#[tokio::test]
#[ignore = "remote-09 observation: cross-user same-host copy runs as source user (docker sshd)"]
async fn c19_same_host_different_user_runs_as_source_user() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let pool = ConnectionPool::new();
    let mut ids = Vec::new();
    for (user, pass) in [("duet", "duetpass"), ("alt", "altpass")] {
        let s = connection::connect_with_password(&host.host, host.port, user, pass, true, false)
            .await
            .expect("connect");
        let id = ConnectionId(format!("review-{user}"));
        pool.insert(ActiveConnection {
            id: id.clone(),
            alias: user.into(),
            host_ip: s.host_ip,
            endpoint: duet_lib::types::ServerEndpoint::new(s.host_ip, host.port, &[]),
            user: user.into(),
            session: Some(tokio::sync::Mutex::new(s.handle)),
            rsync_available: tokio::sync::Mutex::new(None),
            browse_temp_dirs: tokio::sync::Mutex::new(Vec::new()),
        })
        .await;
        ids.push(id);
    }
    let duet = pool.get(&ids[0]).await.unwrap();
    let alt = pool.get(&ids[1]).await.unwrap();
    let duet_fs = SshFs::new(duet.clone());
    let alt_fs = SshFs::new(alt.clone());
    let duet_home = ssh_common::home(&duet).await;
    let alt_home = ssh_common::home(&alt).await;
    let tag = std::process::id();
    let alt_src = format!("{alt_home}/review-opus-xuser-{tag}");
    let duet_dst = format!("{duet_home}/review-opus-xuser-{tag}");
    ssh_common::run(&alt, &format!("mkdir -p {0} && chmod 755 {0} && echo from-alt > {0}/note.txt && chmod 644 {0}/note.txt && chmod 755 {1}", q(&alt_src), q(&alt_home))).await;
    ssh_common::run(&duet, &format!("mkdir -p {}", q(&duet_dst))).await;
    let modes =
        ssh_common::stdout_str(&duet, &format!("ls -ld {} {}", q(&duet_home), q(&duet_dst))).await;
    println!("[review] c19 xuser homes: {modes}");

    // alt → duet (alt 패널에서 duet 패널로 복사)
    let plan = copy_plan(
        &alt_fs,
        &duet_fs,
        vec![ssh_common::entry(alt.source_id(), &alt_src, "note.txt")],
        ssh_common::loc(duet.source_id(), &duet_dst),
    )
    .await
    .unwrap();
    println!("[review] c19 xuser strategy = {:?}", plan.strategy);
    let (ctx, _cfg) = ssh_common::mk_ctx(pool.clone()).await;
    let r = copy_execute(
        &alt_fs,
        &duet_fs,
        plan,
        ConflictPolicy::Skip,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await;
    println!(
        "[review] c19 xuser alt->duet same-host copy -> {:?}",
        r.as_ref().map(|_| ()).map_err(|e| e.to_string())
    );
    let owner = ssh_common::stdout_str(&duet, &format!("ls -l {}/ 2>&1", q(&duet_dst))).await;
    println!("[review] c19 xuser dst listing: {owner}");
    // 사용자 기대: duet 패널에 붙여넣었으니 duet 소유로 복사돼야 한다 (relay 라면 그렇다).
    assert!(
        r.is_ok(),
        "same-host copy between different users failed: {r:?}"
    );
}

/// 위 결함의 파급: 받는 폴더에 **다른** 파일 `b.txt` 가 이미 있으면, 충돌 검사는 `a\b.txt`
/// 로 해서 "충돌 없음" → rsync 가 `b.txt` 를 백업 없이 덮어쓴다 (Skip 정책인데도).
#[tokio::test]
#[ignore = "remote-01 repro: backslash name overwrites unrelated file under Skip (docker sshd)"]
async fn c19_same_host_copy_backslash_name_overwrites_unrelated_file() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;
    let base = workdir(&sess, "c19ow").await;
    ssh_common::run(
        &sess.conn,
        &format!(
            "cd {} && mkdir -p src/a dst && echo WRONG > src/a/b.txt && echo RIGHT > 'src/a\\b.txt' && echo PRECIOUS > dst/b.txt",
            q(&base)
        ),
    )
    .await;
    let fs = SshFs::new(sess.conn.clone());
    let plan = copy_plan(
        &fs,
        &fs,
        vec![ssh_common::entry(
            sess.source.clone(),
            format!("{base}/src"),
            "a\\b.txt",
        )],
        ssh_common::loc(sess.source.clone(), format!("{base}/dst")),
    )
    .await
    .unwrap();
    let (ctx, _cfg) = ssh_common::mk_ctx(sess.pool.clone()).await;
    let r = copy_execute(
        &fs,
        &fs,
        plan,
        ConflictPolicy::Skip,
        &ctx,
        CancellationToken::new(),
        None,
    )
    .await;
    let precious = ssh_common::stdout_str(&sess.conn, &format!("cat {}/dst/b.txt", q(&base))).await;
    let trash = ssh_common::stdout_str(
        &sess.conn,
        "find \"$HOME/.duet-trash\" -name 'b.txt*' 2>/dev/null | wc -l",
    )
    .await;
    println!(
        "[review] c19 Skip-policy copy of 'a\\b.txt' -> {:?}; dst/b.txt now = {precious:?}; backups = {trash}",
        r.as_ref().map(|_| ()).map_err(|e| e.to_string())
    );
    assert_eq!(precious, "PRECIOUS", "unrelated dst/b.txt was overwritten");
}
