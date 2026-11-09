//! `duet-preview://` 스트리밍 프로토콜 핸들러 — HTTP Range 지원, 로컬 + SSH.
//!
//! `<video>`/`<audio>`/pdf.js 가 `duet-preview://localhost/...` 를 src 로 잡으면
//! 이 핸들러가 파일 바이트 범위를 응답. SSH 도 동일 경로(SFTP `read_range`)라
//! 원격 미디어도 PC 로 통째 받지 않고 seek-스트리밍 (같은-호스트 원칙 유지).
//!
//! URL 형식 (path 세그먼트, hex(UTF-8) 인코딩 — percent-encoding 함정/의존성 회피):
//! - 로컬: `duet-preview://localhost/local/<path_hex>`
//! - SSH : `duet-preview://localhost/ssh/<connId_hex>/<path_hex>`

use crate::fs::{FileSystem, LocalFs, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::types::{ConnectionId, EntryKind, SourceId};
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

/// Range 헤더가 없을 때 한 번에 올릴 최대 크기 (이미지/PDF 보호). 미디어는 브라우저가
/// Range 로 청크 요청하므로 이 경로를 거의 안 탐.
const MAX_FULL: usize = 16 * 1024 * 1024;
/// 열린 범위를 포함해 한 번의 로컬·원격 읽기에 허용하는 최대 바이트 수.
const MAX_RANGE_CHUNK: u64 = 8 * 1024 * 1024;

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

fn hex_to_string(s: &str) -> Option<String> {
    String::from_utf8(hex_decode(s)?).ok()
}

/// URL path 에서 (SourceId, 파일경로) 파싱. duet-thumb 핸들러도 공유.
pub(crate) fn parse_target(uri_path: &str) -> Option<(SourceId, PathBuf)> {
    let segs: Vec<&str> = uri_path.trim_start_matches('/').split('/').collect();
    match segs.as_slice() {
        ["local", phex] => Some((SourceId::Local, PathBuf::from(hex_to_string(phex)?))),
        ["ssh", chex, phex] => Some((
            // host_ip/user 는 fs 디스패치에서 미사용(connection_id 로 pool 조회) → 더미.
            SourceId::Ssh {
                connection_id: ConnectionId(hex_to_string(chex)?),
                host_ip: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
                user: String::new(),
            },
            PathBuf::from(hex_to_string(phex)?),
        )),
        _ => None,
    }
}

pub(crate) async fn fs_for<R: Runtime>(
    app: &AppHandle<R>,
    source: &SourceId,
) -> Option<Box<dyn FileSystem>> {
    match source {
        SourceId::Local => Some(Box::new(LocalFs::new())),
        SourceId::Ssh { connection_id, .. } => {
            let pool = app.state::<Arc<ConnectionPool>>();
            let conn = pool.get(connection_id).await.ok()?;
            Some(Box::new(SshFs::new(conn)))
        }
    }
}

/// 단일 Range를 (start, Option<end-inclusive>)로 파싱한다. 접미 범위는 파일 크기로 환산한다.
fn parse_range(h: &str, total: u64) -> Option<(u64, Option<u64>)> {
    let v = h.strip_prefix("bytes=")?;
    let (a, b) = v.split_once('-')?;
    if a.trim().is_empty() {
        let suffix = b.trim().parse::<u64>().ok()?;
        // -0은 start == total이 되어 아래 응답 경계 검사에서 416으로 처리된다.
        return Some((total.saturating_sub(suffix), None));
    }
    let start = a.trim().parse::<u64>().ok()?;
    let end = if b.trim().is_empty() {
        None
    } else {
        Some(b.trim().parse::<u64>().ok()?)
    };
    Some((start, end))
}

/// Range 응답의 inclusive content-range end. 빈 read(빈 파일/0바이트)면 `None`
/// — `start + len - 1` u64 언더플로를 구조적으로 회피.
fn content_range_end(start: u64, n: usize) -> Option<u64> {
    if n == 0 {
        None
    } else {
        Some(start + n as u64 - 1)
    }
}

/// 확장자 → Content-Type (스트리밍 대상). 모르면 octet-stream.
fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/aac",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn err(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 프로토콜 요청 처리 — 항상 Response 반환(에러도 상태코드로).
pub async fn handle<R: Runtime>(app: AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    try_handle(&app, &request)
        .await
        .unwrap_or_else(|| err(StatusCode::NOT_FOUND))
}

async fn try_handle<R: Runtime>(
    app: &AppHandle<R>,
    request: &Request<Vec<u8>>,
) -> Option<Response<Vec<u8>>> {
    let (source, path) = parse_target(request.uri().path())?;
    let fs = fs_for(app, &source).await?;
    let range_header = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    respond(fs.as_ref(), &path, range_header).await
}

/// 파일의 미리보기 응답을 만든다. 앱 핸들 없이 동일한 로컬·원격 읽기 정책을 적용한다.
pub async fn respond(
    fs: &dyn FileSystem,
    path: &Path,
    range_header: Option<&str>,
) -> Option<Response<Vec<u8>>> {
    let meta = fs.metadata(path).await.ok()?;
    if meta.kind != EntryKind::File {
        return Some(err(StatusCode::NOT_FOUND));
    }
    let total = meta.size.unwrap_or(0);
    let mime = mime_for(path);

    let range = range_header.and_then(|h| parse_range(h, total));
    if range.is_some_and(|(start, end)| start >= total || end.is_some_and(|end| end < start)) {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
            .body(Vec::new())
            .ok();
    }

    // 빈 파일의 Range 없는 요청은 200 빈 본문. 유효한 Range(접미 -0 포함)는 위에서
    // 416으로 처리해 아래 start+len-1 산술을 피한다.
    if total == 0 {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, "0")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .ok();
    }

    if let Some((start, end_opt)) = range {
        let last = total.saturating_sub(1);
        let end = end_opt
            .unwrap_or(last)
            .min(start.saturating_add(MAX_RANGE_CHUNK - 1))
            .min(last);
        let want = (end.saturating_sub(start) + 1) as usize;
        let bytes = fs.read_range(path, start, want).await.ok()?;
        let actual_end = match content_range_end(start, bytes.len()) {
            Some(e) => e,
            None => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                    .body(Vec::new())
                    .ok();
            }
        };
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{actual_end}/{total}"),
            )
            .header(header::CONTENT_LENGTH, bytes.len().to_string())
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "Content-Range, Accept-Ranges, Content-Length",
            )
            .body(bytes)
            .ok();
    }

    // 큰 파일의 일부를 완전한 200 응답으로 위장하지 않는다. PDF 전송은 Range로 재요청한다.
    if total > MAX_FULL as u64 {
        return Response::builder()
            .status(StatusCode::PAYLOAD_TOO_LARGE)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "Content-Range, Accept-Ranges, Content-Length",
            )
            .body(Vec::new())
            .ok();
    }
    // Range 없음 + 상한 이내 → 전체 200.
    let want = total as usize;
    let bytes = fs.read_range(path, 0, want).await.ok()?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip() {
        assert_eq!(hex_to_string("2f612f622e706466"), Some("/a/b.pdf".into()));
        assert_eq!(hex_decode("zz"), None);
        assert_eq!(hex_decode("abc"), None); // 홀수 길이
    }

    #[test]
    fn parse_target_local_and_ssh() {
        let (s, p) = parse_target("/local/2f782e706466").unwrap();
        assert!(matches!(s, SourceId::Local));
        assert_eq!(p, PathBuf::from("/x.pdf"));

        let (s, p) = parse_target("/ssh/6331/2f782e6d7034").unwrap();
        assert!(matches!(s, SourceId::Ssh { .. }));
        assert_eq!(p, PathBuf::from("/x.mp4"));

        assert!(parse_target("/bogus").is_none());
    }

    #[test]
    fn parse_range_variants() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, Some(99))));
        assert_eq!(parse_range("bytes=200-", 1000), Some((200, None)));
        assert_eq!(parse_range("bytes=abc", 1000), None);
        assert_eq!(parse_range("100-200", 1000), None);
        assert_eq!(parse_range("bytes=-500", 1000), Some((500, None)));
        assert_eq!(parse_range("bytes=-1001", 1000), Some((0, None)));
        assert_eq!(parse_range("bytes=-0", 1000), Some((1000, None)));
        assert_eq!(parse_range("bytes=-abc", 1000), None);
        assert_eq!(parse_range("bytes=-2,0-1", 1000), None);
    }

    #[test]
    fn mime_known() {
        assert_eq!(mime_for(Path::new("a.pdf")), "application/pdf");
        assert_eq!(mime_for(Path::new("a.MP4")), "video/mp4");
        assert_eq!(mime_for(Path::new("a.mp3")), "audio/mpeg");
        assert_eq!(mime_for(Path::new("a.unknown")), "application/octet-stream");
    }

    #[test]
    fn content_range_end_handles_empty_read() {
        // 빈 read(빈 파일/0바이트 응답) → None: start+len-1 언더플로 회피.
        assert_eq!(content_range_end(0, 0), None);
        assert_eq!(content_range_end(5, 0), None);
        // 정상 범위는 inclusive end.
        assert_eq!(content_range_end(0, 10), Some(9));
        assert_eq!(content_range_end(100, 1), Some(100));
    }
}

