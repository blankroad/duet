import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Toast } from "./Toast";
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
