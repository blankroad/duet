/**
 * shell-settings 점검 재현 — localStorage 의 "문법은 맞지만 모양이 틀린" 값.
 *
 * session.ts 는 탭 단위로 검증하지만 recents / palette / sidebar 접힘 로더는
 * `JSON.parse(raw) as T` 로 모양을 믿는다. 구버전·손편집 값(`null`, 객체 대신 배열 등)이
 * 들어 있으면 store 초기값이 배열/객체가 아니게 되고, 첫 사용(`.filter`, `[key]`)에서 throw.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// 이 jsdom 환경의 localStorage 는 기능이 없어 인메모리로 stub (session.test.ts 와 같은 방식).
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, v);
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
  clear: () => mem.clear(),
});

beforeEach(() => {
  mem.clear();
  vi.resetModules();
});

describe("localStorage 모양 검증", () => {
  it.fails("shell-settings-28: recents 가 null 이면 빈 목록으로 시작", async () => {
    localStorage.setItem("duet.recents", "null");
    const { useRecents } = await import("@/stores/recents");
    expect(Array.isArray(useRecents.getState().items)).toBe(true);
  });

  it.fails("shell-settings-28: 팔레트 최근 명령이 객체면 빈 목록으로 시작", async () => {
    localStorage.setItem("duet.palette.recent", '{"a":1}');
    const { usePalette } = await import("@/stores/palette");
    expect(Array.isArray(usePalette.getState().recent)).toBe(true);
  });

  it.fails("shell-settings-28: 사이드바 접힘이 null 이면 토글이 throw 하지 않음", async () => {
    localStorage.setItem("duet.sidebar.collapsed", "null");
    const { useUI } = await import("@/stores/ui");
    expect(() => useUI.getState().collapsed["places"]).not.toThrow();
  });

  it("대조군: 세션 복원은 모양이 틀린 값을 버린다", async () => {
    localStorage.setItem("duet.session.v1", '{"panes":{"left":{"tabs":5}}}');
    const { loadSession } = await import("@/stores/session");
    expect(loadSession()).toBeNull();
  });
});