#[cfg(test)]
mod review_browse {
    use super::*;

    use crate::types::{DuetError, Entry, EntryMeta, TrashLocation};
    use std::pin::Pin;

    /// A file truncated after stat: metadata is stale, reads use the empty fixture.
    struct StaleMetadataFs;

    #[async_trait::async_trait]
    impl FileSystem for StaleMetadataFs {
        fn source_id(&self) -> SourceId {
            SourceId::Local
        }
        async fn list(&self, _: &Path) -> Result<Vec<Entry>, DuetError> {
            unreachable!()
        }
        async fn metadata(&self, path: &Path) -> Result<EntryMeta, DuetError> {
            let mut meta = LocalFs.metadata(path).await?;
            meta.size = Some(1024);
            Ok(meta)
        }
        async fn rename(&self, _: &Path, _: &Path) -> Result<(), DuetError> {
            unreachable!()
        }
        async fn mkdir(&self, _: &Path) -> Result<(), DuetError> {
            unreachable!()
        }
        async fn trash(&self, _: &Path, _: &str) -> Result<TrashLocation, DuetError> {
            unreachable!()
        }
        async fn remove(&self, _: &Path) -> Result<(), DuetError> {
            unreachable!()
        }
        async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
            unreachable!()
        }
        async fn read_range(
            &self,
            path: &Path,
            offset: u64,
            len: usize,
        ) -> Result<Vec<u8>, DuetError> {
            LocalFs.read_range(path, offset, len).await
        }
        async fn read_full(&self, _: &Path) -> Result<Vec<u8>, DuetError> {
            unreachable!()
        }
        async fn write_full(&self, _: &Path, _: &[u8]) -> Result<(), DuetError> {
            unreachable!()
        }
        async fn open_read(
            &self,
            path: &Path,
            offset: u64,
        ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
            LocalFs.open_read(path, offset).await
        }
        async fn open_write(
            &self,
            _: &Path,
            _: u64,
        ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn empty_range_read_after_stale_metadata_is_unsatisfiable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("truncated.mp4");
        std::fs::write(&path, b"").unwrap();
        for range in ["bytes=0-99", "bytes=100-", "bytes=-100"] {
            let response = respond(&StaleMetadataFs, &path, Some(range)).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::RANGE_NOT_SATISFIABLE,
                "{range}"
            );
            assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */1024");
            assert!(response.body().is_empty());
        }
    }

    #[tokio::test]
    async fn open_ended_range_is_capped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("movie.mp4");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(64 * 1024 * 1024)
            .unwrap();
        let response = respond(&LocalFs::new(), &path, Some("bytes=0-"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert!(response.body().len() <= 8 * 1024 * 1024);
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            "bytes 0-8388607/67108864"
        );
    }

    #[tokio::test]
    async fn suffix_range_reads_actual_tail_of_large_file() {
        use std::io::{Seek, SeekFrom, Write};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tail.mp4");
        let mut file = std::fs::File::create(&path).unwrap();
        file.set_len(64 * 1024 * 1024).unwrap();
        file.seek(SeekFrom::End(-500)).unwrap();
        let tail = vec![42u8; 500];
        file.write_all(&tail).unwrap();
        let response = respond(&LocalFs::new(), &path, Some("bytes=-500"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), &tail);
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            "bytes 67108364-67108863/67108864"
        );
    }

    #[tokio::test]
    async fn suffix_ranges_cover_small_file_and_clamp_to_its_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("small.mp4");
        std::fs::write(&path, b"abcdef").unwrap();
        for (range, body, content_range) in [
            ("bytes=-2", &b"ef"[..], "bytes 4-5/6"),
            ("bytes=-6", &b"abcdef"[..], "bytes 0-5/6"),
            ("bytes=-500", &b"abcdef"[..], "bytes 0-5/6"),
        ] {
            let response = respond(&LocalFs::new(), &path, Some(range)).await.unwrap();
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.body(), body);
            assert_eq!(response.headers()[header::CONTENT_RANGE], content_range);
        }
    }

    #[tokio::test]
    async fn suffix_range_keeps_the_eight_mib_read_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.mp4");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(32 * 1024 * 1024)
            .unwrap();
        for (range, content_range) in [
            ("bytes=-16777216", "bytes 16777216-25165823/33554432"),
            ("bytes=-18446744073709551615", "bytes 0-8388607/33554432"),
        ] {
            let response = respond(&LocalFs::new(), &path, Some(range)).await.unwrap();
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.body().len(), 8 * 1024 * 1024);
            assert_eq!(response.headers()[header::CONTENT_RANGE], content_range);
        }
    }

    #[tokio::test]
    async fn suffix_zero_is_unsatisfiable_including_empty_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("movie.mp4");
        for body in [&b"abcdef"[..], &b""[..]] {
            std::fs::write(&path, body).unwrap();
            for range in ["bytes=-0", "bytes=-00"] {
                let response = respond(&LocalFs::new(), &path, Some(range)).await.unwrap();
                assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
                assert!(response.body().is_empty());
                assert_eq!(
                    response.headers()[header::CONTENT_RANGE],
                    format!("bytes */{}", body.len())
                );
            }
        }
    }

    #[tokio::test]
    async fn small_full_response_and_invalid_ranges() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("small.pdf");
        std::fs::write(&path, b"abcdef").unwrap();
        for range in [None, Some("bytes=abc"), Some("bytes=0-1,5-6")] {
            let response = respond(&LocalFs::new(), &path, range).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.body(), b"abcdef");
        }
        for range in ["bytes=6-", "bytes=5-2"] {
            let response = respond(&LocalFs::new(), &path, Some(range)).await.unwrap();
            assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        }
        let response = respond(&LocalFs::new(), &path, Some("bytes=3-999"))
            .await
            .unwrap();
        assert_eq!(response.body(), b"def");
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 3-5/6");
    }
}
