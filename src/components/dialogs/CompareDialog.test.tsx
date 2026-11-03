import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CompareEntry, ComparePlan } from "@/types/bindings";
import { commands } from "@/types/bindings";
import "@/i18n";
import { CompareDialog } from "./CompareDialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@/types/bindings", () => ({
  commands: {
    fsCompareDirs: vi.fn(),
    fsCompareVerify: vi.fn(),
    settingsGet: vi.fn().mockResolvedValue({ status: "error", error: {} }),
    settingsSet: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

const entry = (status: CompareEntry["status"]): CompareEntry => ({
  rel: "x.txt",
  kind: "file",
  status,
  left_size: 1,
  right_size: 1,
  left_mtime_ms: 2000,
  right_mtime_ms: 1000,
});
const plan = (status: CompareEntry["status"]): ComparePlan => ({
  left: { source: { kind: "local" }, path: "/fixture/l" },
  right: { source: { kind: "local" }, path: "/fixture/r" },
  entries: [entry(status)],
  left_only: 0,
  right_only: 0,
  differ: status === "same" ? 0 : 1,
  same: status === "same" ? 1 : 0,
  truncated: false,
  strategy: { kind: "local_to_local" },
});

Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);

describe("CompareDialog 다시 비교", () => {
  it("다시 비교로 '같음' 이 된 행은 옛 기본 방향으로 덮어쓰지 않는다", async () => {
    vi.mocked(commands.fsCompareDirs).mockResolvedValue({
      status: "ok",
      data: plan("same"),
    });
    const onApply = vi.fn();
    render(
      <CompareDialog
        plan={plan("newer_left")}
        onClose={() => {}}
        onMerge={() => {}}
        onApply={onApply}
      />,
    );
    const applyBtn = () =>
      screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement;
    expect(applyBtn().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Re-compare/ }));
      await Promise.resolve();
    });
    expect(applyBtn().disabled).toBe(true);
  });

  it("검증하는 사이 다시 비교했으면 늦게 온 검증이 옛 목록을 되살리지 않는다", async () => {
    const two = (): ComparePlan => ({
      ...plan("same"),
      entries: [
        { ...entry("same"), rel: "old.txt" },
        { ...entry("newer_left"), rel: "excluded.txt" },
      ],
    });
    type VerifyResult = Awaited<ReturnType<typeof commands.fsCompareVerify>>;
    let resolveVerify: (v: VerifyResult) => void = () => {};
    vi.mocked(commands.fsCompareVerify).mockReturnValue(
      new Promise<VerifyResult>((r) => {
        resolveVerify = r;
      }),
    );
    vi.mocked(commands.fsCompareDirs).mockResolvedValue({
      status: "ok",
      data: {
        ...plan("same"),
        entries: [{ ...entry("same"), rel: "new.txt" }],
      },
    });
    const onApply = vi.fn();
    render(
      <CompareDialog
        plan={two()}
        onClose={() => {}}
        onMerge={() => {}}
        onApply={onApply}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Verify/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Re-compare/ }));
      await Promise.resolve();
    });
    await act(async () => {
      resolveVerify({
        status: "ok",
        data: [{ rel: "old.txt", equal: false }],
      } as VerifyResult);
      await Promise.resolve();
    });
    expect(screen.queryByText(/excluded\.txt/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
