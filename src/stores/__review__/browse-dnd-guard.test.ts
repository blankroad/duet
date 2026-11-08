import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * browse 점검 R1 (opus) — C-15 "폴더를 자기 자신/하위 폴더로" 가드.
 * 드래그(useEntryDrag onUp)·붙여넣기(clipPaste)·OS 드롭(selfDropKind)이 같은 규칙
 * `sameLocation(childLocation(src, name), dst)` 를 쓴다 — **직접 자식**만 잡는다.
 */

const fsCopyPlan = vi.fn(async () => ({
  status: "ok",
  data: { items: [], conflicts: [], total_bytes: 0 },
}));
vi.mock("@/types/bindings", () => ({
  commands: new Proxy({} as Record<string, unknown>, {
    get: (_t, k: string) =>
      k === "fsCopyPlan"
        ? fsCopyPlan
        : async () => ({ status: "ok", data: null }),
  }),
  events: {},
}));

import "@/i18n";
import { clipPaste } from "@/lib/fileActions";
import { useClipboard } from "@/stores/clipboard";
import { rememberSelfDrag, selfDropKind } from "@/lib/selfDrag";
import type { Location } from "@/types/bindings";

const local = (path: string): Location => ({ source: { kind: "local" }, path });

beforeEach(() => {
  fsCopyPlan.mockClear();
  useClipboard.getState().clear();
});

describe("C-15 자기 자신 안으로 놓기/붙여넣기", () => {
  it("직접 자식(/w/proj)에 붙여넣기는 막는다", async () => {
    useClipboard
      .getState()
      .set([{ location: local("/w"), name: "proj" }], "copy");
    const toast = vi.fn();
    await clipPaste(vi.fn(), toast, local("/w/proj"));
    expect(fsCopyPlan).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it.fails(
    "browse-14 (F-opus-05): 손자 폴더(/w/proj/sub)에 붙여넣기는 막지 않고 복사 계획을 요청한다",
    async () => {
      useClipboard
        .getState()
        .set([{ location: local("/w"), name: "proj" }], "copy");
      const toast = vi.fn();
      await clipPaste(vi.fn(), toast, local("/w/proj/sub"));
      expect(fsCopyPlan).not.toHaveBeenCalled();
    },
  );

  it.fails(
    "browse-14 (F-opus-05): OS 드래그로 되돌아온 드롭도 손자 폴더는 '자기 자신' 으로 보지 않는다",
    () => {
      rememberSelfDrag(["/w/proj"], local("/w"), ["proj"]);
      expect(selfDropKind(["/w/proj"], local("/w/proj/sub"))).toBe("self");
    },
  );

  it("OS 드래그를 원래 폴더/직접 자식에 놓으면 same/self", () => {
    rememberSelfDrag(["/w/proj"], local("/w"), ["proj"]);
    expect(selfDropKind(["/w/proj"], local("/w"))).toBe("same");
    expect(selfDropKind(["/w/proj"], local("/w/proj"))).toBe("self");
  });
});
