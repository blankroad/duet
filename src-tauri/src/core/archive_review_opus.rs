//! archive 점검 라운드 재현 테스트 (opus). `super` = core::archive (비공개 함수 접근 가능).
//!
//! 결함 재현 테스트는 "올바른 기대 동작" 을 assert 하므로 지금은 실패한다(lead 가
//! `#[ignore = "archive-NN repro"]` 로 표시). `opus_observe_*` 는 현재 동작을 기록만 한다.
#![allow(unused_imports)]
use super::*;
use crate::fs::LocalFs;
use std::io::Write as _;

// ---------- 공통 도우미 ----------

/// tempdir 안 s.toml/j.jsonl 로 OpCtx 구성 (archive.rs 의 기존 테스트와 같은 방식).
async fn mk_ctx(root: &Path) -> OpCtx {
    let settings = crate::services::settings::SettingsStore::load_from(&root.join("s.toml"))
        .await
        .unwrap();
    let journal = crate::services::journal::Journal::load_from(&root.join("j.jsonl"))
        .await
        .unwrap();
    OpCtx {
        settings,
        journal,
        pool: None,
        app: None,
    }
}

fn local_loc(p: &Path) -> Location {
    Location {
        source: SourceId::Local,
        path: p.to_path_buf(),
    }
}

fn eref(dir: &Path, name: &str) -> EntryRef {
    EntryRef {
        location: local_loc(dir),
        name: name.into(),
    }
}

fn deflated() -> zip::write::FileOptions<'static, 'static, ()> {
    zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated)
}

/// (이름, 내용) 목록으로 zip 생성. 이름이 `/` 로 끝나면 폴더.
fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let f = std::fs::File::create(path).unwrap();
    let mut w = zip::ZipWriter::new(f);
    for (name, data) in entries {
        if name.ends_with('/') {
            w.add_directory(*name, deflated()).unwrap();
        } else {
            w.start_file(*name, deflated()).unwrap();
            w.write_all(data).unwrap();
        }
    }
    w.finish().unwrap();
}

/// zip 항목 이름 (정렬).
fn zip_names(path: &Path) -> Vec<String> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut v: Vec<String> = (0..z.len())
        .map(|i| z.by_index_raw(i).unwrap().name().unwrap().to_string())
        .collect();
    v.sort();
    v
}

/// tar.gz 항목 이름 (정렬). 폴더는 `/` 로 끝난다.
fn targz_names(path: &Path) -> Vec<String> {
    let f = std::fs::File::open(path).unwrap();
    let mut a = tar::Archive::new(flate2::read::GzDecoder::new(f));
    let mut v: Vec<String> = a
        .entries()
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            let mut n = e.path().unwrap().to_string_lossy().into_owned();
            if e.header().entry_type().is_dir() && !n.ends_with('/') {
                n.push('/');
            }
            n
        })
        .collect();
    v.sort();
    v
}

/// 디렉토리 직속 항목 이름 (정렬).
fn ls(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/archive/review")
        .join(name)
}

/// browse 와 같은 방식으로 아카이브를 `<root>/browse/content` 에 푼다 (open_for_browse 의
/// 로컬 분기는 extract_local 을 그대로 부른다 — 시스템 temp 대신 tempdir 을 쓰려고 직접 호출).
fn browse_like(root: &Path, archive: &Path, fmt: ArchiveFormat, pw: Option<&str>) -> PathBuf {
    let content = root.join("browse").join("content");
    std::fs::create_dir_all(&content).unwrap();
    extract_local_blocking(archive, &content, fmt, pw).unwrap();
    content
}

/// browse 폴더(`browse_dir`)를 원본 아카이브로 repack — App.tsx onUpdateArchive →
/// onRepackConfirm 과 같은 호출 순서 (fsRepackPlan → fsCompressExecute).
async fn repack(
    ctx: &OpCtx,
    browse_dir: &Path,
    archive_dir: &Path,
    archive_name: &str,
) -> Result<JournalEntry, DuetError> {
    let local = LocalFs::new();
    let plan = repack_plan(
        &local,
        local_loc(browse_dir),
        eref(archive_dir, archive_name),
    )
    .await?;
    compress_execute(&local, plan, ctx, CancellationToken::new()).await
}

// ---------- C-13 repack ----------

/// archive-02: 하위 폴더 repack 은 거부하고 루트 repack 은 전체 구조와 편집을 보존한다.
#[tokio::test]
async fn opus_repack_from_subfolder_keeps_other_entries() {
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let zip_path = work.join("data.zip");
    write_zip(
        &zip_path,
        &[
            ("readme.txt", b"top"),
            ("docs/", b""),
            ("docs/a.txt", b"a"),
            ("docs/sub/", b""),
            ("docs/sub/b.txt", b"b"),
        ],
    );
    let pool = crate::services::connection_pool::ConnectionPool::new();
    let (content, _) = open_for_browse(eref(&work, "data.zip"), None, &pool)
        .await
        .unwrap();
    // 사용자는 docs 폴더로 들어가 a.txt 를 고친 뒤 "아카이브 업데이트" 를 누른다.
    std::fs::write(content.path.join("docs/a.txt"), b"edited").unwrap();
    let local = LocalFs::new();
    let subfolder = repack_plan(
        &local,
        local_loc(&content.path.join("docs")),
        eref(&work, "data.zip"),
    )
    .await;
    assert!(matches!(subfolder, Err(DuetError::Io(ref msg)) if msg.contains("archive root")));
    repack(&ctx, &content.path, &work, "data.zip")
        .await
        .unwrap();

    assert_eq!(
        zip_names(&zip_path),
        [
            "docs/",
            "docs/a.txt",
            "docs/sub/",
            "docs/sub/b.txt",
            "readme.txt"
        ]
    );
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
    for (name, expected) in [
        ("readme.txt", &b"top"[..]),
        ("docs/a.txt", &b"edited"[..]),
        ("docs/sub/b.txt", &b"b"[..]),
    ] {
        let mut bytes = Vec::new();
        zip.by_name(name).unwrap().read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, expected, "{name}");
    }
    let token_dir = content.path.parent().unwrap();
    assert_eq!(token_dir.parent(), Some(local_browse_root().as_path()));
    std::fs::remove_dir_all(token_dir).unwrap();
}

/// C-13 가설 B: compress_execute 는 기존 아카이브를 백업 이름으로 옮긴 뒤(958) 압축이
/// 실패하면 롤백하지 않는다. 기대: 실패 후 원래 아카이브가 원래 이름에 그대로, 잔재 없음.
#[cfg(unix)]
#[tokio::test]
#[ignore = "archive-03 repro"]
async fn opus_compress_failure_restores_conflicting_archive() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    write_zip(&work.join("out.zip"), &[("old.txt", b"old")]);
    let old_bytes = std::fs::read(work.join("out.zip")).unwrap();
    std::fs::write(work.join("a.txt"), b"a").unwrap();
    std::fs::write(work.join("b.txt"), b"b").unwrap();
    std::fs::set_permissions(work.join("b.txt"), std::fs::Permissions::from_mode(0o000)).unwrap();

    let local = LocalFs::new();
    let plan = compress_plan(
        &local,
        vec![eref(&work, "a.txt"), eref(&work, "b.txt")],
        "out".into(),
        CompressFormat::Zip,
    )
    .await
    .unwrap();
    assert!(plan.conflict);
    let res = compress_execute(&local, plan, &ctx, CancellationToken::new()).await;
    // tempdir 정리를 위해 권한 복구.
    std::fs::set_permissions(work.join("b.txt"), std::fs::Permissions::from_mode(0o644)).unwrap();
    let after = ls(&work);
    eprintln!("compress result = {res:?}; work = {after:?}");
    assert!(res.is_err());
    // undo 로도 못 되돌린다 — journal 에 아무것도 안 남는다.
    assert!(ctx.journal.peek_undoable().await.unwrap().is_none());
    assert_eq!(
        std::fs::read(work.join("out.zip")).unwrap(),
        old_bytes,
        "실패 후 out.zip 이 원래 내용이 아니다"
    );
    assert!(
        !after.iter().any(|n| n.contains(".bak.")),
        "백업 잔재: {after:?}"
    );
}

