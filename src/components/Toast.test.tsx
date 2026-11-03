import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Toast } from "./Toast";
import { DialogShell } from "./dialogs/DialogShell";
import { useToast } from "@/stores/toast";
import i18n from "@/i18n";

afterEach(() => {
  cleanup();
  useToast.getState().clear();
});

describe("Toast", () => {
  it("keeps full long errors readable and dismisses only the chosen notification", () => {
    const message = `/remote/${"long_filename_".repeat(100)}\nConnection failed`;
    useToast.setState({
      toasts: [
        { id: 1, message, kind: "error" },
        { id: 2, message: "Copy complete", kind: "success" },
      ],
    });
    render(<Toast />);
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(screen.getByRole("status").textContent).toBe("Copy complete");
    fireEvent.click(
      screen.getAllByRole("button", { name: i18n.t("common.close") })[0]!,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Copy complete");
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("common.close") }),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Toast over a dialog", () => {
  it("대화상자 위에 뜨고, 토스트를 닫아도 대화상자는 닫히지 않는다", () => {
    const onClose = vi.fn();
    render(
      <>
        <DialogShell title="Fixture" onClose={onClose}>
          <span>body</span>
        </DialogShell>
        <Toast />
      </>,
    );
    act(() => useToast.getState().show("Symlink failed", "error"));
    const alert = screen.getByRole("alert");
    expect(alert.closest("[aria-hidden='true']")).toBeNull();
    expect(alert.closest("[data-toast-root]")?.className).toContain("z-[70]");
    const close = screen.getByRole("button", { name: i18n.t("common.close") });
    fireEvent.pointerDown(close);
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("토스트가 먼저 떠 있어도 대화상자가 열린 뒤 읽힌다(aria-hidden 아님)", async () => {
    act(() => useToast.getState().show("Earlier error", "error"));
    render(<Toast />);
    render(
      <DialogShell title="Fixture" onClose={() => {}}>
        <span>body</span>
      </DialogShell>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => useToast.getState().show("Symlink failed", "error"));
    await act(async () => {
      await Promise.resolve();
    });
    for (const alert of screen.getAllByRole("alert"))
      expect(alert.closest("[aria-hidden='true']")).toBeNull();
  });
});
