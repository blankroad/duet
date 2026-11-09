//! archive 점검 라운드 재현 테스트 (sol). `super` = core::archive.
use super::*;
use std::io::{self, Cursor, Write};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/archive/review")
        .join(name)
}
fn fixture_extract(name: &str) -> (tempfile::TempDir, Result<UnpackReport, DuetError>) {
    let d = tempfile::tempdir().unwrap();
    let r = extract_local_blocking(&fixture(name), d.path(), ArchiveFormat::Zip, None);
    eprintln!("{name}: {r:?}");
    (d, r)
}
// archive-06: 7-Zip·반디집 등이 고른 방식(BZip2·LZMA·Zstd)의 zip — Python zipfile 픽스처.
macro_rules! codec_test {
    ($test:ident, $file:literal) => {
        #[test]
        fn $test() {
            let (d, r) = fixture_extract($file);
            assert!(r.is_ok(), "valid ZIP should extract: {r:?}");
            assert_eq!(
                std::fs::read(d.path().join("hello.txt")).unwrap(),
                b"hello archive review\n"
            );
        }
    };
}
codec_test!(sol_zip_bzip2, "sol-bzip2.zip");
codec_test!(sol_zip_lzma, "sol-lzma.zip");
codec_test!(sol_zip_zstd, "sol-zstd.zip");
/// 방식 번호만 XZ·PPMd 로 바꾼 stored zip — 이제 해당 디코더로 가서 "깨진 데이터" 오류로
/// 끝나야 한다(패닉·멈춤 없이). 정상 XZ·PPMd 는 아래 왕복 테스트.
#[test]
fn sol_zip_xz_ppmd_method_dispatch() {
    for name in ["sol-xz-method-only.zip", "sol-ppmd-method-only.zip"] {
        let (_, r) = fixture_extract(name);
        assert!(matches!(r, Err(DuetError::Io(_))), "{name}: {r:?}");
    }
}
/// archive-06: XZ·PPMd 방식 zip 해제·내부 보기. Python 은 이 두 방식을 못 써서 zip crate 로
/// 만든다(같은 crate 왕복 — 7-Zip 산출물 확인은 기기 확인 목록).
#[tokio::test]
async fn zip_xz_and_ppmd_methods_extract_and_browse() {
    let d = tempfile::tempdir().unwrap();
    for (name, method) in [
        ("xz.zip", zip::CompressionMethod::Xz),
        ("ppmd.zip", zip::CompressionMethod::Ppmd),
        ("bzip2.zip", zip::CompressionMethod::Bzip2),
        ("zstd.zip", zip::CompressionMethod::Zstd),
    ] {
        let p = d.path().join(name);
        {
            let mut w = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
            let o: zip::write::FileOptions<'_, '_, ()> =
                zip::write::FileOptions::default().compression_method(method);
            w.add_directory("docs/", o).unwrap();
            w.start_file("docs/hello.txt", o).unwrap();
            w.write_all(&b"hello archive review\n".repeat(50)).unwrap();
            w.finish().unwrap();
        }
        let out = d.path().join(format!("out-{name}"));
        std::fs::create_dir(&out).unwrap();
        extract_local_blocking(&p, &out, ArchiveFormat::Zip, None)
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(
            std::fs::read(out.join("docs/hello.txt")).unwrap(),
            b"hello archive review\n".repeat(50),
            "{name}"
        );
        let pool = crate::services::connection_pool::ConnectionPool::new();
        let (loc, _) = open_for_browse(sol2_entry(d.path(), name), None, &pool)
            .await
            .unwrap_or_else(|e| panic!("browse {name}: {e:?}"));
        assert!(loc.path.join("docs/hello.txt").is_file(), "browse {name}");
    }
}
fn names(d: &Path) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(d)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}
#[test]
fn sol_zip_cp949_names() {
    let (d, r) = fixture_extract("sol-cp949.zip");
    r.unwrap();
    eprintln!("CP949 names: {:?}", names(d.path()));
    assert!(
        d.path().join("한글.txt").exists(),
        "actual names {:?}",
        names(d.path())
    );
    assert!(d.path().join("폴더/문서.txt").exists());
}
#[test]
#[ignore = "archive-04: Shift-JIS 는 CP949 와 구분 불가 — 범위 밖 (core/zip_names.rs 모듈 설명)"]
fn sol_zip_sjis_names() {
    let (d, r) = fixture_extract("sol-sjis.zip");
    r.unwrap();
    assert!(
        d.path().join("日本語.txt").exists(),
        "actual names {:?}",
        names(d.path())
    );
}
#[test]
fn sol_zip_unicode_extra() {
    let (d, r) = fixture_extract("sol-unicode-extra.zip");
    r.unwrap();
    assert!(d.path().join("한글.txt").exists());
}
fn zip_file(path: &Path, encrypted: bool, entries: &[(&str, &[u8])], symlink: bool) {
    let mut w = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o755);
    let options = if encrypted {
        options.with_aes_encryption(zip::AesMode::Aes256, "secret")
    } else {
        options
    };
    for (name, data) in entries {
        w.start_file(*name, options).unwrap();
        w.write_all(data).unwrap();
    }
    if symlink {
        w.add_symlink("link", "script.sh", options).unwrap();
    }
    w.finish().unwrap();
}
#[cfg(unix)]
#[test]
fn sol_zip_encrypted_preserves_symlink() {
    let d = tempfile::tempdir().unwrap();
    for encrypted in [false, true] {
        let p = d.path().join(format!("{encrypted}.zip"));
        let out = d.path().join(format!("out-{encrypted}"));
        std::fs::create_dir(&out).unwrap();
        zip_file(&p, encrypted, &[("script.sh", b"#!/bin/sh\n")], true);
        extract_local_blocking(&p, &out, ArchiveFormat::Zip, Some("secret")).unwrap();
        assert!(
            std::fs::symlink_metadata(out.join("link"))
                .unwrap()
                .file_type()
                .is_symlink(),
            "encrypted={encrypted}: link became a regular file"
        );
    }
}
#[cfg(unix)]
#[test]
fn sol_zip_encrypted_preserves_executable() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    for encrypted in [false, true] {
        let p = d.path().join(format!("{encrypted}.zip"));
        let out = d.path().join(format!("out-{encrypted}"));
        std::fs::create_dir(&out).unwrap();
        zip_file(&p, encrypted, &[("script.sh", b"#!/bin/sh\n")], false);
        extract_local_blocking(&p, &out, ArchiveFormat::Zip, Some("secret")).unwrap();
        let mode = std::fs::metadata(out.join("script.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o755, "encrypted={encrypted}");
    }
}
#[test]
fn sol_zip_traversal_both_paths() {
    let d = tempfile::tempdir().unwrap();
    for encrypted in [false, true] {
        let p = d.path().join(format!("{encrypted}.zip"));
        let out = d.path().join(format!("out-{encrypted}"));
        std::fs::create_dir(&out).unwrap();
        let abs = d
            .path()
            .join(format!("absolute-{encrypted}.txt"))
            .to_string_lossy()
            .into_owned();
        zip_file(
            &p,
            encrypted,
            &[
                ("../evil.txt", b"evil"),
                (&abs, b"evil"),
                ("safe.txt", b"safe"),
            ],
            false,
        );
        let r = extract_local_blocking(&p, &out, ArchiveFormat::Zip, Some("secret"));
        eprintln!(
            "zip traversal encrypted={encrypted}: {r:?}; output={:?}",
            names(&out)
        );
        assert!(!d.path().join("evil.txt").exists());
        assert!(!Path::new(&abs).exists());
    }
}
#[test]
fn sol_zip_case_collision_not_silent() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("case.zip");
    let out = d.path().join("out");
    std::fs::create_dir(&out).unwrap();
    zip_file(
        &p,
        false,
        &[("A.txt", b"FIRST"), ("a.txt", b"SECOND")],
        false,
    );
    let r = extract_local_blocking(&p, &out, ArchiveFormat::Zip, None);
    let collision =
        out.join("A.txt").exists() && out.join("a.txt").exists() && names(&out).len() == 1;
    eprintln!("zip case collision: {r:?}, {:?}", names(&out));
    assert!(
        !collision || r.is_err() || r.as_ref().is_ok_and(|r| !r.renamed.is_empty()),
        "silent overwrite: {r:?}"
    );
}
fn tar_bytes(entries: &[(&str, tar::EntryType, &[u8], u32)]) -> Vec<u8> {
    let mut b = tar::Builder::new(Vec::new());
    for (name, kind, data, mode) in entries {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(*kind);
        h.set_mode(*mode);
        h.set_mtime(1);
        if kind.is_symlink() || kind.is_hard_link() {
            h.set_size(0);
            h.set_link_name(std::str::from_utf8(data).unwrap()).unwrap();
            b.append_data(&mut h, name, io::empty()).unwrap();
        } else {
            h.set_size(data.len() as u64);
            b.append_data(&mut h, name, *data).unwrap();
        }
    }
    b.into_inner().unwrap()
}
#[cfg(unix)]
#[test]
fn sol_tar_directory_over_symlink_blocked() {
    use std::os::unix::fs::PermissionsExt;
    let outside = tempfile::tempdir().unwrap();
    std::fs::set_permissions(outside.path(), std::fs::Permissions::from_mode(0o750)).unwrap();
    let target = outside.path().to_string_lossy().into_owned();
    let d = tempfile::tempdir().unwrap();
    let bytes = tar_bytes(&[
        ("d", tar::EntryType::Symlink, target.as_bytes(), 0o777),
        ("d/", tar::EntryType::Directory, b"", 0o777),
    ]);
    let r = tar_unpack::unpack(&bytes[..], d.path());
    eprintln!("directory over symlink: {r:?}");
    assert!(r.is_err());
    assert_eq!(
        std::fs::metadata(outside.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o750
    );
}
#[cfg(unix)]
#[test]
fn sol_tar_hardlink_source_symlink_no_copy() {
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret");
    std::fs::write(&secret, b"secret").unwrap();
    let target = secret.to_string_lossy().into_owned();
    let d = tempfile::tempdir().unwrap();
    let bytes = tar_bytes(&[
        ("s", tar::EntryType::Symlink, target.as_bytes(), 0o777),
        ("h", tar::EntryType::Link, b"s", 0o644),
    ]);
    let r = tar_unpack::unpack(&bytes[..], d.path());
    eprintln!("hardlink source symlink: {r:?}");
    assert!(
        r.is_err()
            || std::fs::symlink_metadata(d.path().join("h"))
                .unwrap()
                .file_type()
                .is_symlink(),
        "must not copy an external target as regular file"
    );
}
#[cfg(unix)]
#[test]
fn sol_tar_hardlink_destination_symlink_cannot_overwrite_outside() {
    let outside = tempfile::tempdir().unwrap();
    let victim = outside.path().join("victim");
    std::fs::write(&victim, b"ORIGINAL").unwrap();
    let target = victim.to_string_lossy().into_owned();
    let d = tempfile::tempdir().unwrap();
    let bytes = tar_bytes(&[
        ("s", tar::EntryType::Regular, b"ATTACK", 0o644),
        ("h", tar::EntryType::Symlink, target.as_bytes(), 0o777),
        ("h", tar::EntryType::Link, b"s", 0o644),
    ]);
    let r = tar_unpack::unpack(&bytes[..], d.path());
    eprintln!("hardlink destination symlink: {r:?}");
    assert_eq!(
        std::fs::read(&victim).unwrap(),
        b"ORIGINAL",
        "outside archive destination was modified: {r:?}"
    );
}
#[cfg(unix)]
#[test]
fn sol_tar_regular_over_symlink_safe() {
    let outside = tempfile::tempdir().unwrap();
    let victim = outside.path().join("victim");
    std::fs::write(&victim, b"ORIGINAL").unwrap();
    let target = victim.to_string_lossy().into_owned();
    let d = tempfile::tempdir().unwrap();
    let bytes = tar_bytes(&[
        ("x", tar::EntryType::Symlink, target.as_bytes(), 0o777),
        ("x", tar::EntryType::Regular, b"new", 0o644),
    ]);
    tar_unpack::unpack(&bytes[..], d.path()).unwrap();
    assert_eq!(std::fs::read(&victim).unwrap(), b"ORIGINAL");
    assert_eq!(std::fs::read(d.path().join("x")).unwrap(), b"new");
}
#[cfg(unix)]
#[test]
fn sol_tar_readonly_directory_children() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let bytes = tar_bytes(&[
        ("ro/", tar::EntryType::Directory, b"", 0o555),
        ("ro/f.txt", tar::EntryType::Regular, b"data", 0o644),
    ]);
    let r = tar_unpack::unpack(&bytes[..], d.path());
    eprintln!("readonly dir: {r:?}");
    // Restore test-owned permissions so TempDir can clean up even after the expected failure.
    std::fs::set_permissions(d.path().join("ro"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        r.is_ok(),
        "valid read-only-directory tarball must extract children: {r:?}"
    );
}
#[test]
fn sol_tar_special_files_longname_pax_absolute() {
    let d = tempfile::tempdir().unwrap();
    let long = format!("{}/file.txt", "a".repeat(140));
    let bytes = tar_bytes(&[
        ("pipe", tar::EntryType::Fifo, b"", 0o644),
        ("device", tar::EntryType::Char, b"", 0o644),
        (&long, tar::EntryType::Regular, b"long", 0o644),
    ]);
    let r = tar_unpack::unpack(&bytes[..], d.path());
    eprintln!("special/longname: {r:?}");
    r.unwrap();
    assert!(std::fs::metadata(d.path().join("pipe")).unwrap().is_file());
    assert!(std::fs::metadata(d.path().join("device"))
        .unwrap()
        .is_file());
    assert_eq!(std::fs::read(d.path().join(&long)).unwrap(), b"long");
    let mut b = tar::Builder::new(Vec::new());
    b.append_pax_extensions([("path", b"pax/path.txt".as_slice())])
        .unwrap();
    let mut h = tar::Header::new_ustar();
    h.set_mode(0o644);
    h.set_size(3);
    b.append_data(&mut h, "placeholder", b"pax".as_slice())
        .unwrap();
    tar_unpack::unpack(&b.into_inner().unwrap()[..], d.path()).unwrap();
    assert_eq!(
        std::fs::read(d.path().join("pax/path.txt")).unwrap(),
        b"pax"
    );
    let mut bytes = tar_bytes(&[("placeholder", tar::EntryType::Regular, b"abs", 0o644)]);
    bytes[..100].fill(0);
    bytes[..6].copy_from_slice(b"/abs/x");
    let mut h = tar::Header::new_gnu();
    h.as_mut_bytes().copy_from_slice(&bytes[..512]);
    h.set_cksum();
    bytes[..512].copy_from_slice(h.as_bytes());
    tar_unpack::unpack(&bytes[..], d.path()).unwrap();
    assert_eq!(std::fs::read(d.path().join("abs/x")).unwrap(), b"abs");
}
#[test]
fn sol_tar_case_collision_not_silent() {
    let d = tempfile::tempdir().unwrap();
    let bytes = tar_bytes(&[
        ("A.txt", tar::EntryType::Regular, b"FIRST", 0o644),
        ("a.txt", tar::EntryType::Regular, b"SECOND", 0o644),
    ]);
    let r = tar_unpack::unpack(&bytes[..], d.path());
    let collision = names(d.path()).len() == 1;
    eprintln!("tar case collision: {r:?}, {:?}", names(d.path()));
    assert!(
        !collision || r.is_err() || r.as_ref().is_ok_and(|r| !r.renamed.is_empty()),
        "silent overwrite: {r:?}"
    );
}
fn sevenz_file(path: &Path, entries: &[(&str, bool)], encrypted: bool, header: bool) {
    use sevenz_rust2::{
        encoder_options::{AesEncoderOptions, Lzma2Options},
        ArchiveEntry, ArchiveWriter, Password,
    };
    let mut w = ArchiveWriter::create(path).unwrap();
    w.set_encrypt_header(header);
    if encrypted {
        w.set_content_methods(vec![
            AesEncoderOptions::new(Password::new("secret")).into(),
            Lzma2Options::from_level(1).into(),
        ]);
    }
    for (name, dir) in entries {
        if *dir {
            w.push_archive_entry(ArchiveEntry::new_directory(name), None::<Cursor<Vec<u8>>>)
                .unwrap();
        } else {
            w.push_archive_entry(
                ArchiveEntry::new_file(name),
                Some(Cursor::new(b"hello sevenz".to_vec())),
            )
            .unwrap();
        }
    }
    w.finish().unwrap();
}
#[test]
fn sol_sevenz_normal_and_empty_dir() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("a.7z");
    let out = d.path().join("out");
    sevenz_file(
        &p,
        &[("empty", true), ("folder/a.txt", false)],
        false,
        false,
    );
    extract_sevenz(&p, &out, None).unwrap();
    assert!(out.join("empty").is_dir());
    assert_eq!(
        std::fs::read(out.join("folder/a.txt")).unwrap(),
        b"hello sevenz"
    );
}
#[test]
fn sol_sevenz_traversal_blocked() {
    let d = tempfile::tempdir().unwrap();
    for (i, name) in ["../evil.txt", "..\\evil.txt", "/absolute/evil.txt"]
        .iter()
        .enumerate()
    {
        let p = d.path().join(format!("{i}.7z"));
        let out = d.path().join(format!("out{i}"));
        sevenz_file(&p, &[(name, false)], false, false);
        let r = extract_sevenz(&p, &out, None);
        eprintln!("7z traversal {name}: {r:?}");
        assert!(r.is_err());
        assert!(!d.path().join("evil.txt").exists());
    }
}
#[test]
fn sol_sevenz_password_mapping() {
    let d = tempfile::tempdir().unwrap();
    let mut mapping_failures = Vec::new();
    for header in [false, true] {
        let p = d.path().join(format!("{header}.7z"));
        sevenz_file(&p, &[("file.txt", false)], true, header);
        for (i, password) in [None, Some("wrong"), Some("secret")]
            .into_iter()
            .enumerate()
        {
            let out = d.path().join(format!("out-{header}-{i}"));
            let r = extract_sevenz(&p, &out, password);
            eprintln!("7z header={header} password-case={i}: {r:?}");
            if i == 2 {
                assert!(r.is_ok(), "{r:?}");
            } else if !matches!(r, Err(DuetError::NeedPassword)) {
                mapping_failures.push(format!("header={header}, case={i}: {r:?}"));
            }
        }
    }
    assert!(
        mapping_failures.is_empty(),
        "must allow password retry: {mapping_failures:?}"
    );
}
#[test]
fn sol_sevenz_corrupt_error() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("a.7z");
    sevenz_file(&p, &[("file.txt", false)], false, false);
    let mut bytes = std::fs::read(&p).unwrap();
    bytes[12] ^= 0x80;
    std::fs::write(&p, bytes).unwrap();
    let r = extract_sevenz(&p, &d.path().join("out"), None);
    eprintln!("7z corrupt: {r:?}");
    assert!(matches!(r, Err(DuetError::Io(_))));
}