/// C-13 가설 B 의 현실적 계기: 대상이 없는(dangling) 심볼릭 링크가 든 tar.gz 를 browse →
/// repack. tar_unpack 이 링크를 그대로 만들고, repack 의 tar::Builder(follow=true)·
/// std::fs::metadata 가 링크를 따라가다 실패한다. 기대: repack 성공(링크 보존), 최소한
/// 실패해도 원본 아카이브는 원래 이름에 남아야 한다.
#[cfg(unix)]
#[tokio::test]
#[ignore = "archive-03 repro"]
async fn opus_repack_targz_with_dangling_symlink() {
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let arc = work.join("app.tar.gz");
    {
        let f = std::fs::File::create(&arc).unwrap();
        let enc = flate2::write::GzEncoder::new(f, flate2::Compression::default());
        let mut b = tar::Builder::new(enc);
        let mut h = tar::Header::new_gnu();
        h.set_size(5);
        h.set_mode(0o644);
        h.set_cksum();
        b.append_data(&mut h, "a.txt", &b"hello"[..]).unwrap();
        let mut l = tar::Header::new_gnu();
        l.set_entry_type(tar::EntryType::Symlink);
        l.set_size(0);
        l.set_mode(0o777);
        b.append_link(&mut l, "current", "releases/v2").unwrap();
        b.into_inner().unwrap().finish().unwrap();
    }
    let orig = std::fs::read(&arc).unwrap();
    let content = browse_like(root.path(), &arc, ArchiveFormat::TarGz, None);
    std::fs::write(content.join("a.txt"), b"edited").unwrap();
    let res = repack(&ctx, &content, &work, "app.tar.gz").await;
    let after = ls(&work);
    let intact = std::fs::read(&arc).map(|b| b == orig).unwrap_or(false);
    eprintln!("repack result = {res:?}; work = {after:?}; original intact = {intact}");
    assert!(
        res.is_ok(),
        "repack 실패 — 원본은 백업 이름에 갇힘: {after:?}"
    );
}

/// 암호 zip 을 browse → repack 하면 암호 없는 zip 이 된다 (사용자에게 안내 없음).
/// 기대: 암호가 유지되거나, 최소한 확인 다이얼로그에서 알려야 한다 — 여기선 결과만 본다.
#[tokio::test]
#[ignore = "archive-11 repro"]
async fn opus_repack_encrypted_zip_stays_encrypted() {
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let zip_path = work.join("secret.zip");
    {
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts: zip::write::FileOptions<()> =
            zip::write::FileOptions::default().with_aes_encryption(zip::AesMode::Aes256, "s3cret");
        w.start_file("pay.txt", opts).unwrap();
        w.write_all(b"salary").unwrap();
        w.finish().unwrap();
    }
    let content = browse_like(root.path(), &zip_path, ArchiveFormat::Zip, Some("s3cret"));
    std::fs::write(content.join("note.txt"), b"added").unwrap();
    repack(&ctx, &content, &work, "secret.zip").await.unwrap();

    let mut z = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
    let enc: Vec<(String, bool)> = (0..z.len())
        .map(|i| {
            let e = z.by_index_raw(i).unwrap();
            (e.name().unwrap().to_string(), e.encrypted())
        })
        .collect();
    eprintln!("repacked secret.zip entries (name, encrypted) = {enc:?}");
    assert!(
        enc.iter().all(|(_, e)| *e),
        "repack 후 암호가 사라졌다: {enc:?}"
    );
}

/// repack round-trip 으로 무엇이 보존되는지 표로 기록 (zip). 실패시키지 않고 출력만 —
/// 결과는 보고서 표로 옮긴다. 확실히 보존되는 것(숨김 파일·빈 폴더)만 assert.
#[cfg(unix)]
#[tokio::test]
async fn opus_observe_repack_zip_roundtrip() {
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let zip_path = work.join("proj.zip");
    let mtime = zip::DateTime::from_date_and_time(2020, 1, 2, 3, 4, 6).unwrap();
    {
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        w.set_comment("original comment").unwrap();
        let o = deflated().last_modified_time(mtime);
        w.start_file("run.sh", o.unix_permissions(0o755)).unwrap();
        w.write_all(b"#!/bin/sh\necho hi\n").unwrap();
        w.start_file(".hidden", o).unwrap();
        w.write_all(b"h").unwrap();
        w.add_directory("empty/", o).unwrap();
        w.start_file(
            "stored.txt",
            o.compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        w.write_all(b"stored").unwrap();
        w.add_symlink("link", "run.sh", o).unwrap();
        w.finish().unwrap();
    }
    let dump = |p: &Path| -> Vec<String> {
        let mut z = zip::ZipArchive::new(std::fs::File::open(p).unwrap()).unwrap();
        let mut v: Vec<String> = (0..z.len())
            .map(|i| {
                let e = z.by_index_raw(i).unwrap();
                format!(
                    "{:<11} mode={:<8} mtime={:?} method={:?} symlink={}",
                    e.name().unwrap(),
                    e.unix_mode().map(|m| format!("{m:o}")).unwrap_or_default(),
                    e.last_modified().map(|d| (d.year(), d.month(), d.day())),
                    e.compression(),
                    e.is_symlink()
                )
            })
            .collect();
        v.sort();
        v.push(format!(
            "comment={:?}",
            String::from_utf8_lossy(z.comment())
        ));
        v
    };
    let before = dump(&zip_path);
    let content = browse_like(root.path(), &zip_path, ArchiveFormat::Zip, None);
    let on_disk: Vec<String> = ls(&content)
        .into_iter()
        .map(|n| {
            let m = std::fs::symlink_metadata(content.join(&n)).unwrap();
            use std::os::unix::fs::PermissionsExt;
            format!(
                "{n} symlink={} mode={:o}",
                m.file_type().is_symlink(),
                m.permissions().mode()
            )
        })
        .collect();
    repack(&ctx, &content, &work, "proj.zip").await.unwrap();
    let after = dump(&zip_path);
    eprintln!("BEFORE:\n  {}", before.join("\n  "));
    eprintln!("BROWSE DIR:\n  {}", on_disk.join("\n  "));
    eprintln!("AFTER REPACK:\n  {}", after.join("\n  "));
    let names = zip_names(&zip_path);
    assert!(names.contains(&".hidden".to_string()));
    assert!(names.contains(&"empty/".to_string()));
}

/// 같은 표의 tar.gz 판 — 권한·mtime·빈 폴더·심볼릭 링크(대상 있음).
#[cfg(unix)]
#[tokio::test]
async fn opus_observe_repack_targz_roundtrip() {
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let arc = work.join("proj.tar.gz");
    {
        let f = std::fs::File::create(&arc).unwrap();
        let enc = flate2::write::GzEncoder::new(f, flate2::Compression::default());
        let mut b = tar::Builder::new(enc);
        let mut h = tar::Header::new_gnu();
        h.set_size(3);
        h.set_mode(0o755);
        h.set_mtime(1_577_934_246); // 2020-01-02
        h.set_cksum();
        b.append_data(&mut h, "run.sh", &b"#!\n"[..]).unwrap();
        let mut d = tar::Header::new_gnu();
        d.set_entry_type(tar::EntryType::Directory);
        d.set_size(0);
        d.set_mode(0o755);
        d.set_mtime(1_577_934_246);
        d.set_cksum();
        b.append_data(&mut d, "empty/", std::io::empty()).unwrap();
        let mut l = tar::Header::new_gnu();
        l.set_entry_type(tar::EntryType::Symlink);
        l.set_size(0);
        l.set_mode(0o777);
        b.append_link(&mut l, "link", "run.sh").unwrap();
        b.into_inner().unwrap().finish().unwrap();
    }
    let dump = |p: &Path| -> Vec<String> {
        let f = std::fs::File::open(p).unwrap();
        let mut a = tar::Archive::new(flate2::read::GzDecoder::new(f));
        a.entries()
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                let h = e.header();
                format!(
                    "{:<8} type={:?} mode={:o} mtime={} link={:?}",
                    e.path().unwrap().display(),
                    h.entry_type(),
                    h.mode().unwrap(),
                    h.mtime().unwrap(),
                    h.link_name().ok().flatten()
                )
            })
            .collect()
    };
    let before = dump(&arc);
    let content = browse_like(root.path(), &arc, ArchiveFormat::TarGz, None);
    repack(&ctx, &content, &work, "proj.tar.gz").await.unwrap();
    let after = dump(&arc);
    eprintln!("BEFORE:\n  {}", before.join("\n  "));
    eprintln!("AFTER REPACK:\n  {}", after.join("\n  "));
    assert!(targz_names(&arc).contains(&"empty/".to_string()));
}

