import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { commands } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import "@/i18n";
import { OpenWithSection } from "./OpenWithSection";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/types/bindings", () => ({
  commands: { settingsGet: vi.fn(), settingsSet: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  useToast.getState().clear();
  vi.mocked(commands.settingsGet).mockResolvedValue({
    status: "ok",
    data: {
      ext_app_overrides: { md: "/Apps/Markdown.app", txt: "/Apps/Editor.app" },
    },
  } as unknown as Awaited<ReturnType<typeof commands.settingsGet>>);
});
afterEach(cleanup);

type SetResult = Awaited<ReturnType<typeof commands.settingsSet>>;

describe("OpenWithSection 저장 실패", () => {
  it("저장이 실패하면 마지막 저장값으로 되돌리고 알린다, 저장 중엔 다른 편집 불가", async () => {
    let fail: () => void = () => {};
    vi.mocked(commands.settingsSet).mockReturnValue(
      new Promise<SetResult>((r) => {
        fail = () =>
          r({
            status: "error",
            error: { kind: "Io", message: "disk full" },
          } as SetResult);
      }),
    );
    render(<OpenWithSection />);
    await act(async () => {
      await Promise.resolve();
    });
    const removes = () => screen.getAllByRole("button", { name: "Remove" });
    expect(removes()).toHaveLength(2);
    fireEvent.click(removes()[1]!); // txt
    expect(removes()).toHaveLength(1);
    expect((removes()[0] as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fail();
      await Promise.resolve();
    });
    expect(removes()).toHaveLength(2);
    expect(useToast.getState().toasts.at(-1)?.message).toMatch(/disk full/);
  });
});
