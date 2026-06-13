import { describe, it, expect, beforeEach } from "vitest";
import { useUI } from "./ui";

describe("ui store", () => {
  beforeEach(() => {
    useUI.setState({ sidebarOpen: true, previewOpen: false });
  });

  it("togglePreview flips previewOpen", () => {
    expect(useUI.getState().previewOpen).toBe(false);
    useUI.getState().togglePreview();
    expect(useUI.getState().previewOpen).toBe(true);
    useUI.getState().togglePreview();
    expect(useUI.getState().previewOpen).toBe(false);
  });

  it("toggleSidebar flips sidebarOpen independently of preview", () => {
    useUI.getState().togglePreview();
    useUI.getState().toggleSidebar();
    expect(useUI.getState().sidebarOpen).toBe(false);
    expect(useUI.getState().previewOpen).toBe(true);
  });
});