// ---------- C-12 압축 만들기 ----------

/// zip 으로 만든 항목의 수정 시각 — zip crate 의 `time` feature 가 꺼져 있으면
/// FileOptions::default() 의 시각이 1980-01-01 로 고정된다. 기대: 원본 파일의 수정 시각.
#[tokio::test]
#[ignore = "archive-12 repro"]
async fn opus_compress_zip_keeps_mtime() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("src");
    std::fs::create_dir(&src).unwrap();
    std::fs::write(src.join("a.txt"), b"a").unwrap();
    let dest = root.path().join("out.zip");
    compress_local_blocking(&src, &["a.txt".into()], &dest, CompressFormat::Zip).unwrap();
    let mut z = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
    let e = z.by_name("a.txt").unwrap();
    let d = e.last_modified().unwrap();
    eprintln!(
        "a.txt in zip mtime = {}-{:02}-{:02} {:02}:{:02}",
        d.year(),
        d.month(),
        d.day(),
        d.hour(),
        d.minute()
    );
    assert!(d.year() >= 2026, "zip 항목 시각이 {}년", d.year());
}

/// 실행 비트 — add_to_zip 은 unix_permissions 를 안 넣어 기본 0o644 가 된다.
#[cfg(unix)]
#[tokio::test]
#[ignore = "archive-12 repro"]
async fn opus_compress_zip_keeps_exec_bit() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("src");
    std::fs::create_dir(&src).unwrap();
    std::fs::write(src.join("run.sh"), b"#!/bin/sh\n").unwrap();
    std::fs::set_permissions(src.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let dest = root.path().join("out.zip");
    compress_local_blocking(&src, &["run.sh".into()], &dest, CompressFormat::Zip).unwrap();
    let mut z = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
    let mode = z.by_name("run.sh").unwrap().unix_mode();
    eprintln!(
        "run.sh unix_mode in zip = {:?}",
        mode.map(|m| format!("{m:o}"))
    );
    assert!(mode.is_some_and(|m| m & 0o111 != 0), "실행 비트 잃음");
}

/// 빈 폴더·숨김 파일·한글/공백 이름 — zip / tar.gz 모두 들어가는지 (정상 경로).
#[tokio::test]
async fn opus_compress_names_and_empty_dirs() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("src");
    std::fs::create_dir_all(src.join("폴더 하나/빈 폴더")).unwrap();
    std::fs::write(src.join("폴더 하나/.env"), b"x").unwrap();
    std::fs::write(src.join("폴더 하나/보고서 최종 (1).txt"), b"y").unwrap();
    for (fmt, name) in [
        (CompressFormat::Zip, "o.zip"),
        (CompressFormat::TarGz, "o.tar.gz"),
    ] {
        let dest = root.path().join(name);
        compress_local_blocking(&src, &["폴더 하나".into()], &dest, fmt).unwrap();
        let names = if name.ends_with(".zip") {
            zip_names(&dest)
        } else {
            targz_names(&dest)
        };
        eprintln!("{name}: {names:?}");
        assert!(names.iter().any(|n| n.ends_with("빈 폴더/")), "{names:?}");
        assert!(names.iter().any(|n| n.ends_with("/.env")), "{names:?}");
        assert!(
            names.iter().any(|n| n.ends_with("보고서 최종 (1).txt")),
            "{names:?}"
        );
        // 압축 결과를 다시 풀어 내용 확인.
        let back = root.path().join(format!("back-{name}"));
        std::fs::create_dir(&back).unwrap();
        let afmt = detect_format(name).unwrap();
        extract_local_blocking(&dest, &back, afmt, None).unwrap();
        assert_eq!(
            std::fs::read(back.join("폴더 하나/보고서 최종 (1).txt")).unwrap(),
            b"y"
        );
    }
}

/// 파일 심볼릭 링크 — zip에 링크 종류와 대상 문자열이 그대로 보존된다.
#[cfg(unix)]
#[tokio::test]
async fn opus_observe_compress_file_symlink() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("src");
    std::fs::create_dir(&src).unwrap();
    std::fs::write(src.join("real.txt"), b"REAL").unwrap();
    std::os::unix::fs::symlink("real.txt", src.join("ln.txt")).unwrap();
    let dest = root.path().join("o.zip");
    compress_local_blocking(&src, &["ln.txt".into()], &dest, CompressFormat::Zip).unwrap();
    let mut z = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
    let mut e = z.by_name("ln.txt").unwrap();
    let mut s = String::new();
    std::io::Read::read_to_string(&mut e, &mut s).unwrap();
    assert!(e.is_symlink());
    assert_eq!(s, "real.txt");
}

/// 폴더 심볼릭 링크가 자기 상위를 가리킬 때 (zip). 순환 → 재귀가 OS 의 링크 해석 한도
/// (macOS 32 / Linux 40)까지 내려가다 ELOOP 로 실패하는지, 스택 오버플로인지 확인.
/// 기대: 링크를 따라가지 않고(또는 순환 감지) 성공.
#[cfg(unix)]
#[tokio::test]
async fn opus_compress_zip_symlink_loop() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("src");
    std::fs::create_dir_all(src.join("proj")).unwrap();
    std::fs::write(src.join("proj/a.txt"), b"a").unwrap();
    std::os::unix::fs::symlink("..", src.join("proj/up")).unwrap();
    let dest = root.path().join("o.zip");
    let res = compress_local_blocking(&src, &["proj".into()], &dest, CompressFormat::Zip);
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    eprintln!("zip loop result = {res:?}; partial size = {size}");
    assert!(res.is_ok(), "{res:?}");
}

