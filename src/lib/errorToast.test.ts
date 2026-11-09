import { afterEach, describe, expect, it, vi } from "vitest";
import { errorToastText, showError } from "./errorToast";
import { useToast } from "@/stores/toast";
import { useNotices } from "@/stores/notices";

// 테스트 환경 언어는 en. toast.deleteFailed = "Delete failed: {{err}}".
afterEach(() => {
  useToast.getState().clear();
  useNotices.getState().clear();
});

const denied = {
  kind: "PermissionDenied",
  message: "Permission denied (os error 13)",
};

describe("showError — G-16 오류 토스트가 대상과 원문을 잃지 않는다", () => {
  it("puts the plain sentence in the toast and the original in the notice detail", () => {
    showError("toast.deleteFailed", denied);
    const [toast] = useToast.getState().toasts;
    expect(toast?.kind).toBe("error");
    expect(toast?.message).toMatch(/^Delete failed: Permission denied/);
    const [notice] = useNotices.getState().items;
    expect(notice?.detail).toBe("Permission denied (os error 13)");
  });

  it("names the file (basename) and keeps the full path in the detail", () => {
    const { message, detail } = errorToastText("toast.deleteFailed", denied, {
      path: "/srv/data/분기보고서 2026.xlsx",
    });
    expect(message).toContain("“분기보고서 2026.xlsx”");
    expect(message).not.toContain("/srv/data");
    expect(detail).toBe(
      "/srv/data/분기보고서 2026.xlsx: Permission denied (os error 13)",
    );
  });

  it("uses the Windows basename for backslash paths", () => {
    const { message } = errorToastText("toast.deleteFailed", denied, {
      path: "C:\\Users\\me\\보고서.txt",
    });
    expect(message).toContain("“보고서.txt”");
  });

  it("does not repeat the name or the path when the original already has them", () => {
    const e = { kind: "NotFound", message: "/home/u/a.txt" };
    const { message, detail } = errorToastText("toast.deleteFailed", e, {
      path: "/home/u/a.txt",
    });
    expect(message.match(/a\.txt/g) ?? []).toHaveLength(1);
    expect(detail).toBe("/home/u/a.txt");
  });

  it("passes other interpolation values through and uses an injected toast fn", () => {
    const fn = vi.fn();
    showError("toast.elevatedFailed", denied, {
      vars: { op: "copy" },
      toast: fn,
    });
    expect(fn).toHaveBeenCalledOnce();
    const [msg, kind, opts] = fn.mock.calls[0]!;
    expect(msg).toContain("copy");
    expect(msg).toMatch(/Permission denied/);
    expect(kind).toBe("error");
    expect(opts).toEqual({ detail: "Permission denied (os error 13)" });
    expect(useToast.getState().toasts).toHaveLength(0);
  });

  it("omits the detail option when there is no original text", () => {
    const fn = vi.fn();
    showError("toast.deleteFailed", { kind: "Cancelled" }, { toast: fn });
    expect(fn.mock.calls[0]![2]).toBeUndefined();
  });
});