#[cfg(unix)]
#[test]
fn sol_tar_hardlink_fallback_cannot_copy_outside_source() {
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret");
    std::fs::write(&secret, b"OUTSIDE SECRET").unwrap();
    let target = secret.to_string_lossy().into_owned();
    let d = tempfile::tempdir().unwrap();
    let bytes = tar_bytes(&[
        ("s", tar::EntryType::Symlink, target.as_bytes(), 0o777),
        ("h", tar::EntryType::Regular, b"placeholder", 0o644),
        ("h", tar::EntryType::Link, b"s", 0o644),
    ]);
    let r = tar_unpack::unpack(&bytes[..], d.path());
    eprintln!("hardlink source fallback: {r:?}");
    let h = d.path().join("h");
    // 하드링크가 링크 자체를 가리키면(h 가 심볼릭 링크) 내용 복사는 없다 —
    // `sol_tar_hardlink_source_symlink_no_copy` 와 같은 기준. read 는 링크를 따라가므로 lstat 로 먼저 본다.
    assert!(
        r.is_err()
            || std::fs::symlink_metadata(&h)
                .unwrap()
                .file_type()
                .is_symlink()
            || std::fs::read(&h).unwrap() != b"OUTSIDE SECRET",
        "outside secret copied into extracted regular file: {r:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "archive-09 repro"]
async fn sol_tar_readonly_failure_restores_conflicting_destination() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    // Existing child then a read-only directory header: a later child fails, and
    // cleanup must still recover the user's original conflicting destination.
    let bytes = tar_bytes(&[
        ("ro/first.txt", tar::EntryType::Regular, b"first", 0o644),
        ("ro/", tar::EntryType::Directory, b"", 0o555),
        ("ro/second.txt", tar::EntryType::Regular, b"second", 0o644),
    ]);
    std::fs::write(work.join("readonly.tar"), bytes).unwrap();
    let dest = work.join("readonly");
    std::fs::create_dir(&dest).unwrap();
    std::fs::write(dest.join("keep.txt"), b"ORIGINAL").unwrap();
    let ctx = OpCtx {
        settings: crate::services::settings::SettingsStore::load_from(&root.path().join("s.toml"))
            .await
            .unwrap(),
        journal: crate::services::journal::Journal::load_from(&root.path().join("j.jsonl"))
            .await
            .unwrap(),
        pool: None,
        app: None,
    };
    let local = crate::fs::LocalFs::new();
    let entry = EntryRef {
        location: Location {
            source: SourceId::Local,
            path: work.clone(),
        },
        name: "readonly.tar".into(),
    };
    let plan = extract_plan(&local, entry).await.unwrap();
    let r = extract_execute(&local, plan, None, &ctx, CancellationToken::new()).await;
    eprintln!(
        "readonly rollback: {r:?}; work={:?}; dest={:?}",
        names(&work),
        names(&dest)
    );
    if dest.join("ro").exists() {
        std::fs::set_permissions(dest.join("ro"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(
        r.is_ok()
            || std::fs::read(dest.join("keep.txt")).ok().as_deref() == Some(b"ORIGINAL".as_slice()),
        "failed extraction must restore the original directory: {r:?}; work={:?}",
        names(&work)
    );
}

// R2: independent observations; assertions describe the currently observed defects.
async fn sol2_ctx(root: &Path) -> OpCtx {
    OpCtx {
        settings: crate::services::settings::SettingsStore::load_from(&root.join("settings.toml"))
            .await
            .unwrap(),
        journal: crate::services::journal::Journal::load_from(&root.join("journal.jsonl"))
            .await
            .unwrap(),
        pool: None,
        app: None,
    }
}
fn sol2_loc(p: &Path) -> Location {
    Location {
        source: SourceId::Local,
        path: p.into(),
    }
}
fn sol2_entry(p: &Path, n: &str) -> EntryRef {
    EntryRef {
        location: sol2_loc(p),
        name: n.into(),
    }
}
fn sol2_zip_names(p: &Path) -> Vec<String> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(p).unwrap()).unwrap();
    (0..z.len())
        .map(|i| z.by_index_raw(i).unwrap().name().unwrap().into_owned())
        .collect()
}
fn sol2_tar_names(p: &Path) -> Vec<String> {
    let f = flate2::read::GzDecoder::new(std::fs::File::open(p).unwrap());
    tar::Archive::new(f)
        .entries()
        .unwrap()
        .map(|e| e.unwrap().path().unwrap().to_string_lossy().into_owned())
        .collect()
}
fn sol2_gz(b: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(b).unwrap();
    e.finish().unwrap()
}

#[tokio::test]
async fn sol2_subfolder_repack_zip_and_targz() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("src");
    std::fs::create_dir_all(src.join("x/y")).unwrap();
    std::fs::write(src.join("x/y/z.txt"), b"nested").unwrap();
    std::fs::write(src.join("top.txt"), b"top").unwrap();
    let ctx = sol2_ctx(d.path()).await;
    let fs = crate::fs::LocalFs::new();
    let pool = crate::services::connection_pool::ConnectionPool::new();
    for (n, c, a) in [
        ("a.zip", CompressFormat::Zip, ArchiveFormat::Zip),
        ("a.tar.gz", CompressFormat::TarGz, ArchiveFormat::TarGz),
    ] {
        let p = d.path().join(n);
        compress_local_blocking(&src, &["x".into(), "top.txt".into()], &p, c).unwrap();
        let (browse, _) = open_for_browse(sol2_entry(d.path(), n), None, &pool)
            .await
            .unwrap();
        std::fs::write(browse.path.join("x/y/z.txt"), b"edited nested").unwrap();
        let subfolder = repack_plan(
            &fs,
            sol2_loc(&browse.path.join("x/y")),
            sol2_entry(d.path(), n),
        )
        .await;
        assert!(matches!(subfolder, Err(DuetError::Io(ref msg)) if msg.contains("archive root")));
        let plan = repack_plan(&fs, browse.clone(), sol2_entry(d.path(), n))
            .await
            .unwrap();
        assert_eq!(plan.item_names.len(), 2);
        assert!(plan.item_names.contains(&"top.txt".into()));
        assert!(plan.item_names.contains(&"x".into()));
        compress_execute(&fs, plan, &ctx, CancellationToken::new())
            .await
            .unwrap();
        let list = if n.ends_with(".zip") {
            sol2_zip_names(&p)
        } else {
            sol2_tar_names(&p)
        };
        assert!(list.contains(&"top.txt".into()), "{n}: {list:?}");
        assert!(list.contains(&"x/y/z.txt".into()), "{n}: {list:?}");
        let restored = tempfile::tempdir().unwrap();
        extract_local_blocking(&p, restored.path(), a, None).unwrap();
        assert_eq!(
            std::fs::read(restored.path().join("top.txt")).unwrap(),
            b"top"
        );
        assert_eq!(
            std::fs::read(restored.path().join("x/y/z.txt")).unwrap(),
            b"edited nested"
        );
        let token_dir = browse.path.parent().unwrap();
        assert_eq!(token_dir.parent(), Some(local_browse_root().as_path()));
        std::fs::remove_dir_all(token_dir).unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "archive-03 현재 결함을 관찰(통과=결함 있음) — 수정 시 기대값 반전"]
async fn sol2_failed_targz_conflict_dangling_link_no_rollback() {
    let d = tempfile::tempdir().unwrap();
    let ctx = sol2_ctx(d.path()).await;
    std::fs::write(d.path().join("ok.txt"), b"ok").unwrap();
    std::os::unix::fs::symlink("missing-target", d.path().join("bad-link")).unwrap();
    let dest = d.path().join("out.tar.gz");
    std::fs::write(d.path().join("previous.txt"), b"previous version").unwrap();
    compress_local_blocking(
        d.path(),
        &["previous.txt".into()],
        &dest,
        CompressFormat::TarGz,
    )
    .unwrap();
    let original = std::fs::read(&dest).unwrap();
    let fs = crate::fs::LocalFs::new();
    let p = compress_plan(
        &fs,
        vec![
            sol2_entry(d.path(), "ok.txt"),
            sol2_entry(d.path(), "bad-link"),
        ],
        "out".into(),
        CompressFormat::TarGz,
    )
    .await
    .unwrap();
    assert!(p.conflict);
    let r = compress_execute(&fs, p, &ctx, CancellationToken::new()).await;
    let journal = ctx.journal.peek_undoable().await.unwrap();
    let backup = names(d.path())
        .into_iter()
        .find(|n| n.starts_with("out.tar.gz.bak"))
        .unwrap();
    eprintln!(
        "tar failure={r:?}; output={} bytes; backup={backup}; journal_empty={}",
        std::fs::metadata(&dest).unwrap().len(),
        journal.is_none()
    );
    assert!(r.is_err());
    assert!(journal.is_none());
    assert_eq!(std::fs::read(d.path().join(backup)).unwrap(), original);
    assert_ne!(std::fs::read(dest).unwrap(), original);
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "archive-03 현재 결함을 관찰(통과=결함 있음) — 수정 시 기대값 반전"]
async fn sol2_failed_zip_permission_leaves_openable_partial() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let ctx = sol2_ctx(d.path()).await;
    std::fs::write(d.path().join("first.txt"), b"first payload").unwrap();
    let denied = d.path().join("locked.txt");
    std::fs::write(&denied, b"unreadable payload").unwrap();
    std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o000)).unwrap();
    assert!(
        std::fs::File::open(&denied).is_err(),
        "requires unprivileged runner"
    );
    let fs = crate::fs::LocalFs::new();
    let p = compress_plan(
        &fs,
        vec![
            sol2_entry(d.path(), "first.txt"),
            sol2_entry(d.path(), "locked.txt"),
        ],
        "partial".into(),
        CompressFormat::Zip,
    )
    .await
    .unwrap();
    assert!(!p.conflict);
    let r = compress_execute(&fs, p, &ctx, CancellationToken::new()).await;
    std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o600)).unwrap();
    let dest = d.path().join("partial.zip");
    let list = sol2_zip_names(&dest);
    let mut z = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
    let mut first = Vec::new();
    z.by_name("first.txt")
        .unwrap()
        .read_to_end(&mut first)
        .unwrap();
    let empty_size = z.by_name("locked.txt").unwrap().size();
    let journal_empty = ctx.journal.peek_undoable().await.unwrap().is_none();
    eprintln!("zip failure={r:?}; openable entries={list:?}; locked_size={empty_size}; journal_empty={journal_empty}");
    assert!(r.is_err());
    assert_eq!(first, b"first payload");
    assert_eq!(empty_size, 0);
    assert!(journal_empty);
}

