import { describe, expect, it, vi } from "vitest";
import { openShellMenu } from "../shellMenu";
import { useToast } from "@/stores/toast";

vi.mock("@/types/bindings", () => ({
  commands: {
    shellMenuOpen: vi.fn(async () => ({
      status: "ok",
      data: {
        token: 1,
        items: [
          {
            id: 4,
            label: "Test shell command",
            separator: false,
            disabled: false,
            children: [],
            icon: null,
          },
        ],
      },
    })),
    shellMenuInvoke: vi.fn(async () => ({
      status: "error",
      error: { kind: "Io", message: "InvokeCommand failed" },
    })),
  },
}));

describe("shell-settings: 셸 메뉴 실행 실패 피드백", () => {
  it.fails(
    "shell-settings-16: shellMenuInvoke가 실패하면 사용자에게 알린다",
    async () => {
      const show = vi.spyOn(useToast.getState(), "show");
      const menu = await openShellMenu("C:\\sample.txt", "file");
      const entry = menu!.entries[0]!;
      if ("onSelect" in entry) await entry.onSelect?.();
      await Promise.resolve();
      expect(show).toHaveBeenCalled();
      show.mockRestore();
    },
  );
});
