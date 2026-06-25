//! `duet-thumb://` 프로토콜 핸들러 — 그리드/타일 뷰 이미지 썸네일.
//!
//! 원본을 디코드 → 256px 축소 → JPEG 인코드 → `<config>/duet/thumbs/<key>.jpg` 캐시.
//! URL 형식은 duet-preview 와 동일(`/local/<hex>` · `/ssh/<connId hex>/<hex>`).
//! 원격도 SFTP 로 바이트만 가져와 생성(원본 통째 다운로드 회피 — 같은-호스트 원칙).
//!
//! 래스터 이미지(png/jpg/gif/webp/bmp)는 `image` 크레이트로 디코드(로컬·원격 모두).
//! 영상 등 디코드 불가 타입은 **OS 셸 썸네일러**(Windows `IShellItemImageFactory`)로 —
//! 로컬 파일만(원격은 바이트 다운로드가 비싸 아이콘 fallback). macOS QuickLook·PDF·
//! SVG·AVIF·EXIF 회전은 후속.

use crate::services::preview_stream::{fs_for, parse_target};
use crate::services::settings::duet_config_dir;
use crate::types::EntryKind;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Runtime};
use tokio::sync::Semaphore;

/// 썸네일 최대 변(px).
const THUMB_MAX: u32 = 256;
/// 원본 상한 — 초과 시 생성 스킵(프론트는 아이콘 fallback). 거대 이미지 OOM 방지.
const MAX_SRC_BYTES: u64 = 40 * 1024 * 1024;
/// 동시 생성 제한 — 스크롤 폭주 시 CPU/메모리 보호.
const MAX_CONCURRENT: usize = 4;

fn sem() -> &'static Semaphore {
    static SEM: OnceLock<Semaphore> = OnceLock::new();
    SEM.get_or_init(|| Semaphore::new(MAX_CONCURRENT))
}

/// 썸네일 생성 방식.
enum ThumbKind {
    /// image 크레이트로 바이트 디코드(로컬·원격 모두). 래스터 이미지.
    Decode,
    /// OS 셸 썸네일러(경로 기반). 영상 등 — 로컬·지원 플랫폼(Windows)만.
    OsShell,
}

/// 바이트 디코드 대상 확장자 — 활성화된 순수 Rust 코덱만.
fn is_thumbnailable(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp")
    )
}

/// OS 셸 썸네일러 대상 확장자(영상 위주). 코드 `.ts` 오인 방지 위해 ts 는 제외.
fn is_os_thumbnailable(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some(
            "mp4"
                | "mkv"
                | "mov"
                | "avi"
                | "webm"
                | "wmv"
                | "flv"
                | "m4v"
                | "mpg"
                | "mpeg"
                | "3gp"
                | "m2ts"
                | "mts"
                | "ogv"
        )
    )
}

/// 캐시 키 — 소스+경로+mtime+size 해시. mtime/size 가 바뀌면 자동 무효화.
fn cache_key(uri_path: &str, mtime_ms: i64, size: u64) -> String {
    let mut h = DefaultHasher::new();
    uri_path.hash(&mut h);
    mtime_ms.hash(&mut h);
    size.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn cache_path(key: &str) -> Option<PathBuf> {
    Some(
        duet_config_dir()
            .ok()?
            .join("thumbs")
            .join(format!("{key}.jpg")),
    )
}

/// 원본 바이트 → 256px JPEG 썸네일. CPU 작업이라 spawn_blocking 안에서 호출.
fn generate(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    // thumbnail() = 비율 유지 축소(Lanczos 아님, 빠름). JPEG 는 알파 미지원 → rgb8.
    let thumb = image::DynamicImage::ImageRgb8(img.thumbnail(THUMB_MAX, THUMB_MAX).to_rgb8());
    let mut out = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut out, image::ImageFormat::Jpeg).ok()?;
    Some(out.into_inner())
}

fn jpeg_ok(bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/jpeg")
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes)
        .unwrap_or_else(|_| err(StatusCode::INTERNAL_SERVER_ERROR))
}

