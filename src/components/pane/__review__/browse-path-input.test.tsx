import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PathBar } from "@/components/pane/PathBar";
import i18n from "@/i18n";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
afterEach(cleanup);

it.fails(
  "browse-11 (F-sol-11): Explorer Copy as path quotes should be removed before navigating",
  async () => {
    await i18n.changeLanguage("en");
    const navigate = vi.fn();
    render(
      <PathBar
        location={{ source: { kind: "local" }, path: "C:\\Users" }}
        canBack={false}
        canForward={false}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onSegmentClick={navigate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit path" }));
    const input = screen.getByRole("textbox", { name: "Go to path" });
    fireEvent.change(input, {
      target: { value: '"C:\\한글 폴더\\space name"' },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("C:\\한글 폴더\\space name");
  },
);
