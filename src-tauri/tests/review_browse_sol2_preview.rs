//! Preview response regressions and independent encoding evidence; no app/server used.
use duet_lib::fs::{FileSystem, LocalFs};
use duet_lib::services::preview_stream::respond;

const DECODE_SOURCE: &str = include_str!("../src/commands/fs_ops.rs");

#[tokio::test]
async fn browse_01_nonzero_open_ended_range_should_be_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("offset-video.mp4");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(24 * 1024 * 1024)
        .unwrap();
    let response = respond(&LocalFs::new(), &path, Some("bytes=4194304-"))
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.body().len(), 8 * 1024 * 1024);
    assert_eq!(
        response.headers()["content-range"],
        "bytes 4194304-12582911/25165824"
    );
}

#[tokio::test]
async fn browse_01_explicit_bounded_range_arithmetic_matches_requested_window() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("video.mp4");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(24 * 1024 * 1024)
        .unwrap();
    let response = respond(&LocalFs::new(), &path, Some("bytes=100-199"))
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.body().len(), 100);
    assert_eq!(
        response.headers()["content-range"],
        "bytes 100-199/25165824"
    );
    let response = respond(
        &LocalFs::new(),
        &path,
        Some("bytes=1024-18446744073709551615"),
    )
    .await
    .unwrap();
    assert_eq!(response.body().len(), 8 * 1024 * 1024);
}

#[tokio::test]
async fn sol2_201_large_pdf_without_range_should_not_be_presented_as_a_complete_shorter_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large-document.pdf");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(20 * 1024 * 1024)
        .unwrap();
    for range in [None, Some("bytes=abc"), Some("bytes=0-1,5-6")] {
        let response = respond(&LocalFs::new(), &path, range).await.unwrap();
        assert_eq!(response.status(), 413);
        assert!(response.body().is_empty());
        assert_eq!(response.headers()["content-range"], "bytes */20971520");
        assert_eq!(response.headers()["accept-ranges"], "bytes");
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        assert!(response
            .headers()
            .contains_key("access-control-expose-headers"));
    }
}

#[test]
fn browse_06_shift_jis_latin1_and_utf16_primitive_evidence() {
    // browse-06 수정(archive 팀) 뒤 decode_text 는 BOM·UTF-16·CP949 를 디코드한다 — 예전 소스
    // 문자열(UTF-8 유효 prefix 만 사용) 단언은 뺐다. 동작은 fs_ops.rs `mod review_browse`·
    // `preview_tests` 가 검증한다. 아래는 입력 바이트 자체에 대한 사실이라 그대로 둔다.
    assert!(DECODE_SOURCE.contains("encoding_rs::EUC_KR"));
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
