import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/types/bindings", () => ({
  commands: {
    listDirectory: vi.fn().mockResolvedValue({
      status: "ok",
      data: [
        {
          name: "a.txt",
          kind: "file",
          size: 5,
          modified_ms: null,
          permissions: null,
          hidden: false,
        },
      ],
    }),
  },
}));

import { useTauri } from "./useTauri";

describe("useTauri", () => {
  it("calls command and stores result", async () => {
    const { result } = renderHook(() => useTauri("listDirectory"));
    await act(async () => {
      await result.current.call({ source: { kind: "local" }, path: "/tmp" });
    });
    expect(result.current.data).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("propagates error on status: error", async () => {
    const { commands } = await import("@/types/bindings");
    (commands.listDirectory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "error",
      error: { kind: "NotFound", message: "nope" },
    });
    const { result } = renderHook(() => useTauri("listDirectory"));
    await act(async () => {
      await result.current.call({ source: { kind: "local" }, path: "/nope" }).catch(() => {});
    });
    expect(result.current.error).toEqual({ kind: "NotFound", message: "nope" });
  });
});
