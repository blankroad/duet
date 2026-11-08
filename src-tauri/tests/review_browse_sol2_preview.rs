//! Independent R2 range inputs and encoding boundary evidence; no app/server used.
use duet_lib::fs::{FileSystem, LocalFs};

const STREAM_SOURCE: &str = include_str!("../src/services/preview_stream.rs");
const DECODE_SOURCE: &str = include_str!("../src/commands/fs_ops.rs");
const CAP: usize = 16 * 1024 * 1024;

fn verified_range_want(total: u64, start: u64, end_opt: Option<u64>) -> usize {
    assert!(STREAM_SOURCE.contains("let last = total.saturating_sub(1);"));
    assert!(STREAM_SOURCE.contains("let end = end_opt.unwrap_or(last).min(last);"));
    assert!(STREAM_SOURCE.contains("let want = (end.saturating_sub(start) + 1) as usize;"));
    let last = total.saturating_sub(1);
    let end = end_opt.unwrap_or(last).min(last);
    (end.saturating_sub(start) + 1) as usize
}

#[tokio::test]
#[ignore = "browse-01 cross repro"]
async fn browse_01_nonzero_open_ended_range_should_be_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("offset-video.mp4");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(24 * 1024 * 1024)
        .unwrap();
    let total = std::fs::metadata(&path).unwrap().len();
    let start = 4 * 1024 * 1024;
    let want = verified_range_want(total, start, None);
    let bytes = LocalFs::new().read_range(&path, start, want).await.unwrap();
    assert!(
        bytes.len() <= CAP,
        "open range at 4MiB read {} bytes at once",
        bytes.len()
    );
}

#[test]
fn browse_01_explicit_bounded_range_arithmetic_matches_requested_window() {
    assert_eq!(
        verified_range_want(24 * 1024 * 1024, 1024, Some(2047)),
        1024
    );
    assert_eq!(
        verified_range_want(24 * 1024 * 1024, 1024, Some(u64::MAX)),
        24 * 1024 * 1024 - 1024
    );
}

#[tokio::test]
#[ignore = "browse-33 repro (F-sol-201)"]
async fn sol2_201_large_pdf_without_range_should_not_be_presented_as_a_complete_shorter_file() {
    assert!(STREAM_SOURCE.contains("let want = (total as usize).min(MAX_FULL);"));
    assert!(STREAM_SOURCE.contains(".header(header::CONTENT_LENGTH, bytes.len().to_string())"));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large-document.pdf");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(20 * 1024 * 1024)
        .unwrap();
    let total = std::fs::metadata(&path).unwrap().len();
    let bytes = LocalFs::new()
        .read_range(&path, 0, (total as usize).min(CAP))
        .await
        .unwrap();
    assert_eq!(
        bytes.len() as u64,
        total,
        "200 response and Content-Length disguise a truncated PDF"
    );
}

#[test]
fn browse_06_shift_jis_latin1_and_utf16_primitive_evidence() {
    assert!(DECODE_SOURCE.contains("if bytes.contains(&0)"));
    assert!(DECODE_SOURCE.contains("Err(e) => e.valid_up_to(),"));
    let shift_jis = [0x93u8, 0xfa, 0x96, 0x7b];
    let latin1 = [b'c', b'a', b'f', 0xe9];
    let sjis_prefix = [b'h', b'i', b':', 0x93, 0xfa];
    let bad_prefix = |bytes: &[u8]| std::str::from_utf8(bytes).unwrap_err().valid_up_to();
    assert_eq!(bad_prefix(&shift_jis), 0);
    assert_eq!(bad_prefix(&latin1), 3);
    assert_eq!(bad_prefix(&sjis_prefix), 3);
    assert!([0xff, 0xfe, b'a', 0].contains(&0));
}

#[tokio::test]
async fn browse_06_utf16_larger_than_head_cap_still_has_bom_and_nuls() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("utf16.txt");
    let mut bytes = vec![0xff, 0xfe];
    for _ in 0..140_000 {
        bytes.extend_from_slice(&[b'x', 0]);
    }
    std::fs::write(&path, &bytes).unwrap();
    let (head, truncated) = LocalFs::new().read_head(&path, 256 * 1024).await.unwrap();
    assert!(truncated);
    assert_eq!(head.len(), 256 * 1024);
    assert_eq!(&head[..2], &[0xff, 0xfe]);
    assert!(head.contains(&0));
}