/// 같은 순환을 tar.gz 로 (tar::Builder 기본 follow_symlinks=true).
#[cfg(unix)]
#[tokio::test]
async fn opus_compress_targz_symlink_loop() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("src");
    std::fs::create_dir_all(src.join("proj")).unwrap();
    std::fs::write(src.join("proj/a.txt"), b"a").unwrap();
    std::os::unix::fs::symlink("..", src.join("proj/up")).unwrap();
    let dest = root.path().join("o.tar.gz");
    let res = compress_local_blocking(&src, &["proj".into()], &dest, CompressFormat::TarGz);
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    eprintln!("tar.gz loop result = {res:?}; partial size = {size}");
    assert!(res.is_ok(), "{res:?}");
}

/// 순환 링크가 둘이면 경로 수가 2^깊이로 늘어 끝나지 않을 수 있다는 가설 — 5초 안에 끝나는지.
/// 결과(2026-11-08 macOS): 통과. 깊이 우선으로 한 링크가 먼저 ELOOP 에 닿아 압축 전체가
/// 즉시 실패한다 (hang 아님 → 가설 반박, 대신 opus_compress_zip_symlink_loop 의 실패와 같은 결함).
#[cfg(unix)]
#[test]
fn opus_compress_zip_two_symlink_loops_hang() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("src");
    std::fs::create_dir_all(src.join("proj")).unwrap();
    std::fs::write(src.join("proj/a.txt"), b"a").unwrap();
    std::os::unix::fs::symlink(".", src.join("proj/l1")).unwrap();
    std::os::unix::fs::symlink(".", src.join("proj/l2")).unwrap();
    let dest = root.path().join("o.zip");
    let (tx, rx) = std::sync::mpsc::channel();
    let (s2, d2) = (src.clone(), dest.clone());
    std::thread::spawn(move || {
        let r = compress_local_blocking(&s2, &["proj".into()], &d2, CompressFormat::Zip);
        let _ = tx.send(r.map_err(|e| e.to_string()));
    });
    let got = rx.recv_timeout(std::time::Duration::from_secs(5));
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    eprintln!("after 5s: {got:?}; archive size so far = {size} bytes");
    let result = got.expect("5초 안에 끝나지 않음");
    assert!(result.is_ok(), "{result:?}");
}

/// 4 GiB 를 넘는 파일 — add_to_zip 은 large_file(true) 를 안 켠다 → zip 2.4.2
/// write.rs:590 "Large file option has not been set". sparse 파일이라 디스크는 거의 안 쓴다.
#[cfg(unix)]
#[ignore = "archive-13 repro (느림 — 단독 실행)"]
#[test]
fn opus_compress_zip_over_4gib_file() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("src");
    std::fs::create_dir(&src).unwrap();
    let f = std::fs::File::create(src.join("big.bin")).unwrap();
    f.set_len((1u64 << 32) + 1).unwrap();
    drop(f);
    let dest = root.path().join("o.zip");
    let t = std::time::Instant::now();
    let res = compress_local_blocking(&src, &["big.bin".into()], &dest, CompressFormat::Zip);
    eprintln!("4GiB+1 zip result = {res:?} in {:?}", t.elapsed());
    assert!(res.is_ok(), "{res:?}");
}

/// 항목 65,536 개 이상 — zip64 끝 레코드가 자동으로 써지는지 (정상 경로 기대).
#[test]
fn opus_compress_zip_over_65535_entries() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("src");
    let many = src.join("many");
    std::fs::create_dir_all(&many).unwrap();
    const N: usize = 65_600;
    for i in 0..N {
        std::fs::write(many.join(format!("{i}")), b"").unwrap();
    }
    let dest = root.path().join("o.zip");
    compress_local_blocking(&src, &["many".into()], &dest, CompressFormat::Zip).unwrap();
    let z = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
    eprintln!("entries in zip = {}", z.len());
    assert_eq!(z.len(), N + 1); // + "many/" 폴더 항목
}

/// 선택 항목 중에 결과 이름과 같은 아카이브가 있을 때 (a.zip + b.txt 선택 → 이름 "a").
/// 충돌 백업이 a.zip 을 먼저 치우고 File::create 가 새 a.zip 을 만든 뒤, "a.zip" 항목으로
/// 자기 자신(쓰는 중인 파일)을 읽는다. 기대: 사용자가 고른 기존 a.zip 내용이 들어가야 한다.
#[tokio::test]
#[ignore = "archive-22 repro"]
async fn opus_compress_selection_includes_dest_name() {
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    write_zip(&work.join("a.zip"), &[("inner.txt", b"inner")]);
    let a_bytes = std::fs::read(work.join("a.zip")).unwrap();
    std::fs::write(work.join("b.txt"), b"b").unwrap();
    let local = LocalFs::new();
    let plan = compress_plan(
        &local,
        vec![eref(&work, "a.zip"), eref(&work, "b.txt")],
        "a".into(),
        CompressFormat::Zip,
    )
    .await
    .unwrap();
    eprintln!(
        "plan dest = {:?}, conflict = {}",
        plan.dest_path, plan.conflict
    );
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        compress_execute(&local, plan, &ctx, CancellationToken::new()),
    )
    .await
    .expect("20초 안에 끝나지 않음");
    eprintln!("result ok = {}; work = {:?}", res.is_ok(), ls(&work));
    res.unwrap();
    let mut z = zip::ZipArchive::new(std::fs::File::open(work.join("a.zip")).unwrap()).unwrap();
    let mut inner = Vec::new();
    std::io::Read::read_to_end(&mut z.by_name("a.zip").unwrap(), &mut inner).unwrap();
    eprintln!(
        "a.zip entry inside new a.zip: {} bytes (original a.zip = {} bytes)",
        inner.len(),
        a_bytes.len()
    );
    assert_eq!(
        inner, a_bytes,
        "고른 a.zip 대신 쓰는 중인 자기 자신이 들어갔다"
    );
}

/// compress_plan 의 이름 처리 기록 — `..`, `.`, 대문자 확장자, `.tgz`.
#[tokio::test]
async fn opus_observe_compress_plan_names() {
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    std::fs::write(work.join("a.txt"), b"a").unwrap();
    let local = LocalFs::new();
    for (name, fmt) in [
        ("..", CompressFormat::Zip),
        (".", CompressFormat::Zip),
        ("A.ZIP", CompressFormat::Zip),
        ("x.tgz", CompressFormat::TarGz),
        ("x.TAR.GZ", CompressFormat::TarGz),
        ("a.txt", CompressFormat::Zip),
        ("  ", CompressFormat::Zip),
        ("con", CompressFormat::Zip),
        ("a:b", CompressFormat::Zip),
    ] {
        let r = compress_plan(&local, vec![eref(&work, "a.txt")], name.into(), fmt).await;
        eprintln!(
            "{name:?} {fmt:?} -> {:?}",
            r.map(|p| p
                .dest_path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned())
        );
    }
    let p = compress_plan(
        &local,
        vec![eref(&work, "a.txt")],
        "A.ZIP".into(),
        CompressFormat::Zip,
    )
    .await
    .unwrap();
    assert_eq!(p.dest_path.file_name().unwrap(), "A.ZIP");
}

// ---------- C-10 해제 흐름 ----------

