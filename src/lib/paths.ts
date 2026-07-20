/**
 * 경로 표시용 헬퍼. 구분자는 POSIX(`/`)·Windows(`\`) 둘 다 인식한다 —
 * Windows 역슬래시 경로에서 basename 이 전체 경로로 새지 않게 하기 위함.
 *
 * 주의(CLAUDE.md §7): 여기 함수들은 **화면 표시용**(라벨/탭 제목/기본 이름)
 * 전용이다. 실제 경로 결합/조작/검증은 백엔드(Rust `Path`)가 권위를 가지며,
 * 프론트는 절대 경로를 직접 만들지 않는다.
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
