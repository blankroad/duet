import { describe, it, expect, beforeEach } from "vitest";
import { useClipboard } from "./clipboard";
import type { EntryRef } from "@/types/bindings";

const ref = (name: string): EntryRef => ({
  location: { source: { kind: "local" }, path: "/a" },
  name,
});

describe("clipboard store", () => {
  beforeEach(() => useClipboard.getState().clear());

  it("starts empty", () => {
    expect(useClipboard.getState().entry).toBeNull();
  });

  it("set stores targets + mode, replaceable, clearable", () => {
    useClipboard.getState().set([ref("a"), ref("b")], "copy");
    expect(useClipboard.getState().entry?.mode).toBe("copy");
    expect(useClipboard.getState().entry?.targets).toHaveLength(2);

    // 다시 set 하면 교체(잘라내기로).
    useClipboard.getState().set([ref("c")], "move");
    expect(useClipboard.getState().entry?.mode).toBe("move");
    expect(useClipboard.getState().entry?.targets).toHaveLength(1);

    useClipboard.getState().clear();
    expect(useClipboard.getState().entry).toBeNull();
  });
});
