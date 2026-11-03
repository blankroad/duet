import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EntryRef } from "@/types/bindings";
import { commands } from "@/types/bindings";
import "@/i18n";
import { PermissionsDialog } from "./PermissionsDialog";

vi.mock("@/types/bindings", () => ({
  commands: {
    fsSetPermissions: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    fsSetOwner: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

const ref = (name: string): EntryRef => ({
  location: { source: { kind: "local" }, path: "/fixture" },
  name,
});

function open(initialMode: number | null, hasDir = true) {
  render(
    <PermissionsDialog
      targets={[ref("dir"), ref("file.txt")]}
      initialMode={initialMode}
      remote={false}
      hasDir={hasDir}
      onClose={() => {}}
      onApplied={() => {}}
    />,
  );
  return {
    apply: () => screen.getByRole("button", { name: /Apply/ }),
    octal: () => screen.getByRole("textbox", { name: /Octal/i }),
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("PermissionsDialog", () => {
  it("서로 다른 mode 를 골랐으면 직접 정하기 전엔 적용할 수 없다", () => {
    const { apply } = open(null);
    expect((apply() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Mixed/)).toBeDefined();
    fireEvent.click(screen.getAllByRole("checkbox")[2]!); // Owner x
    expect((apply() as HTMLButtonElement).disabled).toBe(false);
  });

  it("첫 포커스는 8진수 입력, Enter = 적용", async () => {
    const { octal } = open(null);
    expect(document.activeElement).toBe(octal());
    fireEvent.change(octal(), { target: { value: "755" } });
    fireEvent.keyDown(octal(), { key: "Enter" });
    await Promise.resolve();
    expect(commands.fsSetPermissions).toHaveBeenCalledWith(
      expect.any(Array),
      0o755,
      false,
    );
  });

  it("잘못된 8진수면 표시하고 적용 비활성 (예전엔 이전 mode 로 조용히 적용)", () => {
    const { apply, octal } = open(0o644);
    fireEvent.change(octal(), { target: { value: "8" } });
    expect(octal().getAttribute("aria-invalid")).toBe("true");
    expect((apply() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(octal(), { key: "Enter" });
    expect(commands.fsSetPermissions).not.toHaveBeenCalled();
  });

  it("폴더가 포함됐는데 소유자 x 가 꺼지면 경고", () => {
    const { octal } = open(0o755);
    expect(screen.queryByText(/can no longer be opened/)).toBeNull();
    fireEvent.change(octal(), { target: { value: "644" } });
    expect(screen.getByText(/can no longer be opened/)).toBeDefined();
  });
});
