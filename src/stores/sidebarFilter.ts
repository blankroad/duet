import { create } from "zustand";
import { useUI } from "@/stores/ui";

/**
 * 사이드바 이름 필터 — 위치·호스트·북마크·최근을 이름으로 좁힌다.
 * 태그 필터(`tagFilter`)와는 별개: 이건 이름 문자열, 저건 태그 집합.
 */
interface State {
  q: string;
  /** 포커스 요청 신호 — 값이 오르면 입력창이 포커스+전체선택. command 에서 발사. */
  focusNonce: number;
  /**
   * 아직 처리 안 된 포커스 요청이 있는가. 입력창이 처리하면 내린다 — nonce 만 보면
   * 사이드바를 다시 열(재마운트) 때마다 옛 요청이 되살아나 패널 포커스를 빼앗았다.
   */
  focusPending: boolean;
  set: (q: string) => void;
  clear: () => void;
  /** 필터로 포커스. 사이드바가 닫혀 있으면 먼저 연다(예전엔 아무 반응이 없었다). */
  requestFocus: () => void;
  consumeFocus: () => void;
}

export const useSidebarFilter = create<State>((set) => ({
  q: "",
  focusNonce: 0,
  focusPending: false,
  set: (q) => set({ q }),
  clear: () => set({ q: "" }),
  requestFocus: () => {
    if (!useUI.getState().sidebarOpen) useUI.getState().toggleSidebar();
    set((s) => ({ focusNonce: s.focusNonce + 1, focusPending: true }));
  },
  consumeFocus: () => set({ focusPending: false }),
}));

/**
 * 이름이 질의에 걸리는지 — 대소문자 무시 부분일치. 질의가 비면 항상 true.
 *
 * 퍼지 매칭(띄엄띄엄 글자)은 일부러 안 쓴다: 호스트 이름이 짧고 서로 비슷해서
 * 퍼지로 하면 관계없는 항목이 잔뜩 남는다 (커맨드 팔레트와 다른 선택).
 */
export function matchesQuery(text: string, q: string): boolean {
  const needle = foldKey(q.trim());
  if (needle === "") return true;
  return foldKey(text).includes(needle);
}

/**
 * 비교 키 — NFC 정규화 + 소문자. macOS 폴더 이름에서 온 NFD 한글(자모 분해)을 키보드로
 * 친 NFC 한글과 같은 글자로 본다 (G-14). 표시 문자열은 바꾸지 않는다.
 */
function foldKey(s: string): string {
  return s.normalize("NFC").toLowerCase();
}

/**
 * NFC 로 바꾼 문자열의 위치 → 원문(정규화 전) 위치. 원문 앞부분을 NFC 로 바꿨을 때 길이가
 * `off` 가 되는 **가장 긴** 앞부분의 길이 — 음절 중간(자모 하나)에서 끊기지 않게 한다.
 * 사이드바 이름은 짧아서 단순 반복으로 충분하다. 못 맞추면 null.
 */
function rawOffset(text: string, off: number): number | null {
  let found: number | null = null;
  for (let i = 0; i <= text.length; i++) {
    const n = text.slice(0, i).normalize("NFC").length;
    if (n === off) found = i;
    else if (n > off) break;
  }
  return found;
}

/** 매치 구간 `[시작, 끝)` — 없으면 null. 강조 표시용. */
export function matchRange(
  text: string,
  q: string,
): { start: number; end: number } | null {
  const needle = foldKey(q.trim());
  if (needle === "") return null;
  const hay = foldKey(text);
  const start = hay.indexOf(needle);
  if (start < 0) return null;
  const end = start + needle.length;
  // 원문이 이미 NFC 면 위치가 같다. NFD 원문이면 강조 위치를 원문 기준으로 옮긴다.
  if (text.normalize("NFC") === text) return { start, end };
  const rs = rawOffset(text, start);
  const re = rawOffset(text, end);
  return rs === null || re === null ? null : { start: rs, end: re };
}