#[cfg(unix)]
#[test]
fn sol2_file_symlink_and_dangling_both_formats() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("src");
    std::fs::create_dir(&src).unwrap();
    std::fs::write(src.join("target"), b"target bytes").unwrap();
    std::os::unix::fs::symlink("target", src.join("alias")).unwrap();
    std::os::unix::fs::symlink("no-such-target", src.join("dangling")).unwrap();
    // Nested links exercise tar::Builder's recursive default, rather than just the top-level stat.
    std::fs::create_dir(src.join("nested")).unwrap();
    std::os::unix::fs::symlink("../target", src.join("nested/alias2")).unwrap();
    for (n, c, a) in [
        ("links.zip", CompressFormat::Zip, ArchiveFormat::Zip),
        ("links.tar.gz", CompressFormat::TarGz, ArchiveFormat::TarGz),
    ] {
        let p = d.path().join(n);
        compress_local_blocking(&src, &["alias".into(), "nested".into()], &p, c).unwrap();
        let out = d.path().join(format!("out-{n}"));
        std::fs::create_dir(&out).unwrap();
        extract_local_blocking(&p, &out, a, None).unwrap();
        for (name, target) in [("alias", "target"), ("nested/alias2", "../target")] {
            assert!(std::fs::symlink_metadata(out.join(name))
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(
                std::fs::read_link(out.join(name)).unwrap(),
                Path::new(target)
            );
        }
        let dangling_archive = d.path().join(format!("dangling-{n}"));
        compress_local_blocking(
            &src,
            &["alias".into(), "dangling".into()],
            &dangling_archive,
            c,
        )
        .unwrap();
        let dangling_out = tempfile::tempdir().unwrap();
        extract_local_blocking(&dangling_archive, dangling_out.path(), a, None).unwrap();
        assert!(
            std::fs::symlink_metadata(dangling_out.path().join("dangling"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            std::fs::read_link(dangling_out.path().join("dangling")).unwrap(),
            Path::new("no-such-target")
        );
    }
}

/// 바깥 파일/폴더 링크는 링크 항목 두 개만 저장하고 외부 본문을 가져오지 않는다.
#[cfg(unix)]
#[test]
fn sol2_file_symlink_and_dangling_both_formats_external_targets() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("src");
    let outside = d.path().join("outside");
    std::fs::create_dir(&src).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let file = outside.join("secret.txt");
    std::fs::write(&file, b"must not be archived").unwrap();
    std::os::unix::fs::symlink(&file, src.join("file-link")).unwrap();
    std::os::unix::fs::symlink(&outside, src.join("dir-link")).unwrap();
    for (name, format) in [
        ("external.zip", CompressFormat::Zip),
        ("external.tar.gz", CompressFormat::TarGz),
    ] {
        let path = d.path().join(name);
        compress_local_blocking(
            &src,
            &["file-link".into(), "dir-link".into()],
            &path,
            format,
        )
        .unwrap();
        match format {
            CompressFormat::Zip => {
                let mut zip = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
                assert_eq!(zip.len(), 2);
                for (member, target) in [("file-link", &file), ("dir-link", &outside)] {
                    let mut entry = zip.by_name(member).unwrap();
                    assert!(entry.is_symlink(), "{member}");
                    let mut body = String::new();
                    entry.read_to_string(&mut body).unwrap();
                    assert_eq!(body, target.to_string_lossy());
                }
            }
            CompressFormat::TarGz => {
                let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(
                    std::fs::File::open(&path).unwrap(),
                ));
                let mut count = 0;
                for entry in tar.entries().unwrap() {
                    let entry = entry.unwrap();
                    assert!(entry.header().entry_type().is_symlink());
                    let target = if entry.path().unwrap() == Path::new("file-link") {
                        &file
                    } else {
                        &outside
                    };
                    assert_eq!(entry.link_name().unwrap().unwrap().as_ref(), target);
                    count += 1;
                }
                assert_eq!(count, 2);
            }
        }
    }
}