/// 충돌 → 백업 → 해제 → undo 로 원래 폴더가 복원되는지 (실제 execute_undo 실행).
#[tokio::test]
async fn opus_extract_conflict_then_undo_restores_original() {
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    write_zip(&work.join("data.zip"), &[("new.txt", b"new")]);
    std::fs::create_dir(work.join("data")).unwrap();
    std::fs::write(work.join("data/keep.txt"), b"keep").unwrap();

    let local = LocalFs::new();
    let plan = extract_plan(&local, eref(&work, "data.zip")).await.unwrap();
    assert!(plan.conflict);
    let (entry, _) = extract_execute(&local, plan, None, &ctx, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(ls(&work.join("data")), vec!["new.txt"]);
    let mid = ls(&work);
    assert!(mid.iter().any(|n| n.starts_with("data.bak.")), "{mid:?}");

    let pool = crate::services::connection_pool::ConnectionPool::new();
    let out = crate::core::undo::execute_undo(&entry, &pool).await;
    eprintln!(
        "undo = {:?} {:?}; work = {:?}",
        out.kind,
        out.message,
        ls(&work)
    );
    assert!(matches!(out.kind, crate::core::undo::UndoKind::Ok));
    assert_eq!(ls(&work.join("data")), vec!["keep.txt"]);
    assert_eq!(ls(&work), vec!["data", "data.zip"]);
}

/// 해제 후 사용자가 결과 폴더에 파일을 더 넣은 뒤 Ctrl+Z → 그 파일까지 영구 삭제된다
/// (UndoCopy 가 copied 경로를 fs.remove = remove_dir_all). 현재 동작 기록용.
#[tokio::test]
async fn opus_observe_extract_undo_deletes_later_user_files() {
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    write_zip(&work.join("data.zip"), &[("new.txt", b"new")]);
    let local = LocalFs::new();
    let plan = extract_plan(&local, eref(&work, "data.zip")).await.unwrap();
    let (entry, _) = extract_execute(&local, plan, None, &ctx, CancellationToken::new())
        .await
        .unwrap();
    std::fs::write(work.join("data/my-notes.txt"), b"typed after extract").unwrap();
    let pool = crate::services::connection_pool::ConnectionPool::new();
    let out = crate::core::undo::execute_undo(&entry, &pool).await;
    eprintln!(
        "undo = {:?}; my-notes.txt exists after undo = {}",
        out.kind,
        work.join("data/my-notes.txt").exists()
    );
    assert!(!work.join("data/my-notes.txt").exists());
}

/// 손상(잘린) tar.gz + 충돌 폴더 → 실패 시 부분 폴더 제거·기존 폴더 복원.
#[tokio::test]
async fn opus_extract_truncated_targz_rolls_back() {
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let arc = work.join("data.tar.gz");
    {
        let f = std::fs::File::create(&arc).unwrap();
        let enc = flate2::write::GzEncoder::new(f, flate2::Compression::none());
        let mut b = tar::Builder::new(enc);
        for i in 0..20 {
            let data = vec![b'x'; 4096];
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            b.append_data(&mut h, format!("f{i}.bin"), &data[..])
                .unwrap();
        }
        b.into_inner().unwrap().finish().unwrap();
    }
    let full = std::fs::read(&arc).unwrap();
    std::fs::write(&arc, &full[..full.len() / 2]).unwrap();
    std::fs::create_dir(work.join("data")).unwrap();
    std::fs::write(work.join("data/keep.txt"), b"keep").unwrap();

    let local = LocalFs::new();
    let plan = extract_plan(&local, eref(&work, "data.tar.gz"))
        .await
        .unwrap();
    let res = extract_execute(&local, plan, None, &ctx, CancellationToken::new()).await;
    eprintln!(
        "truncated tar.gz result = {:?}; work = {:?}",
        res.as_ref().map(|_| ()),
        ls(&work)
    );
    assert!(res.is_err());
    assert_eq!(ls(&work), vec!["data", "data.tar.gz"]);
    assert_eq!(ls(&work.join("data")), vec!["keep.txt"]);
}

/// 단일 파일 .gz 손상 + 같은 이름 파일이 이미 있음 → 실패 시 rollback 의
/// fs.remove(dest_dir)(archive.rs:301) 가 지우는 것은 방금 만든 부분 파일뿐이고,
/// 백업해 둔 사용자 파일이 원래 이름으로 돌아와야 한다.
#[tokio::test]
async fn opus_extract_single_gz_corrupt_rolls_back() {
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let mut gz = Vec::new();
    {
        let mut e = flate2::write::GzEncoder::new(&mut gz, flate2::Compression::default());
        e.write_all(&vec![b'z'; 100_000]).unwrap();
        e.finish().unwrap();
    }
    // 앞부분은 정상, 뒷부분을 망가뜨린다 → 출력 파일이 만들어진 뒤 실패.
    let n = gz.len();
    for b in &mut gz[n / 2..] {
        *b = 0xFF;
    }
    std::fs::write(work.join("log.txt.gz"), &gz).unwrap();
    std::fs::write(work.join("log.txt"), b"mine").unwrap();

    let local = LocalFs::new();
    let plan = extract_plan(&local, eref(&work, "log.txt.gz"))
        .await
        .unwrap();
    assert!(plan.conflict);
    let res = extract_execute(&local, plan, None, &ctx, CancellationToken::new()).await;
    eprintln!(
        "corrupt .gz result = {:?}; work = {:?}",
        res.as_ref().err(),
        ls(&work)
    );
    assert!(res.is_err());
    assert_eq!(ls(&work), vec!["log.txt", "log.txt.gz"]);
    assert_eq!(std::fs::read(work.join("log.txt")).unwrap(), b"mine");
}

// ---------- C-05 암호 ----------

/// ZipCrypto 는 틀린 암호의 1/256 이 헤더 검사(check byte)를 통과한다. 그때 사용자에게
/// "암호 틀림"(NeedPassword → 재입력) 대신 일반 오류가 가는지 확인.
/// 픽스처: tests/fixtures/archive/review/opus-zipcrypto.zip (Info-ZIP `zip -P s3cret`).
#[test]
#[ignore = "archive-20 repro"]
fn opus_zipcrypto_wrong_password_passing_header_check() {
    let arc = fixture("opus-zipcrypto.zip");
    let root = tempfile::tempdir().unwrap();
    // 맞는 암호는 성공.
    let ok = root.path().join("ok");
    std::fs::create_dir(&ok).unwrap();
    extract_local_blocking(&arc, &ok, ArchiveFormat::Zip, Some("s3cret")).unwrap();
    assert!(std::fs::read_to_string(ok.join("secret.txt"))
        .unwrap()
        .starts_with("line 0"));

    let dest = root.path().join("d");
    std::fs::create_dir(&dest).unwrap();
    let mut found = None;
    for i in 0..5000 {
        let pw = format!("wrong{i}");
        match extract_local_blocking(&arc, &dest, ArchiveFormat::Zip, Some(&pw)) {
            Err(DuetError::NeedPassword) => continue,
            other => {
                found = Some((pw, other.map(|_| ())));
                break;
            }
        }
    }
    let (pw, res) = found.expect("5000 개 중 헤더를 통과한 틀린 암호가 없음");
    eprintln!(
        "wrong password {pw:?} passed the header check -> {res:?}; dest = {:?}",
        ls(&dest)
    );
    assert!(
        matches!(res, Err(DuetError::NeedPassword)),
        "틀린 암호인데 재입력 대신: {res:?}"
    );
}

/// 일부 항목만 암호인 zip (plain.txt 무암호 + secret.txt ZipCrypto).
#[test]
fn opus_zip_partially_encrypted() {
    let arc = fixture("opus-mixed.zip");
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    std::fs::create_dir(&a).unwrap();
    let no_pw = extract_local_blocking(&arc, &a, ArchiveFormat::Zip, None);
    eprintln!(
        "mixed zip without password -> {:?}; dest = {:?}",
        no_pw.as_ref().err(),
        ls(&a)
    );
    assert!(matches!(no_pw, Err(DuetError::NeedPassword)));
    let b = root.path().join("b");
    std::fs::create_dir(&b).unwrap();
    extract_local_blocking(&arc, &b, ArchiveFormat::Zip, Some("s3cret")).unwrap();
    assert_eq!(ls(&b), vec!["plain.txt", "secret.txt"]);
    assert_eq!(
        std::fs::read(b.join("plain.txt")).unwrap(),
        b"plain readme\n"
    );
}

// ---------- C-11 browse ----------

/// 로컬 browse 가 NeedPassword 로 실패하면 token 폴더를 남기지 않는지 — 다른 팀 테스트와
/// 시스템 temp(`duet-archive`)를 공유하므로, 이 테스트가 만든 token 이 없다는 것만 본다:
/// 실패 전후 목록 차이에 새 항목이 없어야 한다 (동시 실행 팀이 만든 것은 무시할 수 없어
/// "새 항목 중 content 가 빈 것" 이 없는지로 판정).
#[tokio::test]
#[ignore = "시스템 temp duet-archive 를 공유 — 동시 실행 시 드물게 오탐"]
async fn opus_browse_need_password_leaves_no_token_dir() {
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let zip_path = work.join("s.zip");
    {
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts: zip::write::FileOptions<()> =
            zip::write::FileOptions::default().with_aes_encryption(zip::AesMode::Aes256, "pw");
        w.start_file("x.txt", opts).unwrap();
        w.write_all(b"x").unwrap();
        w.finish().unwrap();
    }
    let broot = local_browse_root();
    let before: std::collections::HashSet<String> = std::fs::read_dir(&broot)
        .map(|r| {
            r.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    let pool = crate::services::connection_pool::ConnectionPool::new();
    let r = open_for_browse(eref(&work, "s.zip"), None, &pool).await;
    assert!(matches!(r, Err(DuetError::NeedPassword)));
    let new_empty: Vec<String> = std::fs::read_dir(&broot)
        .map(|r| {
            r.filter_map(|e| e.ok())
                .filter(|e| !before.contains(&*e.file_name().to_string_lossy()))
                .filter(|e| {
                    std::fs::read_dir(e.path().join("content"))
                        .map(|mut d| d.next().is_none())
                        .unwrap_or(false)
                })
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    assert!(new_empty.is_empty(), "빈 token 폴더 잔재: {new_empty:?}");
}

// =====================================================================
// R2 교차 검토 (opus-2) — sol 발견 독립 재검증. 외부 파일은 모두 별도 tempdir.
// =====================================================================

/// tar 바이트 (이름, 종류, 내용 또는 링크 대상, mode). sol 의 helper 와 독립으로 작성.
fn opus2_tar(entries: &[(&str, tar::EntryType, &[u8], u32)]) -> Vec<u8> {
    let mut b = tar::Builder::new(Vec::new());
    for (name, kind, data, mode) in entries {
        let mut h = tar::Header::new_ustar();
        h.set_entry_type(*kind);
        h.set_mode(*mode);
        h.set_mtime(1_700_000_000);
        if kind.is_symlink() || kind.is_hard_link() {
            h.set_size(0);
            h.set_link_name(std::str::from_utf8(data).unwrap()).unwrap();
            b.append_data(&mut h, name, std::io::empty()).unwrap();
        } else {
            h.set_size(data.len() as u64);
            b.append_data(&mut h, name, *data).unwrap();
        }
    }
    b.into_inner().unwrap()
}

fn opus2_targz(path: &Path, entries: &[(&str, tar::EntryType, &[u8], u32)]) {
    let raw = opus2_tar(entries);
    let f = std::fs::File::create(path).unwrap();
    let mut enc = flate2::write::GzEncoder::new(f, flate2::Compression::fast());
    enc.write_all(&raw).unwrap();
    enc.finish().unwrap();
}

/// `from_dir` 에서 `to` 로 가는 상대 경로 (`../../.tmpX/f`). 두 tempdir 이 같은 부모 아래라고 가정.
fn opus2_rel(from_dir: &Path, to: &Path, common: &Path) -> String {
    let up = from_dir.strip_prefix(common).unwrap().components().count();
    let down = to.strip_prefix(common).unwrap();
    let mut s = "../".repeat(up);
    s.push_str(&down.to_string_lossy());
    s
}

/// 읽기 전용 폴더가 남은 tempdir 을 TempDir 이 지울 수 있게 u+w 를 되돌린다(링크는 따라가지 않음).
#[cfg(unix)]
fn opus2_make_writable(p: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(m) = std::fs::symlink_metadata(p) else {
        return;
    };
    if m.is_dir() {
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755));
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                opus2_make_writable(&e.path());
            }
        }
    }
}

// ---------- archive-01: tar 하드링크 복사 폴백 ----------

/// 새 변형: 대상 이름이 **아직 없는** 바깥 파일을 가리키는 상대 심볼릭 링크(dangling)
/// → 같은 이름 하드링크 → hard_link EEXIST → copy 가 링크를 따라 바깥에 **새 파일을 만든다**.
/// (sol 은 기존 파일 덮어쓰기·절대 경로. 여기선 피해 파일이 없어도 되는 생성 + 상대 경로 + 하위 폴더.)
#[cfg(unix)]
#[test]
fn opus2_hardlink_dst_dangling_symlink_creates_outside_file() {
    let outside = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let common = dest.path().parent().unwrap();
    assert_eq!(outside.path().parent().unwrap(), common);
    let planted = outside.path().join("autorun.sh");
    let target = opus2_rel(&dest.path().join("sub"), &planted, common);
    let bytes = opus2_tar(&[
        ("data/s", tar::EntryType::Regular, b"PAYLOAD", 0o644),
        ("sub/h", tar::EntryType::Symlink, target.as_bytes(), 0o777),
        ("sub/h", tar::EntryType::Link, b"data/s", 0o644),
    ]);
    let r = tar_unpack::unpack(&bytes[..], dest.path());
    eprintln!(
        "dangling dst symlink ({target}) -> {r:?}; outside now = {:?}",
        ls(outside.path())
    );
    assert!(
        !planted.exists(),
        "해제 폴더 밖에 새 파일이 생겼다: {:?}",
        std::fs::read(&planted)
    );
}

/// 앱 경로 그대로(extract_plan → extract_execute, tar.gz) — 바깥 기존 파일 덮어쓰기.
#[cfg(unix)]
#[tokio::test]
async fn opus2_hardlink_dst_symlink_overwrites_outside_via_extract_execute() {
    let outside = tempfile::tempdir().unwrap();
    let victim = outside.path().join("notes.txt");
    std::fs::write(&victim, b"ORIGINAL").unwrap();
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let vt = victim.to_string_lossy().into_owned();
    opus2_targz(
        &work.join("evil.tar.gz"),
        &[
            ("docs/readme.txt", tar::EntryType::Regular, b"OWNED", 0o644),
            ("x", tar::EntryType::Symlink, vt.as_bytes(), 0o777),
            ("x", tar::EntryType::Link, b"docs/readme.txt", 0o644),
        ],
    );
    let local = LocalFs::new();
    let plan = extract_plan(&local, eref(&work, "evil.tar.gz"))
        .await
        .unwrap();
    let r = extract_execute(&local, plan, None, &ctx, CancellationToken::new()).await;
    let now = std::fs::read(&victim).unwrap();
    eprintln!(
        "extract_execute -> ok={} ; victim = {:?}",
        r.is_ok(),
        String::from_utf8_lossy(&now)
    );
    assert_eq!(now, b"ORIGINAL", "해제 폴더 밖 파일이 덮어써졌다");
}

/// 앱 경로 그대로 — 소스가 바깥을 가리키는 상대 링크 + 대상 이름 선점 → 바깥 내용이 안으로 복사.
#[cfg(unix)]
#[tokio::test]
async fn opus2_hardlink_src_symlink_leaks_outside_via_extract_execute() {
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("id_secret");
    std::fs::write(&secret, b"OUTSIDE-SECRET").unwrap();
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    // 해제 폴더 = work/pkg. 링크는 pkg/lib 안에 → 기준 폴더 work/pkg/lib.
    let common = root.path().parent().unwrap();
    assert_eq!(outside.path().parent().unwrap(), common);
    let target = opus2_rel(&work.join("pkg").join("lib"), &secret, common);
    opus2_targz(
        &work.join("pkg.tar.gz"),
        &[
            ("lib/s", tar::EntryType::Symlink, target.as_bytes(), 0o777),
            ("copy.txt", tar::EntryType::Regular, b"placeholder", 0o644),
            ("copy.txt", tar::EntryType::Link, b"lib/s", 0o644),
        ],
    );
    let local = LocalFs::new();
    let plan = extract_plan(&local, eref(&work, "pkg.tar.gz"))
        .await
        .unwrap();
    let r = extract_execute(&local, plan, None, &ctx, CancellationToken::new()).await;
    let copied = work.join("pkg/copy.txt");
    let m = std::fs::symlink_metadata(&copied).ok();
    let content = std::fs::read(&copied).ok();
    eprintln!(
        "extract_execute -> ok={} ; copy.txt is_symlink={:?} content={:?}",
        r.is_ok(),
        m.as_ref().map(|m| m.file_type().is_symlink()),
        content.as_deref().map(String::from_utf8_lossy)
    );
    assert!(
        m.is_some_and(|m| m.file_type().is_symlink())
            || content.as_deref() != Some(&b"OUTSIDE-SECRET"[..]),
        "바깥 파일 내용이 해제 폴더 안 일반 파일로 복사됐다"
    );
}

/// hard_link 가 **성공**하는 경우 (대상 이름 선점 없음): macOS 에서 hard_link(symlink) 는
/// 링크 자체를 하드링크하는가(= 새 노출 없음)? 이어서 같은 이름 일반 파일이 오면 링크를
/// 따라 쓰지 않는가?
#[cfg(unix)]
#[test]
fn opus2_hardlink_success_on_symlink_src() {
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret");
    std::fs::write(&secret, b"OUTSIDE").unwrap();
    let dest = tempfile::tempdir().unwrap();
    let st = secret.to_string_lossy().into_owned();
    // 1단계: s -> 바깥, h = s 의 하드링크 (선점 없음 → hard_link 성공 경로).
    let r1 = tar_unpack::unpack(
        &opus2_tar(&[
            ("s", tar::EntryType::Symlink, st.as_bytes(), 0o777),
            ("h", tar::EntryType::Link, b"s", 0o644),
        ])[..],
        dest.path(),
    );
    let h = dest.path().join("h");
    let after_link = std::fs::symlink_metadata(&h)
        .unwrap()
        .file_type()
        .is_symlink();
    // 2단계: 같은 이름 일반 파일이 뒤따르면 링크를 따라 바깥에 쓰는가.
    let r2 = tar_unpack::unpack(
        &opus2_tar(&[("h", tar::EntryType::Regular, b"OVERWRITE", 0o644)])[..],
        dest.path(),
    );
    eprintln!(
        "{}: r1={r1:?} h_is_symlink_after_hard_link={after_link}; r2={r2:?}; outside secret = {:?}",
        std::env::consts::OS,
        String::from_utf8_lossy(&std::fs::read(&secret).unwrap())
    );
    assert!(after_link, "hard_link 가 링크 대상(바깥 파일)에 붙었다");
    assert_eq!(std::fs::read(&secret).unwrap(), b"OUTSIDE");
}

/// browse(더블클릭) 도 같은 엔진 — open_for_browse 로 실제 실행 (로컬 temp `duet-archive`).
/// token 폴더는 지우지 않고 경로만 출력한다 (앱 시작 시 reap).
#[cfg(unix)]
#[tokio::test]
async fn opus2_browse_hardlink_attack_writes_outside() {
    let outside = tempfile::tempdir().unwrap();
    let planted = outside.path().join("planted-by-browse.txt");
    let work = tempfile::tempdir().unwrap();
    let pt = planted.to_string_lossy().into_owned();
    opus2_targz(
        &work.path().join("look.tgz"),
        &[
            ("a.txt", tar::EntryType::Regular, b"FROM-ARCHIVE", 0o644),
            ("b.txt", tar::EntryType::Symlink, pt.as_bytes(), 0o777),
            ("b.txt", tar::EntryType::Link, b"a.txt", 0o644),
        ],
    );
    let pool = crate::services::connection_pool::ConnectionPool::new();
    let r = open_for_browse(eref(work.path(), "look.tgz"), None, &pool).await;
    eprintln!(
        "open_for_browse -> {:?}; outside = {:?}",
        r.as_ref().map(|(l, rep)| (l.path.clone(), rep.clone())),
        ls(outside.path())
    );
    assert!(
        !planted.exists(),
        "browse(내부 보기)만으로 바깥에 파일이 생겼다"
    );
}

// ---------- archive-04: CP949 이름 ----------

/// 바이트를 직접 써서 CP949(UTF-8 플래그 없음) zip — 공백·숫자·괄호 섞인 이름.
/// 같은 길이의 ASCII 자리표시자로 zip 을 만든 뒤 바이트만 치환 (헤더·중앙 디렉터리 모두).
fn opus2_cp949_zip(path: &Path) {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut buf);
        let o = deflated();
        w.add_directory("PPPPPP 2024/", o).unwrap();
        w.start_file("PPPPPP 2024/QQQQ.xlsx", o).unwrap();
        w.write_all(b"xlsx").unwrap();
        w.start_file("RRRRRR (SSSS).hwp", o).unwrap();
        w.write_all(b"hwp").unwrap();
        w.finish().unwrap();
    }
    let mut bytes = buf.into_inner();
    let subs: [(&[u8], &[u8]); 4] = [
        (b"PPPPPP", &[186, 184, 176, 237, 188, 173]), // 보고서
        (b"QQQQ", &[176, 225, 176, 250]),             // 결과
        (b"RRRRRR", &[200, 184, 192, 199, 183, 207]), // 회의록
        (b"SSSS", &[195, 214, 193, 190]),             // 최종
    ];
    for (from, to) in subs {
        let mut i = 0;
        while i + from.len() <= bytes.len() {
            if &bytes[i..i + from.len()] == from {
                bytes[i..i + from.len()].copy_from_slice(to);
                i += from.len();
            } else {
                i += 1;
            }
        }
    }
    std::fs::write(path, bytes).unwrap();
}

