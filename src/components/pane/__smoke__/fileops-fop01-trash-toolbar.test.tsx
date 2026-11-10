// Adopted from research repro-tests/fop01-trash-toolbar.test.tsx (UX-FOP-01). mocked FE test.
// FE-MOCK: real toolbar; shared action spies prevent side effects.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
vi.mock("@/lib/fileActions", () => ({
  triggerMkdir: vi.fn(),
  triggerNewFile: vi.fn(),
  triggerCopy: vi.fn(),
  triggerMove: vi.fn(),
  triggerDelete: vi.fn(),
}));
import { PaneToolbar } from "@/components/pane/PaneToolbar";
import { usePanes, activeTab } from "@/stores/panes";
import { VIRTUAL_TRASH_PATH } from "@/lib/trashView";
import i18n from "@/i18n";
afterEach(cleanup);
it.each(["Copy", "Move"])(
  "UX-FOP-01: virtual trash toolbar %s is disabled",
  async (label) => {
    await i18n.changeLanguage("en");
    const s = usePanes.getState(),
      base = activeTab(s, "left");
    usePanes.setState({
      activePane: "left",
      panes: {
        ...s.panes,
        left: {
          tabs: [
            {
              ...base,
              location: { source: { kind: "local" }, path: VIRTUAL_TRASH_PATH },
            },
          ],
          activeTabIndex: 0,
        },
      },
    });
    render(<PaneToolbar id="left" />);
    expect(
      (screen.getByRole("button", { name: /^New folder/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: new RegExp(`^${label}`),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  },
);
