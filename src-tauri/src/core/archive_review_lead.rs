//! archive 점검 라운드 재현 테스트 (lead). `super` = core::archive (비공개 함수 접근 가능).
#![allow(unused_imports)]
use super::*;
use std::io::Write;

async fn test_ctx(root: &Path) -> OpCtx {
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

fn gz(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

/// C-01: 분할 압축 첫 조각은 아카이브로 인식되지 않는다 — 더블클릭·"압축 풀기"가 안 뜬다.
/// (현재 동작 기록용 — 통과.) `.part1.rar` 는 `.rar` 로 인식된다.
#[test]
fn lead_split_volume_names() {
    for name in ["a.7z.001", "a.zip.001", "a.z01", "a.tar.gz.001"] {
        assert_eq!(detect_format(name), None, "{name}");
    }
    assert_eq!(detect_format("a.part1.rar"), Some(ArchiveFormat::Rar));
    assert_eq!(detect_format("a.part2.rar"), Some(ArchiveFormat::Rar));
    // 이름이 접미사뿐이면 `<name>.extracted`.
    assert_eq!(archive_stem(".zip"), ".zip.extracted");
    assert_eq!(archive_stem("DATA.TAR.GZ"), "DATA");
}

/// C-14: 원격 명령 인용 — 공백·작은따옴표·한글·`-` 로 시작하는 이름. (통과 = 문제 없음)
#[test]
fn lead_remote_commands_quote_awkward_names() {
    let a = Path::new("/srv/it's 한글/-x.zip");
    let d = Path::new("/srv/it's 한글/-x");
    assert_eq!(
        remote_extract_command(a, d, ArchiveFormat::Zip, Some("p'w")).unwrap(),
        r#"unzip -P 'p'\''w' -o '/srv/it'\''s 한글/-x.zip' -d '/srv/it'\''s 한글/-x'"#
    );
    assert_eq!(
        remote_list_command(a, ArchiveFormat::Zip).unwrap(),
        r#"unzip -Z1 '/srv/it'\''s 한글/-x.zip'"#
    );
}

/// C-14 (lead-01): 원격 경로 안 `\` 는 리눅스에선 파일 이름의 일부인데, exec 용 인용이
/// `/` 로 바꿔 버린다 — `a\b.zip` 같은 원격 파일은 풀기·목록이 다른 경로를 가리킨다.
/// SFTP 쪽(`fs/ssh.rs` `remote_path_str`)은 `\` 를 보존하므로 두 경로가 어긋난다.
#[test]
#[ignore = "archive-27 repro"]
fn lead_remote_command_keeps_backslash_in_names() {
    let cmd = remote_list_command(Path::new("/srv/a\\b.zip"), ArchiveFormat::Zip).unwrap();
    assert_eq!(cmd, r"unzip -Z1 '/srv/a\b.zip'");
}

/// C-14 (lead-02): repack_plan 은 `fs.join` 대신 `PathBuf::join` 으로 원본 경로를 만든다.
/// Windows 클라이언트 + 원격 아카이브면 `/home/u\x.zip` 이 되어 SFTP stat 이 실패 →
/// 충돌(=백업)을 못 보고, 호스트 명령은 `\`→`/` 로 고쳐 원본을 **백업 없이** 덮어쓴다.
/// 여기서는 join 을 바꾼 TestFs 로 "fs.join 을 쓰지 않음" 을 보인다.
#[tokio::test]
async fn lead_repack_plan_uses_fs_join() {
    let root = tempfile::tempdir().unwrap();
    let browse = root.path().join("browse");
    std::fs::create_dir(&browse).unwrap();
    std::fs::write(browse.join("a.txt"), b"a").unwrap();
    let mut fs = crate::fs::testing::TestFs::new(&root.path().join("joined"));
    fs.override_join = true;
    let original = EntryRef {
        location: Location {
            source: SourceId::Local,
            path: root.path().join("dl"),
        },
        name: "x.zip".into(),
    };
    let plan = repack_plan(
        &fs,
        Location {
            source: SourceId::Local,
            path: browse,
        },
        original.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        plan.dest_path,
        fs.join(&original.location.path, &original.name),
        "repack_plan must build the archive path with fs.join (POSIX on remote)"
    );
}

/// C-08: 단일 .gz 해제 중 손상 → 부분 파일이 지워지고, 충돌로 옮겨 둔 기존 파일이 복원된다. (통과 기대)
#[tokio::test]
async fn lead_single_file_corrupt_rolls_back() {
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let mut bytes = gz(&vec![b'x'; 200_000]);
    let n = bytes.len();
    for b in &mut bytes[n / 2..n - 8] {
        *b ^= 0x5a;
    }
    std::fs::write(work.join("log.txt.gz"), &bytes).unwrap();
    std::fs::write(work.join("log.txt"), b"previous").unwrap();
    let ctx = test_ctx(root.path()).await;
    let local = crate::fs::LocalFs::new();
    let entry = EntryRef {
        location: Location {
            source: SourceId::Local,
            path: work.clone(),
        },
        name: "log.txt.gz".into(),
    };
    let plan = extract_plan(&local, entry).await.unwrap();
    assert!(plan.conflict);
    let r = extract_execute(&local, plan, None, &ctx, CancellationToken::new()).await;
    assert!(r.is_err(), "corrupt gz must fail");
    assert_eq!(std::fs::read(work.join("log.txt")).unwrap(), b"previous");
    let names: Vec<_> = std::fs::read_dir(&work)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 2, "no leftover backup/partial: {names:?}");
}

/// C-08 (lead-03): 끝에 0 으로 채운 gzip(테이프·일부 다운로드 도구가 남김) — `gzip -d` 는
/// 경고만 하고 푸는데 여기선 해제 전체가 실패한다.
#[test]
#[ignore = "archive-28 repro"]
fn lead_gz_trailing_zeros_still_decodes() {
    let dir = tempfile::tempdir().unwrap();
    let mut bytes = gz(b"hello\n");
    bytes.extend_from_slice(&[0u8; 512]);
    let arc = dir.path().join("pad.txt.gz");
    std::fs::write(&arc, &bytes).unwrap();
    let out = dir.path().join("out");
    std::fs::create_dir(&out).unwrap();
    let r = extract_local_blocking(&arc, &out, ArchiveFormat::Gz, None);
    assert!(r.is_ok(), "trailing zero padding should be ignored: {r:?}");
}

/// C-08 (lead-04): zstd 건너뛰기 프레임(skippable frame, magic 0x184D2A5?) — pzstd 출력·
/// seekable 형식이 쓴다. `zstd -d` 는 무시하고 푼다.
#[test]
#[ignore = "archive-29 repro"]
fn lead_zst_skippable_frame_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("plain.txt");
    std::fs::write(&src, b"hello zstd\n").unwrap();
    let z = dir.path().join("plain.txt.zst.tmp");
    let st = std::process::Command::new("zstd")
        .arg("-q")
        .arg("-o")
        .arg(&z)
        .arg(&src)
        .status();
    let Ok(st) = st else {
        eprintln!("zstd CLI not found — skip");
        return;
    };
    assert!(st.success());
    let frame = std::fs::read(&z).unwrap();
    // 건너뛰기 프레임: magic(LE) + 길이(LE u32) + 내용.
    let mut skip = Vec::new();
    skip.extend_from_slice(&0x184D_2A50u32.to_le_bytes());
    skip.extend_from_slice(&4u32.to_le_bytes());
    skip.extend_from_slice(b"meta");
    for (label, bytes) in [
        ("skippable first", [skip.clone(), frame.clone()].concat()),
        ("skippable last", [frame.clone(), skip.clone()].concat()),
    ] {
        let arc = dir.path().join("x.txt.zst");
        std::fs::write(&arc, &bytes).unwrap();
        let out = tempfile::tempdir().unwrap();
        let r = extract_local_blocking(&arc, out.path(), ArchiveFormat::Zst, None);
        assert!(r.is_ok(), "{label}: {r:?}");
        assert_eq!(
            std::fs::read(out.path().join("x.txt")).unwrap(),
            b"hello zstd\n",
            "{label}"
        );
    }
}