/// 해제 + browse 모두.
#[tokio::test]
async fn opus2_zip_cp949_names_extract_and_browse() {
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let zp = work.join("hangul.zip");
    opus2_cp949_zip(&zp);
    let out = root.path().join("out");
    std::fs::create_dir(&out).unwrap();
    extract_local_blocking(&zp, &out, ArchiveFormat::Zip, None).unwrap();
    let mut got: Vec<String> = ls(&out);
    for d in got.clone() {
        if out.join(&d).is_dir() {
            got.extend(ls(&out.join(&d)).into_iter().map(|n| format!("{d}/{n}")));
        }
    }
    let pool = crate::services::connection_pool::ConnectionPool::new();
    let (loc, _) = open_for_browse(eref(&work, "hangul.zip"), None, &pool)
        .await
        .unwrap();
    eprintln!("extract names = {got:?}");
    eprintln!("browse dir {:?} = {:?}", loc.path, ls(&loc.path));
    assert!(
        got.contains(&"보고서 2024/결과.xlsx".to_string())
            && got.contains(&"회의록 (최종).hwp".to_string()),
        "CP949 이름이 깨졌다: {got:?}"
    );
}

// ---------- archive-08: 읽기 전용 폴더 ----------

/// 0500 폴더 + 중첩(a/ 0555 안 a/b/ 와 a/b/c.txt). tar_unpack 직접.
#[cfg(unix)]
#[test]
fn opus2_tar_readonly_dirs_0500_and_nested_0555() {
    let mut failed = Vec::new();
    for (label, entries) in [
        (
            "0500",
            vec![
                ("ro/", tar::EntryType::Directory, &b""[..], 0o500),
                ("ro/f.txt", tar::EntryType::Regular, &b"f"[..], 0o644),
            ],
        ),
        (
            "nested 0555",
            vec![
                ("a/", tar::EntryType::Directory, &b""[..], 0o555),
                ("a/b/", tar::EntryType::Directory, &b""[..], 0o755),
                ("a/b/c.txt", tar::EntryType::Regular, &b"c"[..], 0o644),
            ],
        ),
    ] {
        let d = tempfile::tempdir().unwrap();
        let bytes = opus2_tar(&entries);
        let r = tar_unpack::unpack(&bytes[..], d.path());
        eprintln!("{label}: {r:?}");
        opus2_make_writable(d.path());
        failed.push((label, r.is_err()));
    }
    assert!(failed.iter().all(|(_, e)| !e), "{failed:?}");
}

