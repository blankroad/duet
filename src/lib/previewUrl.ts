import type { Location } from "@/types/bindings";

/** UTF-8 문자열을 hex 로 — duet-preview:// URL 세그먼트 인코딩(percent-encoding 회피). */
function hex(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** 소스+경로 → URL path 세그먼트(로컬/ssh). preview·thumb 공용. */
function targetSeg(location: Location): string {
  return location.source.kind === "local"
    ? `local/${hex(location.path)}`
    : `ssh/${hex(String(location.source.connection_id))}/${hex(location.path)}`;
}

/** custom-protocol origin — Windows 는 http://<scheme>.localhost, 그 외 <scheme>://localhost. */
function protoPrefix(scheme: string): string {
  const win =
    typeof window !== "undefined" &&
    (window.location.protocol === "http:" || window.location.hostname.endsWith(".localhost"));
  return win ? `http://${scheme}.localhost` : `${scheme}://localhost`;
}

/**
 * `duet-preview://` 스트리밍 URL 생성 — 미디어/PDF 미리보기용.
 * 백엔드 `services::preview_stream` 가 이 URL 을 파싱해 Range 응답.
 */
export function previewStreamUrl(location: Location): string {
  return `${protoPrefix("duet-preview")}/${targetSeg(location)}`;
}

/** `duet-thumb://` 썸네일 URL — 그리드/타일 뷰 이미지용. 백엔드가 디코드→축소→JPEG 캐시. */
export function thumbUrl(location: Location): string {
  return `${protoPrefix("duet-thumb")}/${targetSeg(location)}`;
}
