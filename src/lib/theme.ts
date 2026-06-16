/**
 * 테마 적용 — `<html data-theme>` 토큰만 토글 (CSS 는 globals.css 가 처리).
 * "light" | "dark" 는 명시, "system" 은 속성 제거 → @media prefers-color-scheme 적용.
 * 색 하드코딩 금지(§) — data-theme 만 건드린다.
 */
export function applyTheme(theme: string): void {
  const el = document.documentElement;
  if (theme === "light" || theme === "dark") {
    el.setAttribute("data-theme", theme);
  } else {
    el.removeAttribute("data-theme");
  }
}
