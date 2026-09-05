/**
 * KeyboardEvent → 정규화 문자열 ("Ctrl+Shift+F" 등).
 *
 * - macOS metaKey 는 "Ctrl" 로 정규화 (cross-platform 통일).
 * - 알파벳은 대문자.
 * - 화살표 키: ArrowLeft → Left, ...
 * - Modifier-only keypress (key === "Control" 등) 는 null 반환.
 * - NumPad 는 `e.code` 이름 그대로 ("NumpadMultiply") — TC 의 `*`(선택 반전),
 *   `+`/`-`(패턴 선택)를 메인 키보드의 같은 문자와 구분해서 맬 수 있게.
 */

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

export function formatKeyEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let key = e.key;
  if (e.code.startsWith("Numpad") && e.code !== "NumpadEnter") {
    key = e.code;
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
