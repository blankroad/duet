import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Location } from "@/types/bindings";
import { useClipboard } from "@/stores/clipboard";
import { useCutNames } from "./useCutNames";

const here: Location = { source: { kind: "local" }, path: "/work" };
const elsewhere: Location = { source: { kind: "local" }, path: "/other" };
const refs = (loc: Location, ...names: string[]) =>
  names.map((name) => ({ location: loc, name }));

describe("useCutNames", () => {
  beforeEach(() => useClipboard.getState().clear());

  it("잘라내기한 항목만, 같은 폴더에서만 반환한다", () => {
    useClipboard.getState().set(refs(here, "a.txt", "b.txt"), "move");
    expect([...renderHook(() => useCutNames(here)).result.current]).toEqual([
      "a.txt",
      "b.txt",
    ]);
    // 다른 폴더를 보는 패널은 흐려지지 않는다.
    expect(renderHook(() => useCutNames(elsewhere)).result.current.size).toBe(
      0,
    );
  });

  it("복사(Ctrl+C)와 빈 클립보드는 아무것도 표시하지 않는다", () => {
    const { result, rerender } = renderHook(() => useCutNames(here));
    expect(result.current.size).toBe(0);
    // 마운트된 훅이 구독 중이라 store 변경은 act 로 감싼다.
    act(() => useClipboard.getState().set(refs(here, "a.txt"), "copy"));
    rerender();
    expect(result.current.size).toBe(0);
  });

  it("경로 구분자가 달라도 같은 폴더로 본다", () => {
    useClipboard
      .getState()
      .set(
        refs({ source: { kind: "local" }, path: "C:\\work" }, "a.txt"),
        "move",
      );
    const win: Location = { source: { kind: "local" }, path: "C:/work" };
    expect(renderHook(() => useCutNames(win)).result.current.has("a.txt")).toBe(
      true,
    );
  });
});
