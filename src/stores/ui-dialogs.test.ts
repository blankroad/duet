import { describe, it, expect, beforeEach } from "vitest";
import { useUIDialogs } from "./ui-dialogs";

describe("ui-dialogs store", () => {
  beforeEach(() =>
    useUIDialogs.setState({
      dialog: { kind: "none" },
      queue: [],
      fromQueue: false,
    }),
  );

  it("opens and closes", () => {
    useUIDialogs.getState().open({ kind: "settings" });
    expect(useUIDialogs.getState().dialog.kind).toBe("settings");
    useUIDialogs.getState().close();
    expect(useUIDialogs.getState().dialog.kind).toBe("none");
  });

  it("only one dialog at a time — open replaces", () => {
    useUIDialogs.getState().open({ kind: "settings" });
    useUIDialogs
      .getState()
      .open({ kind: "progress", title: "x", taskId: "tid" });
    expect(useUIDialogs.getState().dialog.kind).toBe("progress");
  });

  it("openWhenFree: 쓰던 창이 있으면 갈아치우지 않고 닫힌 뒤 연다", () => {
    const d = useUIDialogs.getState();
    d.open({ kind: "batch-rename", targets: [] });
    expect(d.openWhenFree({ kind: "shortcuts" })).toBe(false);
    expect(useUIDialogs.getState().dialog.kind).toBe("batch-rename");
    useUIDialogs.getState().close();
    expect(useUIDialogs.getState().dialog.kind).toBe("shortcuts");
    useUIDialogs.getState().close();
    expect(useUIDialogs.getState().dialog.kind).toBe("none");
  });

  it("openWhenFree: 비어 있거나 진행률 창이면 바로 연다", () => {
    expect(useUIDialogs.getState().openWhenFree({ kind: "history" })).toBe(
      true,
    );
    useUIDialogs.getState().open({ kind: "progress", title: "x", taskId: "t" });
    expect(useUIDialogs.getState().openWhenFree({ kind: "shortcuts" })).toBe(
      true,
    );
    expect(useUIDialogs.getState().dialog.kind).toBe("shortcuts");
  });

  it("close() 직후 open() 해도 대기 중이던 창을 잃지 않는다", () => {
    const d = useUIDialogs.getState();
    d.open({ kind: "batch-rename", targets: [] });
    d.openWhenFree({ kind: "shortcuts" });
    // 확정 핸들러: 닫고 → 진행률 열기
    useUIDialogs.getState().close();
    useUIDialogs.getState().open({ kind: "progress", title: "x", taskId: "t" });
    expect(useUIDialogs.getState().dialog.kind).toBe("progress");
    useUIDialogs.getState().close();
    expect(useUIDialogs.getState().dialog.kind).toBe("shortcuts");
    useUIDialogs.getState().close();
    expect(useUIDialogs.getState().dialog.kind).toBe("none");
  });
});
