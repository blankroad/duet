// G-16 — fileActions 의 즉시 실패 토스트가 대상 이름과 원문을 잃지 않는다.
// (예전: `show(t(key, { err: formatErr(e) }), "error")` → 원인 문장만, 알림 "자세히" 원문 없음.)
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryRef, Location } from "@/types/bindings";

const h = vi.hoisted(() => ({ plan: null as unknown }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
vi.mock("@/types/bindings", () => ({
  commands: {
    fsMovePlan: () => Promise.resolve(h.plan),
    fsCopyPlan: () => Promise.resolve(h.plan),
  },
}));

import i18n from "@/i18n";
import { planTransferTo } from "@/lib/fileActions";

const src: Location = { source: { kind: "local" }, path: "C:\\work" };
const dst: Location = { source: { kind: "local" }, path: "D:\\backup" };
const one: EntryRef[] = [{ location: src, name: "report.docx" }];
const raw = "Access is denied. (os error 5)";

beforeEach(() => {
  h.plan = {
    status: "error",
    error: { kind: "PermissionDenied", message: raw },
  };
});

describe("fileActions error toasts (G-16)", () => {
  it.each(["move", "copy"] as const)(
    "%s plan failure names the item and keeps the raw text as detail",
    async (mode) => {
      const toast = vi.fn();
      await planTransferTo(one, dst, mode, vi.fn(), toast);
      expect(toast).toHaveBeenCalledTimes(1);
      const [message, kind, opts] = toast.mock.calls[0]!;
      expect(kind).toBe("error");
      expect(message).toBe(
        i18n.t(
          mode === "move" ? "toast.movePlanFailed" : "toast.copyPlanFailed",
          {
            err: i18n.t("errors.withName", {
              name: "report.docx",
              text: i18n.t("errors.reason.accessDenied"),
            }),
          },
        ),
      );
      expect(opts).toEqual({ detail: `report.docx: ${raw}` });
    },
  );

  it("several items: no single name, raw text still kept", async () => {
    const toast = vi.fn();
    await planTransferTo(
      [...one, { location: src, name: "b.txt" }],
      dst,
      "move",
      vi.fn(),
      toast,
    );
    const [message, , opts] = toast.mock.calls[0]!;
    expect(message).not.toContain("report.docx");
    expect(opts).toEqual({ detail: raw });
  });
});