#[tokio::test]
#[ignore = "archive-11 현재 결함을 관찰(통과=결함 있음) — 수정 시 기대값 반전"]
async fn sol2_zipcrypto_repack_removes_encryption() {
    let d = tempfile::tempdir().unwrap();
    let ctx = sol2_ctx(d.path()).await;
    std::fs::write(d.path().join("secret.bin"), b"zipcrypto private data").unwrap();
    let p = d.path().join("private.zip");
    let output = std::process::Command::new("/usr/bin/zip")
        .current_dir(d.path())
        .args(["-q", "-P", "sol2-secret", "private.zip", "secret.bin"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let mut z = zip::ZipArchive::new(std::fs::File::open(&p).unwrap()).unwrap();
    assert!(z.by_index_raw(0).unwrap().encrypted());
    drop(z);
    let browse = d.path().join("browse");
    std::fs::create_dir(&browse).unwrap();
    extract_local_blocking(&p, &browse, ArchiveFormat::Zip, Some("sol2-secret")).unwrap();
    let fs = crate::fs::LocalFs::new();
    let plan = repack_plan(&fs, sol2_loc(&browse), sol2_entry(d.path(), "private.zip"))
        .await
        .unwrap();
    compress_execute(&fs, plan, &ctx, CancellationToken::new())
        .await
        .unwrap();
    let mut z = zip::ZipArchive::new(std::fs::File::open(&p).unwrap()).unwrap();
    assert!(!z.by_index_raw(0).unwrap().encrypted());
    let mut plain = Vec::new();
    z.by_index(0).unwrap().read_to_end(&mut plain).unwrap();
    eprintln!("ZipCrypto before=true after=false; password-free data={plain:?}");
    assert_eq!(plain, b"zipcrypto private data");
}

#[cfg(unix)]
#[test]
#[ignore = "archive-12 현재 결함을 관찰(통과=결함 있음) — 수정 시 기대값 반전"]
fn sol2_zip_metadata_compared_to_targz() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("src");
    std::fs::create_dir(&src).unwrap();
    let p = src.join("run.sh");
    std::fs::write(&p, b"#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o751)).unwrap();
    let f = std::fs::File::options().write(true).open(&p).unwrap();
    f.set_times(
        std::fs::FileTimes::new()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_123)),
    )
    .unwrap();
    let zip = d.path().join("m.zip");
    let tgz = d.path().join("m.tar.gz");
    compress_local_blocking(&src, &["run.sh".into()], &zip, CompressFormat::Zip).unwrap();
    compress_local_blocking(&src, &["run.sh".into()], &tgz, CompressFormat::TarGz).unwrap();
    let mut z = zip::ZipArchive::new(std::fs::File::open(zip).unwrap()).unwrap();
    let entry = z.by_index(0).unwrap();
    let dt = entry.last_modified().unwrap();
    let mode = entry.unix_mode().unwrap();
    let mut t = tar::Archive::new(flate2::read::GzDecoder::new(
        std::fs::File::open(tgz).unwrap(),
    ));
    let te = t.entries().unwrap().next().unwrap().unwrap();
    let tm = te.header().mtime().unwrap();
    let tmode = te.header().mode().unwrap();
    eprintln!("ZIP date={dt:?} mode={mode:o}; TAR mtime={tm} mode={tmode:o}");
    assert_eq!((dt.year(), dt.month(), dt.day()), (1980, 1, 1));
    assert_eq!(mode & 0o111, 0);
    assert_eq!(tm, 1_700_000_123);
    assert_eq!(tmode & 0o777, 0o751);
}