/// 같은 모양의 zip (폴더 항목 0555, 그 안 파일) — zip crate 는 폴더 권한을 언제 적용하나 (대조).
#[cfg(unix)]
#[test]
fn opus2_zip_readonly_dir_children() {
    let d = tempfile::tempdir().unwrap();
    let zp = d.path().join("ro.zip");
    {
        let f = std::fs::File::create(&zp).unwrap();
        let mut w = zip::ZipWriter::new(f);
        w.add_directory("ro/", deflated().unix_permissions(0o555))
            .unwrap();
        w.start_file("ro/f.txt", deflated()).unwrap();
        w.write_all(b"f").unwrap();
        w.finish().unwrap();
    }
    let out = d.path().join("out");
    std::fs::create_dir(&out).unwrap();
    let r = extract_local_blocking(&zp, &out, ArchiveFormat::Zip, None);
    eprintln!(
        "zip ro dir: {:?}; children = {:?}",
        r.as_ref().err(),
        ls(&out.join("ro"))
    );
    opus2_make_writable(d.path());
    assert!(r.is_ok());
}

// ---------- archive-09: 롤백 실패 ----------

/// 다른 계기: tar.gz, 폴더 0500 → 그 안 두 번째 파일 실패 → 부분 폴더를 못 지워 백업 복원 실패.
#[cfg(unix)]
#[tokio::test]
#[ignore = "archive-09 repro"]
async fn opus2_extract_rollback_failure_strands_backup() {
    let root = tempfile::tempdir().unwrap();
    let ctx = mk_ctx(root.path()).await;
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    std::fs::create_dir(work.join("site")).unwrap();
    std::fs::write(work.join("site/index.html"), b"MY WORK").unwrap();
    opus2_targz(
        &work.join("site.tar.gz"),
        &[
            ("assets/logo.svg", tar::EntryType::Regular, b"<svg/>", 0o644),
            ("assets/", tar::EntryType::Directory, b"", 0o500),
            ("assets/app.css", tar::EntryType::Regular, b"body{}", 0o644),
        ],
    );
    let local = LocalFs::new();
    let plan = extract_plan(&local, eref(&work, "site.tar.gz"))
        .await
        .unwrap();
    assert!(plan.conflict);
    let r = extract_execute(&local, plan, None, &ctx, CancellationToken::new()).await;
    let after = ls(&work);
    let in_site = ls(&work.join("site"));
    eprintln!("error = {:?}", r.as_ref().err());
    eprintln!("work = {after:?}; site/ = {in_site:?}");
    eprintln!(
        "journal has undo entry = {}",
        ctx.journal.peek_undoable().await.unwrap().is_some()
    );
    opus2_make_writable(root.path());
    assert!(r.is_err());
    assert_eq!(
        std::fs::read(work.join("site/index.html")).ok().as_deref(),
        Some(&b"MY WORK"[..]),
        "기존 site/ 가 원위치에 복원되지 않았다"
    );
}

