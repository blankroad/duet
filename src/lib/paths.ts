/**
 * 경로 표시용 헬퍼. 구분자는 POSIX(`/`)·Windows(`\`) 둘 다 인식한다 —
 * Windows 역슬래시 경로에서 basename 이 전체 경로로 새지 않게 하기 위함.
 *
 * 주의(CLAUDE.md §7): 여기 함수들은 **화면 표시용**(라벨/탭 제목/기본 이름)
 * 전용이다. 실제 경로 결합/조작/검증은 백엔드(Rust `Path`)가 권위를 가지며,
 * 프론트는 절대 경로를 직접 만들지 않는다.
 *
 * 예외: `splitRoot` — "위로"(`parentPath`)·`..` 행(`isRootPath`)·브레드크럼
 * (`buildCrumbs`)이 따로 갖던 루트 규칙을 한 곳으로 모은 것이다. 백엔드 이관은
 * 후속(목록 IPC 가 루트·부모를 내려주는 방식).
 */

/** 경로를 세그먼트 배열로 분해 (빈 조각 제거). 구분자 `/`·`\` 모두 인식. */
export function pathSegments(path: string): string[] {
  return String(path).split(/[/\\]/).filter(Boolean);
}

/**
 * 경로의 마지막 세그먼트(파일/폴더 표시 이름).
 * 세그먼트가 없으면(루트 등) `fallback` 을 반환한다 (기본값 `"/"`).
 */
export function basename(path: string, fallback = "/"): string {
  return pathSegments(path).pop() ?? fallback;
}

/**
 * 표시용 경로 축약 — 가운데를 `…` 로 접어 **말단을 항상 남긴다**.
 *
 * CSS `truncate` 는 뒤를 자르므로 경로에 쓰면 정작 중요한 파일/폴더명이 사라진다
 * (`/Users/ctmctm/Desktop/01_PROJ…`). 대신 첫 세그먼트만 남기고 뒤에서부터
 * 최대한 채운다 — macOS 가 좁은 칸에 경로를 보여주는 방식.
 *
 * 반환값은 표시 전용. 실제 경로 결합/검증은 백엔드가 담당한다 (CLAUDE.md §7).
 */
export function shortenPath(path: string, max = 44): string {
  const s = String(path);
  if (s.length <= max) return s;
  const segs = pathSegments(s);
  const lead = /^[/\\]/.test(s) ? "/" : "";
  // 접을 세그먼트가 없으면(단일 세그먼트 등) 문자 단위 가운데 생략으로 폴백.
  if (segs.length > 2) {
    const head = `${lead}${segs[0]}`;
    let tail = segs[segs.length - 1]!;
    for (let i = segs.length - 2; i >= 1; i--) {
      const next = `${segs[i]}/${tail}`;
      if (`${head}/…/${next}`.length > max) break;
      tail = next;
    }
    const folded = `${head}/…/${tail}`;
    if (folded.length <= max) return folded;
  }
  // 말단 세그먼트 자체가 max 보다 긴 경우 — 앞뒤를 균등하게 남긴다.
  const keep = Math.max(3, Math.floor((max - 1) / 2));
  return `${s.slice(0, keep)}…${s.slice(s.length - keep)}`;
}

/**
 * 루트 해석 방식. `"auto"` 는 소스를 모를 때(원격 POSIX 일 수도 있음) — `//x` 를
 * UNC 로 보지 않는다. `"windows"` 는 로컬 Windows 확정, `"posix"` 는 `/` 만 루트.
 */
export type RootStyle = "auto" | "windows" | "posix";

/** 경로 앞부분에서 찾은 루트와 그 뒤 나머지. */
export interface SplitRoot {
  /**
   * 루트 — 위로 갈 수 없는 곳. 그대로 이동 경로로 쓸 수 있게 정규 형태로 준다:
   * `/`, `\`, `C:\`, `\\srv\share`, `\\?\C:\`, `\\?\UNC\srv\share`.
   */
  root: string;
  /**
   * 루트 뒤 나머지 — 앞 구분자는 빼고 끝 구분자는 원문 그대로. 원문의 끝 조각이라
   * `path.length - rest.length` 가 원문에서 나머지가 시작하는 위치다.
   */
  rest: string;
}

// `\\?\UNC\srv\share` — 긴 경로용 UNC. 서버와 공유가 한 덩어리 루트다.
const VERBATIM_UNC = /^\\\\\?\\UNC\\([^\\]+)\\([^\\]+)/i;
// `\\?\C:\` — 긴 경로용 드라이브. 접두를 쪼개면 `\\?` 같은 없는 부모가 생긴다.
const VERBATIM_DRIVE = /^\\\\\?\\([A-Za-z]):(?:\\|$)/;
// 그 밖의 장치/긴 경로 (`\\?\Volume{…}\`, `\\.\X\`) — 첫 조각까지 루트.
const DEVICE = /^\\\\[?.]\\([^\\]+)(?:\\|$)/;
const UNC_BACKSLASH = /^\\\\([^\\/]+)(?:[\\/]+([^\\/]+))?/;
const UNC_ANY = /^[\\/]{2}([^\\/]+)(?:[\\/]+([^\\/]+))?/;
const DRIVE = /^([A-Za-z]):(?:[\\/]|$)/;

/**
 * 경로의 루트와 나머지 — 위로/브레드크럼/루트 판정이 공유하는 **하나의** 규칙.
 * 루트가 없는 상대 경로면 `null`.
 *
 * 인식: POSIX `/`, 드라이브 `C:\`·`C:/`·`C:`, UNC `\\srv\share`(끝 구분자 유무 무관,
 * 공유 없이 `\\srv` 만이면 그게 루트), 긴 경로 `\\?\C:\`·`\\?\UNC\srv\share`.
 * `//srv/share` 는 `"windows"` 에서만 UNC 다 — 원격 리눅스 경로가 `\\` 로 시작하는
 * 일은 사실상 없지만 `//` 는 있을 수 있어서다.
 */
export function splitRoot(
  path: string,
  style: RootStyle = "auto",
): SplitRoot | null {
  const p = String(path);
  const tail = (consumed: number) => p.slice(consumed).replace(/^[\\/]+/, "");
  if (style !== "posix") {
    let m = VERBATIM_UNC.exec(p);
    if (m)
      return { root: `\\\\?\\UNC\\${m[1]}\\${m[2]}`, rest: tail(m[0].length) };
    m = VERBATIM_DRIVE.exec(p);
    if (m) return { root: `\\\\?\\${m[1]}:\\`, rest: tail(m[0].length) };
    m = DEVICE.exec(p);
    if (m)
      return { root: `${p.slice(0, 4)}${m[1]}\\`, rest: tail(m[0].length) };
    m = (style === "windows" ? UNC_ANY : UNC_BACKSLASH).exec(p);
    if (m) {
      const root = `\\\\${m[1]}` + (m[2] === undefined ? "" : `\\${m[2]}`);
      return { root, rest: tail(m[0].length) };
    }
    m = DRIVE.exec(p);
    if (m) return { root: `${m[1]}:\\`, rest: tail(m[0].length) };
  }
  const lead = p[0];
  if (lead === "/" || (lead === "\\" && style !== "posix"))
    return { root: lead, rest: tail(1) };
  return null;
}
