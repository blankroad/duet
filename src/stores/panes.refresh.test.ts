import { describe, it, expect, beforeEach } from "vitest";
import { usePanes, activeTab, computeDisplayed } from "./panes";
import type { Entry, Location } from "@/types/bindings";

const DIR: Location = { source: { kind: "local" }, path: "/w" };
const OTHER: Location = { source: { kind: "local" }, path: "/other" };

const file = (name: string): Entry => ({
  name,
  kind: "file",
  size: 1,
  modified_ms: 0,
  permissions: null,
  hidden: false,
});

const NAMES = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
const list = (names: string[] = NAMES) => names.map(file);
const tab = () => activeTab(usePanes.getState(), "left");
/** 커서가 가리키는 표시 항목 이름 (".." 포함 목록 기준). */
const cursorName = () => computeDisplayed(tab())[tab().cursorIndex]?.name;

describe("panes.setEntries — 새로고침에서 자리 유지", () => {
  beforeEach(() => {
    usePanes.getState().closeAllTabs("left");
    usePanes.getState().setEntries("left", DIR, list(), { pushHistory: false });
  });

  /**
   * 회귀 방지 — 예전엔 새로고침마다 커서를 0 으로 되돌렸고, EntryList 가 그 커서로
   * scrollToIndex 해서 목록이 맨 위로 튀었다. 리눅스에서 스크롤해 아래 항목을 누르려는
   * 순간 위로 올라가 버리던 버그.
   */
  it("같은 폴더를 다시 읽어도 커서가 그대로", () => {
    usePanes.getState().setCursor("left", 4);
    const before = cursorName();
    usePanes.getState().setEntries("left", DIR, list(), { pushHistory: false });
    expect(cursorName()).toBe(before);
  });

  it("같은 폴더 새로고침이면 선택도 유지", () => {
    usePanes.getState().setSelected("left", ["b.txt", "d.txt"]);
    usePanes.getState().setEntries("left", DIR, list(), { pushHistory: false });
    expect([...tab().selected].sort()).toEqual(["b.txt", "d.txt"]);
  });

  /** 사라진 항목까지 선택에 남으면 이후 작업이 없는 파일을 대상으로 삼는다. */
  it("사라진 항목은 선택에서 빠진다", () => {
    usePanes.getState().setSelected("left", ["b.txt", "d.txt"]);
    usePanes
      .getState()
      .setEntries("left", DIR, list(["a.txt", "b.txt", "c.txt"]), {
        pushHistory: false,
      });
    expect([...tab().selected]).toEqual(["b.txt"]);
  });

  /** 커서는 인덱스가 아니라 **이름**을 따라간다 — 위에 파일이 생겨도 보던 항목에 남게. */
  it("앞에 항목이 추가돼도 커서는 같은 항목에 남는다", () => {
    usePanes.getState().setCursor("left", 3);
    const before = cursorName();
    usePanes.getState().setEntries("left", DIR, list(["A0.txt", ...NAMES]), {
      pushHistory: false,
    });
    expect(cursorName()).toBe(before);
  });

  it("커서가 가리키던 항목이 사라지면 근처로 clamp", () => {
    usePanes.getState().setCursor("left", 5); // e.txt (".." 포함이라 5)
    usePanes.getState().setEntries("left", DIR, list(["a.txt", "b.txt"]), {
      pushHistory: false,
    });
    const displayed = computeDisplayed(tab());
    expect(tab().cursorIndex).toBeLessThan(displayed.length);
    expect(tab().cursorIndex).toBeGreaterThanOrEqual(0);
  });

  /** 다른 폴더로 이동하면 맨 위에서 시작 — 이건 의도된 동작. */
  it("다른 폴더로 이동하면 커서·선택 초기화", () => {
    usePanes.getState().setCursor("left", 4);
    usePanes.getState().setSelected("left", ["b.txt"]);
    usePanes
      .getState()
      .setEntries("left", OTHER, list(["x.txt"]), { pushHistory: false });
    expect(tab().cursorIndex).toBe(0);
    expect(tab().selected.size).toBe(0);
  });
});
