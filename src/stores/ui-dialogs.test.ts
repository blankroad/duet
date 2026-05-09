import { describe, it, expect, beforeEach } from "vitest";
import { useUIDialogs } from "./ui-dialogs";

describe("ui-dialogs store", () => {
  beforeEach(() => useUIDialogs.setState({ dialog: { kind: "none" } }));

  it("opens and closes", () => {
    useUIDialogs.getState().open({ kind: "settings" });
    expect(useUIDialogs.getState().dialog.kind).toBe("settings");
    useUIDialogs.getState().close();
    expect(useUIDialogs.getState().dialog.kind).toBe("none");
  });

  it("only one dialog at a time — open replaces", () => {
    useUIDialogs.getState().open({ kind: "settings" });
    useUIDialogs.getState().open({ kind: "progress", title: "x" });
    expect(useUIDialogs.getState().dialog.kind).toBe("progress");
  });
});
