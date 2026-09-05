/**
 * KeyboardEvent → 정규화 문자열 ("Ctrl+Shift+F" 등).
 *
 * - macOS metaKey 는 "Ctrl" 로 정규화 (cross-platform 통일).
 * - 알파벳은 대문자.
 * - 화살표 키: ArrowLeft → Left, ...
 * - Modifier-only keypress (key === "Control" 등) 는 null 반환.
 * - NumPad 는 `e.code` 이름 그대로 ("NumpadMultiply") — TC 의 `*`(선택 반전),
 *   `+`/`-`(패턴 선택)를 메인 키보드의 같은 문자와 구분해서 맬 수 있게.
 * - 숫자열은 `e.code`(Digit1..0) 기준 — macOS 에서 ⌥1 은 `e.key` 가 "¡" 라
 *   "Alt+1" 바인딩이 영영 안 맞았다. 물리 키 위치로 맞추는 게 단축키 관례이기도 하다.
 */

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

export function formatKeyEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let key = e.key;
  const digit = /^Digit([0-9])$/.exec(e.code);
  if (e.code.startsWith("Numpad") && e.code !== "NumpadEnter") {
    key = e.code;
  } else if (digit) {
    key = digit[1]!;
  } else if (key.startsWith("Arrow")) {
    key = key.slice("Arrow".length);
  } else if (key === " ") {
    // 공백 문자 그대로면 바인딩 문자열("Shift+ ")이 안 읽힘 — 이름으로 정규화.
    key = "Space";
  } else if (key.length === 1) {
    key = key.toUpperCase();
  }

  parts.push(key);
  return parts.join("+");
}
