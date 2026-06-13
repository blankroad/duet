import type { Location, SourceId } from "@/types/bindings";

/**
 * 인앱 드래그앤드롭 공용 순수 헬퍼 — 소스/경로 비교 및 자식 Location 계산.
 * 드래그 동작 자체는 hooks/useEntryDrag (포인터 기반), 전송은 fileActions.planTransferTo.
 */

export function sameSource(a: SourceId, b: SourceId): boolean {
  if (a.kind === "local" && b.kind === "local") return true;
  if (a.kind === "ssh" && b.kind === "ssh") return a.connection_id === b.connection_id;
  return false;
}

export function sameLocation(a: Location, b: Location): boolean {
  return sameSource(a.source, b.source) && a.path === b.path;
}

/** 부모 Location + 이름 → 자식 Location (디렉토리 드롭 대상). 표시용 경로 결합. */
export function childLocation(parent: Location, name: string): Location {
  const base = parent.path;
  const sep = base.endsWith("/") ? "" : "/";
  return { source: parent.source, path: base + sep + name };
}