#[test]
#[ignore = "archive-20 현재 결함을 관찰(통과=결함 있음) — 수정 시 기대값 반전"]
fn sol2_zipcrypto_wrong_password_error_class() {
    let d = tempfile::tempdir().unwrap();
    let payload: Vec<u8> = (0..20000).map(|i| (i * 37 % 251) as u8).collect();
    std::fs::write(d.path().join("payload.bin"), &payload).unwrap();
    assert!(std::process::Command::new("/usr/bin/zip")
        .current_dir(d.path())
        .args(["-q", "-P", "correct-sol2", "crypto.zip", "payload.bin"])
        .output()
        .unwrap()
        .status
        .success());
    let p = d.path().join("crypto.zip");
    let out = d.path().join("out");
    std::fs::create_dir(&out).unwrap();
    extract_local_blocking(&p, &out, ArchiveFormat::Zip, Some("correct-sol2")).unwrap();
    let mut found = None;
    for n in 0..8192 {
        let pw = format!("different-{n}-R2");
        match extract_local_blocking(&p, &out, ArchiveFormat::Zip, Some(&pw)) {
            Err(DuetError::NeedPassword) => (),
            other => {
                found = Some((pw, other));
                break;
            }
        }
    }
    let (pw, r) = found.expect("no wrong password passed header in 8192 trials");
    eprintln!("ZipCrypto wrong password {pw:?}: {r:?}");
    assert!(matches!(r, Err(DuetError::Io(_))));
}

