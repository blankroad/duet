import type { Location, SourceId } from "@/types/bindings";

/**
 * 인앱 드래그앤드롭 공용 순수 헬퍼 — 소스/경로 비교 및 자식 Location 계산.
 * 드래그 동작 자체는 hooks/useEntryDrag (포인터 기반), 전송은 fileActions.planTransferTo.
 */

export function sameSource(a: SourceId, b: SourceId): boolean {
  if (a.kind === "local" && b.kind === "local") return true;
  if (a.kind === "ssh" && b.kind === "ssh")
    return a.connection_id === b.connection_id;
  return false;
}

export function sameLocation(a: Location, b: Location): boolean {
  return sameSource(a.source, b.source) && a.path === b.path;
}

/**
 * 부모 Location + 이름 → 자식 Location (디렉토리 드롭/네비 대상). 표시용 경로 결합.
 *
 * 구분자: 경로에 `\` 가 있으면(=Windows 로컬) `\`, 아니면 `/`. 끝에 이미 구분자가
 * 있으면 더 붙이지 않는다 — 드라이브 루트 `C:\` 에서 `C:\/Users` 같은 중복(`C:\/`)
 * 방지. (정확한 결합은 백엔드 `Path::join` 이지만, 표시/드롭 대상은 여기서 일관 처리.)
 */
export function childLocation(parent: Location, name: string): Location {
  const base = parent.path;
  const sep = base.includes("\\") ? "\\" : "/";
  const joiner = /[/\\]$/.test(base) ? "" : sep;
  return { source: parent.source, path: base + joiner + name };
}

/**
 * 경로의 부모 — Windows(`C:\…`)·POSIX(`/…`)·혼합 구분자 모두 처리. 루트면 `null`.
 * 마지막 구분자에서 자르되, 드라이브 루트(`C:`)→`C:\`, POSIX 루트(``)→`/` 로 보정.
 */
export function parentPath(path: string): string | null {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return null; // 단일 컴포넌트(드라이브문자 단독 등) — 부모 없음
  const parent = trimmed.slice(0, idx);
  if (parent === "") return "/"; // POSIX 루트
  if (/^[A-Za-z]:$/.test(parent)) return parent + "\\"; // Windows 드라이브 루트
  return parent;
}

/** 부모 Location (없으면 null — 루트). */
export function parentLocation(loc: Location): Location | null {
  const p = parentPath(loc.path);
  return p === null ? null : { source: loc.source, path: p };
}

/** 드롭 대상 Location 해석 — `".."` 는 부모, 폴더명은 자식, null 은 패널 현재 폴더. */
export function dropDestination(
  base: Location,
  folder: string | null,
): Location {
  if (folder === "..") return parentLocation(base) ?? base;
  return folder ? childLocation(base, folder) : base;
}
