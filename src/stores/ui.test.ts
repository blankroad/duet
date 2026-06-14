import { describe, it, expect, beforeEach } from "vitest";
import { useUI } from "./ui";

describe("ui store", () => {
  beforeEach(() => {
    useUI.setState({ sidebarOpen: true, previewOpen: false, collapsed: {} });
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

  it("toggleSection flips a section's collapsed state by key", () => {
    expect(useUI.getState().collapsed["bookmarks"]).toBeUndefined();
    useUI.getState().toggleSection("bookmarks");
    expect(useUI.getState().collapsed["bookmarks"]).toBe(true);
    useUI.getState().toggleSection("bookmarks");
    expect(useUI.getState().collapsed["bookmarks"]).toBe(false);
    // 다른 섹션은 영향 없음
    expect(useUI.getState().collapsed["hosts"]).toBeUndefined();
  });
});
