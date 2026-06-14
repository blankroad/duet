import type { Location } from "@/types/bindings";

/** UTF-8 문자열을 hex 로 — duet-preview:// URL 세그먼트 인코딩(percent-encoding 회피). */
function hex(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * `duet-preview://` 스트리밍 URL 생성 — 미디어/PDF 미리보기용.
 * 백엔드 `services::preview_stream` 가 이 URL 을 파싱해 Range 응답.
 * 플랫폼별 custom-protocol origin 형태 처리 (Windows 는 http://<scheme>.localhost).
 */
export function previewStreamUrl(location: Location): string {
  const seg =
    location.source.kind === "local"
      ? `local/${hex(location.path)}`
      : `ssh/${hex(String(location.source.connection_id))}/${hex(location.path)}`;
  const win =
    typeof window !== "undefined" &&
    (window.location.protocol === "http:" || window.location.hostname.endsWith(".localhost"));
  const prefix = win ? "http://duet-preview.localhost" : "duet-preview://localhost";
  return `${prefix}/${seg}`;
}
