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

  it("setProgress updates progress on progress dialog only", () => {
    useUIDialogs.getState().open({ kind: "progress", title: "Copying" });
    useUIDialogs.getState().setProgress({
      bytesDone: 100,
      bytesTotal: 200,
      speedBps: 50,
      etaSec: 2,
      percent: 50,
    });
    const d = useUIDialogs.getState().dialog;
    expect(d.kind).toBe("progress");
    if (d.kind === "progress") {
      expect(d.progress?.percent).toBe(50);
    }

    // settings dialog 면 no-op
    useUIDialogs.getState().open({ kind: "settings" });
    useUIDialogs.getState().setProgress({
      bytesDone: 999,
      bytesTotal: null,
      speedBps: null,
      etaSec: null,
      percent: null,
    });
    expect(useUIDialogs.getState().dialog.kind).toBe("settings");
  });
});
