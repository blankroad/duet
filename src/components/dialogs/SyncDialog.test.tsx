import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { Location, SyncPreview } from "@/types/bindings";
import { commands } from "@/types/bindings";
import "@/i18n";
import { SyncDialog } from "./SyncDialog";

vi.mock("@/types/bindings", () => ({
  commands: { fsSyncPreview: vi.fn(), fsTrashUsage: vi.fn() },
}));

const src: Location = { source: { kind: "local" }, path: "/fixture/a" };
const dst: Location = { source: { kind: "local" }, path: "/fixture/b" };
type PreviewResult = Awaited<ReturnType<typeof commands.fsSyncPreview>>;

let resolvePreview: (v: PreviewResult) => void = () => {};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(commands.fsSyncPreview).mockReturnValue(
    new Promise<PreviewResult>((r) => {
      resolvePreview = r;
    }),
  );
});
afterEach(cleanup);

const preview: SyncPreview = { copy: ["x.txt"], prune: [], truncated: false };
const cta = () =>
  screen.getByRole("button", { name: /^Sync/ }) as HTMLButtonElement;

describe("SyncDialog", () => {
  it("미리보기 전엔 실행 불가, 도착하면 주 버튼에 포커스 + Enter 로 실행", async () => {
    const onConfirm = vi.fn();
    render(
      <SyncDialog
        src={src}
        dst={dst}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    expect(cta().disabled).toBe(true);
    fireEvent.click(cta());
    expect(onConfirm).not.toHaveBeenCalled();
    // 계산 중 Enter 는 창을 닫지 않는다 — 포커스가 버튼([취소])에 있지 않다.
    expect(document.activeElement?.tagName).not.toBe("BUTTON");
    await act(async () => {
      resolvePreview({ status: "ok", data: preview });
      await Promise.resolve();
    });
    expect(cta().disabled).toBe(false);
    expect(document.activeElement).toBe(cta());
  });

  it("미리보기 실패 + 삭제 전파면 실행 불가", async () => {
    render(
      <SyncDialog src={src} dst={dst} onClose={() => {}} onConfirm={vi.fn()} />,
    );
    await act(async () => {
      resolvePreview({
        status: "error",
        error: { kind: "Io", message: "boom" },
      } as PreviewResult);
      await Promise.resolve();
    });
    expect(cta().disabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(cta().disabled).toBe(true);
  });
});
