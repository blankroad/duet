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

/// `Range: bytes=start-end` 파싱 (단일 범위) → (start, Option<end-inclusive>).
fn parse_range(h: &str) -> Option<(u64, Option<u64>)> {
    let v = h.strip_prefix("bytes=")?;
    let (a, b) = v.split_once('-')?;
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
    let meta = fs.metadata(&path).await.ok()?;
    if meta.kind != EntryKind::File {
        return Some(err(StatusCode::NOT_FOUND));
    }
    let total = meta.size.unwrap_or(0);
    let mime = mime_for(&path);

    // 빈 파일: Range 의미 없음 → 200 빈 본문 (RFC 7233 허용). 아래 Range 산술의
    // start+len-1 언더플로 원천 차단.
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

    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_range);

    if let Some((start, end_opt)) = range {
        if total > 0 && start >= total {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                .body(Vec::new())
                .ok();
        }
        let last = total.saturating_sub(1);
        let end = end_opt.unwrap_or(last).min(last);
        let want = (end.saturating_sub(start) + 1) as usize;
        let bytes = fs.read_range(&path, start, want).await.ok()?;
        let actual_end = match content_range_end(start, bytes.len()) {
            Some(e) => e,
            None => start, // 빈 read — 본문 빔(언더플로 회피)
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

    // Range 없음 → 전체(상한 내) 200.
    let want = (total as usize).min(MAX_FULL);
    let bytes = fs.read_range(&path, 0, want).await.ok()?;
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
        assert_eq!(parse_range("bytes=0-99"), Some((0, Some(99))));
        assert_eq!(parse_range("bytes=200-"), Some((200, None)));
        assert_eq!(parse_range("bytes=abc"), None);
        assert_eq!(parse_range("100-200"), None);
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
