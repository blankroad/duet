import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@/i18n";
import { PreviewContent } from "../PreviewContent";
import { activeTab, computeDisplayed, usePanes } from "@/stores/panes";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { useCommands } from "@/stores/commands";
import { useKeymap } from "@/stores/keymap";
import type { Entry } from "@/types/bindings";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));

/**
 * browse 점검(lead) 재현 — 마크다운 미리보기의 링크.
 * 앱 창(webview) 안에서 <a href> 클릭을 아무도 가로채지 않으면 앱 화면 자체가
 * 그 주소로 바뀐다(창 장식이 없는 앱이라 돌아올 버튼도 없다). 실제 이동은 기기 확인 필요.
 */
describe("browse-lead: 마크다운 미리보기 링크", () => {
  it("browse-08: 링크 클릭은 앱 창 이동을 막아야 한다(외부 브라우저로 열거나 무시)", () => {
    const { container } = render(
      <PreviewContent
        name="README.md"
        text={"[site](https://example.com) [doc](other.md)"}
        truncated={false}
      />,
    );
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(2);
    for (const a of Array.from(links)) {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      a.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    fireEvent.click(links[0]!);
  });

  it("browse-08: 가운데 클릭도 막고, 링크 주소는 툴팁으로 보인다", () => {
    const { container } = render(
      <PreviewContent
        name="README.md"
        text={"[site](https://example.com/x)"}
        truncated={false}
      />,
    );
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/x");
    expect(a.getAttribute("title")).toBe("https://example.com/x");
    expect(a.hasAttribute("node")).toBe(false);
    const ev = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it.each([
    ["Enter", "Enter"],
    [" ", "Space"],
  ])(
    "browse-08 (R2): %s on a focused preview link does not reach the pane",
    (key, code) => {
      const file: Entry = {
        name: "a.txt",
        kind: "file",
        size: 1,
        modified_ms: 0,
        permissions: null,
        hidden: false,
      };
      usePanes
        .getState()
        .setEntries("left", { source: { kind: "local" }, path: "/fixture" }, [
          file,
        ]);
      usePanes.getState().setActivePane("left");
      const t = activeTab(usePanes.getState(), "left");
      usePanes.getState().setCursor(
        "left",
        computeDisplayed(t).findIndex((e) => e.name === "a.txt"),
      );
      useCommands.setState({ builtins: [], dynamic: [] });
      useKeymap.setState({ bindings: [] });
      const activate = vi.fn();
      const quickLook = vi.fn();
      function Preview() {
        useKeyboardNav(activate, vi.fn(), quickLook);
        return (
          <PreviewContent
            name="README.md"
            text="[site](https://example.com)"
            truncated={false}
          />
        );
      }
      render(<Preview />);
      const link = screen.getByRole("link");
      link.focus();
      fireEvent.keyDown(link, { key, code });
      expect(activate).not.toHaveBeenCalled();
      expect(quickLook).not.toHaveBeenCalled();
      // 대조: 같은 키를 링크 밖에서 누르면 패널이 처리한다.
      if (key === "Enter") {
        fireEvent.keyDown(document.body, { key, code });
        expect(activate).toHaveBeenCalledOnce();
      }
    },
  );
});