// ---------- archive-17: 7z 대소문자 충돌 ----------

#[test]
fn opus2_sevenz_case_collision_not_silent() {
    use sevenz_rust2::{ArchiveEntry, ArchiveWriter};
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("case.7z");
    {
        let mut w = ArchiveWriter::create(&p).unwrap();
        w.push_archive_entry(
            ArchiveEntry::new_file("Report.txt"),
            Some(std::io::Cursor::new(b"UPPER-FIRST".to_vec())),
        )
        .unwrap();
        w.push_archive_entry(
            ArchiveEntry::new_file("report.txt"),
            Some(std::io::Cursor::new(b"lower-second".to_vec())),
        )
        .unwrap();
        w.finish().unwrap();
    }
    let out = d.path().join("out");
    let r = extract_sevenz(&p, &out, None);
    let names = ls(&out);
    let contents: Vec<String> = names
        .iter()
        .map(|n| String::from_utf8_lossy(&std::fs::read(out.join(n)).unwrap()).into_owned())
        .collect();
    eprintln!("7z case collision: {r:?}; names = {names:?}; contents = {contents:?}");
    assert!(
        names.len() == 2 || r.is_err(),
        "한 파일이 조용히 덮였다: {names:?} {contents:?}"
    );
}

// ---------- archive-18: ZipCrypto 링크·실행 비트 ----------

/// 픽스처 opus-zipcrypto-link.zip: Info-ZIP `zip -y -P s3cret` — run.sh(0755) + link -> run.sh.
#[cfg(unix)]
#[test]
fn opus2_zipcrypto_preserves_link_and_exec() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    extract_local_blocking(
        &fixture("opus-zipcrypto-link.zip"),
        d.path(),
        ArchiveFormat::Zip,
        Some("s3cret"),
    )
    .unwrap();
    let link = std::fs::symlink_metadata(d.path().join("link")).unwrap();
    let mode = std::fs::metadata(d.path().join("run.sh"))
        .unwrap()
        .permissions()
        .mode();
    eprintln!(
        "ZipCrypto: link is_symlink={} ; run.sh mode={:o}",
        link.file_type().is_symlink(),
        mode & 0o777
    );
    assert!(link.file_type().is_symlink(), "링크가 일반 파일이 됐다");
    assert_eq!(mode & 0o777, 0o755, "실행 비트를 잃었다");
}