#[tokio::test]
#[ignore = "archive-03 현재 결함을 관찰(통과=결함 있음) — 수정 시 기대값 반전"]
async fn sol2_pre_cancelled_compress_moves_original_without_journal() {
    let d = tempfile::tempdir().unwrap();
    let ctx = sol2_ctx(d.path()).await;
    std::fs::write(d.path().join("input.txt"), b"input").unwrap();
    std::fs::write(d.path().join("cancel.zip"), b"original archive bytes").unwrap();
    let fs = crate::fs::LocalFs::new();
    let plan = compress_plan(
        &fs,
        vec![sol2_entry(d.path(), "input.txt")],
        "cancel".into(),
        CompressFormat::Zip,
    )
    .await
    .unwrap();
    let token = CancellationToken::new();
    token.cancel();
    let r = compress_execute(&fs, plan, &ctx, token).await;
    let journal_empty = ctx.journal.peek_undoable().await.unwrap().is_none();
    eprintln!(
        "pre-cancel={r:?}; original_exists={}; names={:?}; journal_empty={journal_empty}",
        d.path().join("cancel.zip").exists(),
        names(d.path())
    );
    assert!(matches!(r, Err(DuetError::Cancelled)));
    assert!(!d.path().join("cancel.zip").exists());
    assert!(journal_empty);
}

