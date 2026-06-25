import type { Location, SourceId } from "@/types/bindings";

/**
 * 인앱 드래그앤드롭 공용 순수 헬퍼 — 소스/경로 비교 및 자식 Location 계산.
 * 드래그 동작 자체는 hooks/useEntryDrag (포인터 기반), 전송은 fileActions.planTransferTo.
 */

/**
 * 경로 표시 정규화 — 혼합/중복 구분자를 네이티브 한 가지로 통일.
 * - Windows(`\` 포함): 모든 `/`→`\`, 중복 `\` 1개로(선두 UNC `\\`는 보존). 끝 `\` 제거
 *   (단, 드라이브 루트 `C:\` 는 유지). → `C:\/Users` → `C:\Users`.
 * - POSIX: 중복 `/` 1개로, 끝 `/` 제거(루트 `/` 제외).
 * 저장되는 location.path 를 이걸로 통과시켜 표시(breadcrumb/edit/tab/inspector)를 정리.
 */
export function normalizePath(p: string): string {
  if (p.includes("\\")) {
    const unc = p.startsWith("\\\\");
    let s = p.replace(/\//g, "\\").replace(/\\+/g, "\\");
    if (unc) s = "\\" + s; // 선두 UNC 백슬래시 복원
    if (!/^[A-Za-z]:\\$/.test(s)) s = s.replace(/\\$/, "") || s; // 끝 `\` 제거(드라이브 루트 제외)
    return s;
  }
  const s = p.replace(/\/+/g, "/");
  return s.length > 1 ? s.replace(/\/$/, "") : s;
}

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
 * 비교 전용 정규화 — OS 분리자 종류와 무관하게 같은 디렉토리를 같은 문자열로.
 * 모든 `\`·`/` 를 `/` 로 통일하고 중복 슬래시 합친 뒤 끝 슬래시 제거(루트 제외).
 *
 * 표시용 `normalizePath` 와 달리 네이티브 분리자에 의존하지 않음 — 백엔드가 보내는
 * 이벤트/affected 경로(forward-slash)와 프론트 표시 경로(Windows 는 backslash)를
 * 안전하게 비교하려는 용도. 예: `D:\a` 와 `D:/a` 가 같은 값이 됨.
 */
export function canonPath(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (s.length > 1) s = s.replace(/\/$/, "");
  return s;
}

/** 두 Location 이 같은 디렉토리를 가리키나 (분리자 무관 비교). */
export function sameLocationDir(a: Location, b: Location): boolean {
  return (
    sameSource(a.source, b.source) && canonPath(a.path) === canonPath(b.path)
  );
}

/**
 * fs:changed 이벤트(`eventSource`/`eventPath`)가 `pane` 디렉토리에 영향을 주나.
 * 같은 source + (경로가 같거나 그 직속 자식). notify 가 디렉토리 자체를 보내는
 * 경우와 그 안의 항목 경로를 보내는 경우를 모두 커버. 분리자 무관 비교.
 */
export function eventAffectsDir(
  eventSource: SourceId,
  eventPath: string,
  pane: Location,
): boolean {
  if (!sameSource(eventSource, pane.source)) return false;
  const dir = canonPath(pane.path);
  const ev = canonPath(eventPath);
  if (ev === dir) return true;
  const prefix = dir === "/" ? "/" : dir + "/";
  if (!ev.startsWith(prefix)) return false;
  // NonRecursive watch — 한 단계 자식만 (더 깊은 하위는 어차피 이벤트 안 옴).
  const rest = ev.slice(prefix.length);
  return rest.length > 0 && !rest.includes("/");
}

/** 소스 식별 키 — 로컬은 "local", SSH 는 connection 별. dedup/그룹화용 안정 문자열. */
export function sourceKey(s: SourceId): string {
  return s.kind === "local" ? "local" : `ssh:${s.connection_id}`;
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
