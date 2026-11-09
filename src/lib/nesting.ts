import type { Location } from "@/types/bindings";
import { canonPath, sameSource } from "@/lib/entryDnd";

/**
 * "폴더를 자기 자신이나 그 하위로" 복사·이동하려는지 미리 알아보는 **안내용** 검사.
 *
 * 붙여넣기·인앱 드래그·OS 드래그가 같은 규칙을 쓴다. 진짜 방어는 백엔드
 * (`core/path_guard`, `IntoItself` 오류)이고, 여기서는 확인 창을 띄우기 전에 바로 알려
 * 주려는 것뿐이다. 그래서 애매하면 막지 않는다(백엔드가 최종 판정).
 */

/** Windows 로컬 경로 표기(`C:\…`, `C:/…`, `\\server\…`)인가. */
function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[/\\]?/.test(p) || p.startsWith("\\\\");
}

/**
 * 비교용 경로 키.
 * - 로컬: 구분자 `\`·`/` 를 하나로(`canonPath`). Windows 표기는 대소문자 무시.
 * - 원격(SSH): 항상 POSIX 라 `\` 는 이름의 일부다 — `/` 만 정리한다.
 */
function compareKey(loc: Location): string {
  if (loc.source.kind === "ssh") {
    const s = loc.path.replace(/\/+/g, "/");
    return s.length > 1 ? s.replace(/\/$/, "") : s;
  }
  const s = canonPath(loc.path);
  return isWindowsPath(loc.path) ? s.toLowerCase() : s;
}

/**
 * `dst` 가 `folder` 자신이거나 그 하위 폴더인가 (같은 소스일 때만).
 * 구분자 경계로 비교한다 — `/w/proj` 는 `/w/project` 의 조상이 아니다.
 */
export function isSameOrInside(dst: Location, folder: Location): boolean {
  if (!sameSource(dst.source, folder.source)) return false;
  const d = compareKey(dst);
  const f = compareKey(folder);
  if (d === f) return true;
  const prefix = f.endsWith("/") ? f : `${f}/`;
  return d.startsWith(prefix);
}
