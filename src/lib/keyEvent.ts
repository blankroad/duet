/**
 * KeyboardEvent → 정규화 문자열 ("Ctrl+Shift+F" 등).
 *
 * - macOS metaKey 는 "Ctrl" 로 정규화 (cross-platform 통일).
 * - 알파벳은 대문자.
 * - 화살표 키: ArrowLeft → Left, ...
 * - Modifier-only keypress (key === "Control" 등) 는 null 반환.
 */

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

export function formatKeyEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let key = e.key;
  if (key.startsWith("Arrow")) {
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
