import { pathSegments } from "@/lib/paths";

/** 브레드크럼 한 조각 — 화면 라벨 + 클릭 시 이동할 절대경로. */
export type Crumb = { label: string; path: string };

/**
 * 경로 → breadcrumb 조각. 소스에 맞는 구분자로 **클릭 시 이동할 절대경로**를 만든다.
 * - 원격(SSH)·로컬 POSIX: `/`.
 * - 로컬 Windows: `\`. 드라이브 루트는 `C:\`, UNC 는 `\\server\share` 를 한 조각(루트)으로.
 *   이게 없으면 `/`로 join 돼 `/C:\...` 같은 깨진 경로 → OS error 13(EACCES), UNC 는
 *   선두 `\\` 가 빠져 현재 드라이브 기준 `\server` 로 간다.
 * - 마지막 조각(현재 폴더)은 다시 조립하지 않고 받은 경로를 그대로 쓴다.
 *
 * CLAUDE.md §7: 프론트에서 경로를 조립하는 곳은 여기 한 곳뿐이다(표시용 breadcrumb).
 * 백엔드가 조각을 내려주는 방식으로의 이관은 후속 과제.
 */
export function buildCrumbs(path: string, winLocal: boolean): Crumb[] {
  const raw = String(path);
  const parts = pathSegments(raw);
  const crumbs: Crumb[] = [];
  let start = 0;
  let acc = "";
  if (winLocal && /^[\\/]{2}[^\\/]/.test(raw) && parts.length >= 2) {
    acc = `\\\\${parts[0]}\\${parts[1]}`;
    crumbs.push({ label: acc, path: acc });
    start = 2;
  }
  for (let i = start; i < parts.length; i++) {
    const p = parts[i]!;
    if (winLocal) {
      if (i === 0 && /^[A-Za-z]:$/.test(p)) acc = p + "\\";
      else acc = acc.endsWith("\\") ? acc + p : acc + "\\" + p;
    } else {
      acc = acc + "/" + p;
    }
    crumbs.push({ label: p, path: acc });
  }
  // 루트(드라이브·UNC 공유)만 남은 경우는 조립한 루트 경로(`C:\`)를 유지한다 — `C:` 는
  // "C 드라이브의 현재 폴더"라는 다른 뜻이다.
  const last = crumbs[crumbs.length - 1];
  const onlyRoot =
    crumbs.length === 1 && (start === 2 || /^[A-Za-z]:$/.test(parts[0] ?? ""));
  if (last && !onlyRoot) last.path = raw;
  return crumbs;
}

/**
 * 아카이브 내부 경로 → `root` 아래 상대 조각. 구분자는 buildCrumbs 와 같은 규칙
 * (Windows 로컬 임시경로는 `\`). 루트 밖 경로면 빈 배열.
 */
export function archiveCrumbs(
  path: string,
  root: string,
  winLocal: boolean,
): Crumb[] {
  if (!path.startsWith(root)) return [];
  const sep = winLocal ? "\\" : "/";
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  let acc = base;
  return pathSegments(path.slice(root.length)).map((label) => {
    acc = acc + sep + label;
    return { label, path: acc };
  });
}
