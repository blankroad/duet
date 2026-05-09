import type { DuetError } from "@/types/bindings";

/**
 * `DuetError` 또는 IpcError 형태의 unknown 을 사람이 읽을 수 있는 한 줄로.
 */
export function formatErr(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const o = e as Partial<DuetError> & { message?: string };
    if ("message" in o && typeof o.message === "string") return o.message;
    if ("kind" in o && typeof o.kind === "string") return o.kind;
  }
  return String(e);
}
