/**
 * 정규화 키 문자열("Ctrl+Shift+F")을 플랫폼 표기로 변환.
 *
 * 내부 정규화(keyEvent.ts)는 macOS ⌘ 를 "Ctrl" 로 흡수하므로, mac 표시는
 * Apple 관례(⌥⇧⌘ + 키, 구분자 없음)로 되돌린다. 다른 플랫폼은 그대로.
 * 저장/매칭은 항상 정규화 문자열 — 이 함수는 **표시 전용**.
 */

const IS_MAC =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

export function displayKey(key: string, isMac: boolean = IS_MAC): string {
  if (!isMac) return key;
  const parts = key.split("+");
  const keyPart = parts[parts.length - 1] ?? "";
  const mods = new Set(parts.slice(0, -1));
  // Apple 수식키 순서: Control(^) → Option(⌥) → Shift(⇧) → Command(⌘).
  // 내부 "Ctrl" 은 ⌘ 로 표기 (metaKey 정규화 역변환).
  let out = "";
  if (mods.has("Alt")) out += "⌥";
  if (mods.has("Shift")) out += "⇧";
  if (mods.has("Ctrl")) out += "⌘";
  return out + displayKeyName(keyPart);
}

/** mac 특수키 이름을 심볼로 (Space/화살표 등은 그대로 읽기 쉬움). */
function displayKeyName(k: string): string {
  switch (k) {
    case "Backspace":
      return "⌫";
    case "Delete":
      return "⌦";
    case "Enter":
      return "↩";
    case "Tab":
      return "⇥";
    default:
      return k;
  }
}
