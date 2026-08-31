import { create } from "zustand";

/**
 * 사이드바 이름 필터 — 위치·호스트·북마크·최근을 이름으로 좁힌다.
 * 태그 필터(`tagFilter`)와는 별개: 이건 이름 문자열, 저건 태그 집합.
 */
interface State {
  q: string;
  set: (q: string) => void;
  clear: () => void;
}

export const useSidebarFilter = create<State>((set) => ({
  q: "",
  set: (q) => set({ q }),
  clear: () => set({ q: "" }),
}));

/**
 * 이름이 질의에 걸리는지 — 대소문자 무시 부분일치. 질의가 비면 항상 true.
 *
 * 퍼지 매칭(띄엄띄엄 글자)은 일부러 안 쓴다: 호스트 이름이 짧고 서로 비슷해서
 * 퍼지로 하면 관계없는 항목이 잔뜩 남는다 (커맨드 팔레트와 다른 선택).
 */
export function matchesQuery(text: string, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === "") return true;
  return text.toLowerCase().includes(needle);
}

/** 매치 구간 `[시작, 끝)` — 없으면 null. 강조 표시용. */
export function matchRange(
  text: string,
  q: string,
): { start: number; end: number } | null {
  const needle = q.trim().toLowerCase();
  if (needle === "") return null;
  const start = text.toLowerCase().indexOf(needle);
  if (start < 0) return null;
  return { start, end: start + needle.length };
}
