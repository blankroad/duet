import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { BatchRenamePlan, EntryRef } from "@/types/bindings";
import { commands } from "@/types/bindings";
import "@/i18n";
import { BatchRenameDialog } from "./BatchRenameDialog";

vi.mock("@/types/bindings", () => ({
  commands: { fsBatchRenamePreview: vi.fn() },
}));

const targets: EntryRef[] = ["a.txt", "b.txt"].map((name) => ({
  location: { source: { kind: "local" }, path: "/fixture" },
  name,
}));
const ok = (newNames: string[], collision = false) =>
  ({
    status: "ok",
    data: {
      items: newNames.map((n, i) => ({
        old_name: targets[i]!.name,
        new_name: n,
        collides: collision,
      })),
      has_collision: collision,
    } as unknown as BatchRenamePlan,
  }) as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

describe("BatchRenameDialog", () => {
  it("새 규칙의 미리보기가 오기 전엔 Ctrl+Enter 로 제출되지 않는다", async () => {
    vi.mocked(commands.fsBatchRenamePreview)
      .mockResolvedValueOnce(ok(["a.txt", "b.txt"]))
      .mockResolvedValueOnce(ok(["x-a.txt", "x-b.txt"]))
      .mockReturnValue(new Promise(() => {}));
    const onSubmit = vi.fn();
    render(
      <BatchRenameDialog
        targets={targets}
        onClose={() => {}}
        onSubmit={onSubmit}
      />,
    );
    await settle();
    const [, , , prefix] = screen.getAllByRole("textbox");
    fireEvent.change(prefix!, { target: { value: "x-" } });
    await settle();
    // 미리보기가 현재 규칙과 맞으면 제출 가능.
    fireEvent.keyDown(prefix!, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // 규칙을 바꾸고 미리보기가 오기 전 — 옛 판정으로 제출하지 않는다.
    fireEvent.change(prefix!, { target: { value: "y-" } });
    await settle();
    fireEvent.keyDown(prefix!, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("주 버튼에 Ctrl/⌘+Enter 힌트", async () => {
    vi.mocked(commands.fsBatchRenamePreview).mockResolvedValue(
      ok(["a.txt", "b.txt"]),
    );
    render(
      <BatchRenameDialog
        targets={targets}
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    await settle();
    const cta = screen.getByRole("button", { name: /Rename/ });
    expect(cta.querySelector("kbd")?.textContent).toMatch(/Enter|↩/);
  });
});