/// archive-22: 결과 파일이 선택 항목 자신이면 plan 에서 거부하고 기존 파일은 그대로 둔다.
/// (예전 관찰: 기존 아카이브 대신 쓰는 중인 자기 자신을 담았다.)
#[tokio::test]
async fn sol2_self_selection_zip_and_targz() {
    let d = tempfile::tempdir().unwrap();
    let fs = crate::fs::LocalFs::new();
    for (n, c) in [
        ("self.zip", CompressFormat::Zip),
        ("self.tar.gz", CompressFormat::TarGz),
    ] {
        std::fs::write(d.path().join(n), b"PREVIOUS ARCHIVE").unwrap();
        let p = compress_plan(&fs, vec![sol2_entry(d.path(), n)], n.into(), c).await;
        eprintln!("self-selection {n}: {p:?}");
        assert!(matches!(p, Err(DuetError::IntoItself(_))), "{n}: {p:?}");
        assert_eq!(
            std::fs::read(d.path().join(n)).unwrap(),
            b"PREVIOUS ARCHIVE"
        );
    }
}

#[test]
#[ignore = "archive-27 현재 결함을 관찰(통과=결함 있음) — 수정 시 기대값 반전"]
fn sol2_remote_backslash_multiple_arguments() {
    let p = Path::new("/data/project\\draft/한글\\v2.tar.gz");
    let cmd =
        remote_extract_command(p, Path::new("/tmp/out\\one"), ArchiveFormat::TarGz, None).unwrap();
    eprintln!("backslash extract command={cmd}");
    assert!(cmd.contains("/data/project/draft/한글/v2.tar.gz"));
    assert!(!cmd.contains('\\'));
    let mixed = shell_escape_path(Path::new("/home/u\\x.zip")).unwrap();
    eprintln!("mixed Windows repack destination exec={mixed}");
    assert_eq!(mixed, "'/home/u/x.zip'");
}

