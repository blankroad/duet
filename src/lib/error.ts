import type { DuetError } from "@/types/bindings";

/**
 * `DuetError` 또는 IpcError 형태의 unknown 을 사람이 읽을 수 있는 한 줄로.
 *
 * 백엔드 Rust 원문("os error 5" 등)을 그대로 노출하지 않고:
 * - kind 를 친화적 라벨로 매핑 (PermissionDenied → "Permission denied")
 * - "(os error N)" / "os error N:" 노이즈 제거
 * - 라벨과 detail 이 중복되면 라벨만
 * 호출부는 앞에 동작 컨텍스트를 붙인다 ("Copy failed: ...").
 */
const KIND_LABEL: Record<string, string> = {
  NotFound: "Not found",
  PermissionDenied: "Permission denied",
  ConnectionFailed: "Connection failed",
  AuthFailed: "Authentication failed",
  NotPermitted: "Operation not permitted",
  Cancelled: "Cancelled",
  NotSupported: "Not supported",
  NeedPassword: "Password required",
  Io: "I/O error",
  CrossDevice: "Items are on different drives",
  Ssh: "SSH error",
  HostKeyUnverified: "Host key not verified",
};

/** Rust io::Error Display 의 "(os error N)" 꼬리표/접두 제거. */
function cleanMessage(m: string): string {
  return m
    .replace(/\s*\(os error \d+\)\s*$/i, "")
    .replace(/^os error \d+:\s*/i, "")
    .trim();
}

export function formatErr(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const o = e as Partial<DuetError> & { message?: unknown };
    const kind = typeof o.kind === "string" ? o.kind : undefined;
    const label = kind ? KIND_LABEL[kind] : undefined;
    const detail =
      typeof o.message === "string" ? cleanMessage(o.message) : "";
    if (label) {
      if (!detail) return label;
      // detail 이 라벨을 사실상 반복하면 한 번만 ("Permission denied" 등).
      if (detail.toLowerCase().startsWith(label.toLowerCase())) return detail;
      return `${label} — ${detail}`;
    }
    if (detail) return detail;
    if (kind) return kind;
  }
  return String(e);
}
