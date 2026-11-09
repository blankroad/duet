import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { StartupNotice } from "@/types/bindings";

const h = vi.hoisted(() => ({
  take: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/types/bindings", () => ({
  commands: { startupNoticesTake: h.take },
}));

import i18n from "@/i18n";
import { useToast } from "@/stores/toast";
import { useNotices } from "@/stores/notices";
import { describeStartupNotice, useStartupNotices } from "./useStartupNotices";

const reset: StartupNotice = {
  file: "/cfg/duet/keymap.toml",
  action: {
    kind: "reset",
    backup: "/cfg/duet/keymap.toml.corrupt-20261109-101500",
  },
  detail: "keymap parse: expected `=` at line 3",
};
const skipped: StartupNotice = {
  file: "/cfg/duet/journal.jsonl",
  action: {
    kind: "skipped_lines",
    count: 2,
    backup: "/cfg/duet/journal.jsonl.corrupt-20261109-101500",
  },
  detail: "line 7: EOF while parsing",
};

afterEach(() => {
  useToast.setState({ toasts: [] });
  h.take.mockReset();
});

describe("describeStartupNotice", () => {
  it("기본값으로 시작한 파일은 이름과 보관 사본 이름을 문장에, 전체 경로·원인은 자세히에", () => {
    void i18n.changeLanguage("en");
    const { message, detail } = describeStartupNotice(reset);
    expect(message).toContain("keymap.toml");
    expect(message).toContain("keymap.toml.corrupt-20261109-101500");
    expect(message).not.toContain("/cfg/duet");
    expect(detail).toContain("/cfg/duet/keymap.toml");
    expect(detail).toContain("expected `=` at line 3");
  });

  it("건너뛴 줄 수를 알린다", () => {
    void i18n.changeLanguage("ko");
    const { message, detail } = describeStartupNotice(skipped);
    expect(message).toContain("journal.jsonl");
    expect(message).toContain("2");
    expect(detail).toContain("journal.jsonl.corrupt-20261109-101500");
  });
});

describe("useStartupNotices", () => {
  it("마운트 시 한 번 가져와 경고 토스트로 띄우고 알림 기록에 남긴다", async () => {
    h.take.mockResolvedValue({ status: "ok", data: [reset, skipped] });
    renderHook(() => useStartupNotices());
    await act(async () => {});
    expect(h.take).toHaveBeenCalledTimes(1);
    const toasts = useToast.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts.every((t) => t.kind === "warning")).toBe(true);
    const logged = useNotices.getState().items;
    expect(logged.some((n) => n.detail?.includes("expected `=`"))).toBe(true);
  });

  it("알림이 없거나 IPC 가 실패하면 아무것도 띄우지 않는다", async () => {
    h.take.mockResolvedValue({
      status: "error",
      error: { kind: "Io", message: "x" },
    });
    renderHook(() => useStartupNotices());
    await act(async () => {});
    expect(useToast.getState().toasts).toHaveLength(0);
  });
});