#[tokio::test]
async fn sol2_repack_join_independent_sentinel_and_zip_update() {
    let d = tempfile::tempdir().unwrap();
    let browse = d.path().join("browse");
    std::fs::create_dir(&browse).unwrap();
    std::fs::write(browse.join("kept"), b"new").unwrap();
    let mut fs = crate::fs::testing::TestFs::new(&d.path().join("fs_join_sentinel"));
    fs.override_join = true;
    let original = sol2_entry(d.path(), "remote.zip");
    let expected = fs.join(&original.location.path, &original.name);
    let plan = repack_plan(&fs, sol2_loc(&browse), original).await.unwrap();
    eprintln!("repack dest={:?}; fs.join={expected:?}", plan.dest_path);
    assert_eq!(plan.dest_path, expected);
    // Host-side Info-ZIP update preserves an entry absent from the new browse folder.
    std::fs::write(browse.join("removed"), b"old").unwrap();
    let p = d.path().join("update.zip");
    assert!(std::process::Command::new("/usr/bin/zip")
        .current_dir(&browse)
        .arg("-q")
        .arg(&p)
        .args(["kept", "removed"])
        .output()
        .unwrap()
        .status
        .success());
    std::fs::rename(browse.join("removed"), d.path().join("removed-from-browse")).unwrap();
    std::fs::write(browse.join("kept"), b"edited").unwrap();
    assert!(std::process::Command::new("/usr/bin/zip")
        .current_dir(&browse)
        .args(["-r", "-q"])
        .arg(&p)
        .args(["--", "kept"])
        .output()
        .unwrap()
        .status
        .success());
    let list = sol2_zip_names(&p);
    eprintln!("Info-ZIP update retained names={list:?}");
    assert!(list.contains(&"removed".into()));
}

#[test]
#[ignore = "archive-28 현재 결함을 관찰(통과=결함 있음) — 수정 시 기대값 반전"]
fn sol2_gz_padding_single_vs_tar() {
    let d = tempfile::tempdir().unwrap();
    for (n, fmt, data) in [
        (
            "single.txt.gz",
            ArchiveFormat::Gz,
            b"different R2 payload".to_vec(),
        ),
        (
            "bundle.tar.gz",
            ArchiveFormat::TarGz,
            tar_bytes(&[("inside.txt", tar::EntryType::Regular, b"tar data", 0o644)]),
        ),
    ] {
        let mut b = sol2_gz(&data);
        b.extend_from_slice(&[0; 1024]);
        let p = d.path().join(n);
        std::fs::write(&p, b).unwrap();
        let out = tempfile::tempdir().unwrap();
        let r = extract_local_blocking(&p, out.path(), fmt, None);
        eprintln!("zero padding {n}: {r:?}");
        if n.starts_with("single") {
            assert!(r.is_err());
            assert_eq!(std::fs::read(out.path().join("single.txt")).unwrap(), data);
        } else {
            r.unwrap();
            assert_eq!(
                std::fs::read(out.path().join("inside.txt")).unwrap(),
                b"tar data"
            );
        }
    }
}

fn sol2_zstd_frame(b: &[u8]) -> Vec<u8> {
    let mut child = std::process::Command::new("zstd")
        .args(["-q", "-c"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    out.stdout
}
#[test]
#[ignore = "archive-29 현재 결함을 관찰(통과=결함 있음) — 수정 시 기대값 반전"]
fn sol2_zstd_skippable_middle_single_and_tar() {
    let d = tempfile::tempdir().unwrap();
    let mut skip = 0x184D_2A5Du32.to_le_bytes().to_vec();
    skip.extend_from_slice(&7u32.to_le_bytes());
    skip.extend_from_slice(b"R2-meta");
    for (n, fmt, data) in [
        (
            "stream.txt.zst",
            ArchiveFormat::Zst,
            b"before middle skip after".to_vec(),
        ),
        (
            "stream.tar.zst",
            ArchiveFormat::TarZst,
            tar_bytes(&[(
                "inside.txt",
                tar::EntryType::Regular,
                b"after middle",
                0o644,
            )]),
        ),
    ] {
        let split = if n.ends_with("tar.zst") { 256 } else { 7 };
        let f1 = sol2_zstd_frame(&data[..split]);
        let f2 = sol2_zstd_frame(&data[split..]);
        let out = tempfile::tempdir().unwrap();
        let p = d.path().join(n);
        std::fs::write(&p, [&f1[..], &f2[..]].concat()).unwrap();
        extract_local_blocking(&p, out.path(), fmt, None).unwrap();
        std::fs::write(&p, [&f1[..], &skip[..], &f2[..]].concat()).unwrap();
        let r = extract_local_blocking(&p, out.path(), fmt, None);
        eprintln!("middle skippable {n}: {r:?}");
        assert!(r.is_err());
    }
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "archive-14 현재 결함을 관찰(통과=결함 있음) — 수정 시 기대값 반전"]
async fn sol2_cancel_after_zip_io_started_still_succeeds() {
    let d = tempfile::tempdir().unwrap();
    let ctx = sol2_ctx(d.path()).await;
    let fifo = d.path().join("stream-input");
    assert!(std::process::Command::new("/usr/bin/mkfifo")
        .arg(&fifo)
        .output()
        .unwrap()
        .status
        .success());
    let fs = crate::fs::LocalFs::new();
    let plan = compress_plan(
        &fs,
        vec![sol2_entry(d.path(), "stream-input")],
        "cancel-during".into(),
        CompressFormat::Zip,
    )
    .await
    .unwrap();
    let token = CancellationToken::new();
    let producer_token = token.clone();
    let producer = std::thread::spawn(move || {
        // Opening the FIFO completes only once add_to_zip has passed the sole
        // cancellation check, started the ZIP entry, and opened the input.
        let mut f = std::fs::OpenOptions::new().write(true).open(fifo).unwrap();
        producer_token.cancel();
        f.write_all(b"payload delivered after cancellation")
            .unwrap();
    });
    let r = compress_execute(&fs, plan, &ctx, token.clone()).await;
    producer.join().unwrap();
    let journal_present = ctx.journal.peek_undoable().await.unwrap().is_some();
    eprintln!(
        "mid-IO cancel: token_cancelled={} result_ok={} journal_present={journal_present}",
        token.is_cancelled(),
        r.is_ok()
    );
    assert!(token.is_cancelled());
    r.unwrap();
    assert!(journal_present);
    let mut z =
        zip::ZipArchive::new(std::fs::File::open(d.path().join("cancel-during.zip")).unwrap())
            .unwrap();
    let mut payload = Vec::new();
    z.by_index(0).unwrap().read_to_end(&mut payload).unwrap();
    assert_eq!(payload, b"payload delivered after cancellation");
}
