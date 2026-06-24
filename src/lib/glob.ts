/**
 * 패턴 매처 — glob 또는 부분문자열.
 *
 * glob 메타문자(`*`, `?`, `[...]`)가 있으면 glob 으로 해석(앵커드 전체 매칭),
 * 없으면 부분문자열(substring) 매칭. 항상 대소문자 무시.
 *
 * 패턴 선택(glob-select)에서 "현재 패널 항목 중 패턴에 맞는 것" 판정에 사용.
 */

/** glob 메타문자 포함 여부 — 없으면 substring 모드. */
function hasGlobMeta(pattern: string): boolean {
  return /[*?[\]]/.test(pattern);
}

/** 정규식 특수문자 escape (glob 메타 `* ? [ ]` 제외 — 그건 따로 변환). */
function escapeRegexLiteral(ch: string): string {
  return ch.replace(/[.+^${}()|\\]/g, "\\$&");
}

/**
 * glob 패턴 → 앵커드 RegExp 소스.
 * - `*` → `.*`  (구분자 무시 — 파일명 단위 매칭이라 경로 분리 불필요)
 * - `?` → `.`
 * - `[...]` 문자 클래스는 그대로 통과(빈/미완 클래스는 리터럴 처리)
 * - 그 외 정규식 메타는 escape
 */
function globToRegexSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else if (ch === "[") {
      // 닫는 ] 찾기 — 없으면 리터럴 [ 로 폴백.
      const close = pattern.indexOf("]", i + 1);
      if (close > i + 1) {
        out += pattern.slice(i, close + 1);
        i = close;
      } else {
        out += "\\[";
      }
    } else {
      out += escapeRegexLiteral(ch);
    }
  }
  return out;
}

/**
 * 패턴 → 이름 매칭 함수. 빈 패턴은 항상 false(아무것도 선택 안 함).
 * glob 모드는 RegExp 컴파일 실패 시 substring 으로 안전 폴백.
 */
export function patternToMatcher(pattern: string): (name: string) => boolean {
  const p = pattern.trim();
  if (p.length === 0) return () => false;

  if (hasGlobMeta(p)) {
    try {
      const re = new RegExp(`^${globToRegexSource(p)}$`, "i");
      return (name) => re.test(name);
    } catch {
      // 깨진 패턴(예: 미완 문자클래스) → substring 폴백.
    }
  }
  const lower = p.toLowerCase();
  return (name) => name.toLowerCase().includes(lower);
}