fn err(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 프로토콜 요청 처리 — 항상 Response(실패도 상태코드, 프론트는 아이콘 fallback).
pub async fn handle<R: Runtime>(app: AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    try_handle(&app, &request)
        .await
        .unwrap_or_else(|| err(StatusCode::NOT_FOUND))
}

async fn try_handle<R: Runtime>(
    app: &AppHandle<R>,
    request: &Request<Vec<u8>>,
) -> Option<Response<Vec<u8>>> {
    let uri_path = request.uri().path();
    let (source, path) = parse_target(uri_path)?;
    let is_local = matches!(source, crate::types::SourceId::Local);
    // 디코드(이미지) 우선, 안 되면 로컬 파일 + 지원 플랫폼이면 OS 셸 썸네일(영상 등).
    let kind = if is_thumbnailable(&path) {
        ThumbKind::Decode
    } else if is_local && crate::platform::supports_shell_thumbnail() && is_os_thumbnailable(&path)
    {
        ThumbKind::OsShell
    } else {
        return Some(err(StatusCode::UNSUPPORTED_MEDIA_TYPE));
    };
    let fs = fs_for(app, &source).await?;
    let meta = fs.metadata(&path).await.ok()?;
    if meta.kind != EntryKind::File {
        return Some(err(StatusCode::NOT_FOUND));
    }
    let size = meta.size.unwrap_or(0);
    if size == 0 {
        return Some(err(StatusCode::PAYLOAD_TOO_LARGE)); // 빈 파일 → fallback
    }
    // 이미지는 통째로 메모리에 디코드하니 상한; OS 셸은 파일을 직접/lazy 하게 읽어 상한 불필요.
    if matches!(kind, ThumbKind::Decode) && size > MAX_SRC_BYTES {
        return Some(err(StatusCode::PAYLOAD_TOO_LARGE)); // 너무 큼 → fallback
    }
    let key = cache_key(uri_path, meta.modified_ms.unwrap_or(0), size);

    // 캐시 hit
    if let Some(cp) = cache_path(&key) {
        if let Ok(bytes) = tokio::fs::read(&cp).await {
            return Some(jpeg_ok(bytes));
        }
    }

    // 동시 생성 제한
    let _permit = sem().acquire().await.ok()?;
    let jpeg = match kind {
        ThumbKind::Decode => {
            let bytes = fs.read_range(&path, 0, size as usize).await.ok()?;
            tokio::task::spawn_blocking(move || generate(&bytes))
                .await
                .ok()??
        }
        ThumbKind::OsShell => {
            // 로컬 경로를 OS 셸 썸네일러로. blocking(COM/디코드).
            let p = path.clone();
            tokio::task::spawn_blocking(move || {
                crate::platform::shell_thumbnail(&p, THUMB_MAX).ok()
            })
            .await
            .ok()??
        }
    };

    // 캐시 write(best-effort)
    if let Some(cp) = cache_path(&key) {
        if let Some(dir) = cp.parent() {
            let _ = tokio::fs::create_dir_all(dir).await;
        }
        let _ = tokio::fs::write(&cp, &jpeg).await;
    }
    Some(jpeg_ok(jpeg))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnailable_exts() {
        assert!(is_thumbnailable(Path::new("a.PNG")));
        assert!(is_thumbnailable(Path::new("b.jpeg")));
        assert!(is_thumbnailable(Path::new("c.webp")));
        assert!(!is_thumbnailable(Path::new("d.pdf")));
        assert!(!is_thumbnailable(Path::new("e.avif")));
        assert!(!is_thumbnailable(Path::new("noext")));
    }

    #[test]
    fn cache_key_changes_with_mtime_and_size() {
        let a = cache_key("/local/2f78", 100, 10);
        let b = cache_key("/local/2f78", 200, 10); // mtime 다름
        let c = cache_key("/local/2f78", 100, 20); // size 다름
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a, cache_key("/local/2f78", 100, 10)); // 동일 입력 = 동일 키
    }

    #[test]
    fn generate_makes_jpeg_from_png() {
        // 2x2 빨강 PNG 인코드 → 썸네일 생성 → JPEG 매직바이트 확인.
        let img = image::RgbImage::from_pixel(2, 2, image::Rgb([255, 0, 0]));
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let jpeg = generate(&png.into_inner()).unwrap();
        assert_eq!(&jpeg[0..2], &[0xff, 0xd8]); // JPEG SOI
    }
}
