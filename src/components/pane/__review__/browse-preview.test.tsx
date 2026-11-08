import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

/**
 * browse 점검 R1 (opus) — C-14 미리보기 패널: 빠른 커서 이동 시 늦게 온 미리보기 경쟁,
 * 오류·잘림 표시, previewUrl hex 인코딩(한글·이모지·Windows 경로) 정합.
 */

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
const fsReadPreview = vi.fn();
vi.mock("@/types/bindings", () => ({
  commands: new Proxy({} as Record<string, unknown>, {
    get: (_t, k: string) =>
      k === "fsReadPreview"
        ? (...a: unknown[]) => fsReadPreview(...a)
        : async () => ({ status: "ok", data: null }),
  }),
  events: {},
}));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const { PreviewPane } = await import("../PreviewPane");
const { usePanes } = await import("@/stores/panes");
const { previewStreamUrl, thumbUrl } = await import("@/lib/previewUrl");
const i18n = (await import("@/i18n")).default;
import type { Entry, Location } from "@/types/bindings";

const DIR: Location = { source: { kind: "local" }, path: "/p" };
const file = (name: string): Entry => ({
  name,
  kind: "file",
  size: 1,
  modified_ms: 0,
  permissions: null,
  hidden: false,
});

function seed(names: string[], cursor: number) {
  const base = usePanes.getState().panes.left.tabs[0]!;
  usePanes.setState({
    activePane: "left",
    panes: {
      left: {
        tabs: [
          {
            ...base,
            id: "P0",
            location: DIR,
            entries: names.map(file),
            cursorIndex: cursor,
            selected: new Set(),
            filter: "",
            sortKey: "name",
            sortOrder: "asc",
            showHidden: false,
          },
        ],
        activeTabIndex: 0,
      },
      right: usePanes.getState().panes.right,
    },
  });
}
const text = (t: string, truncated = false) => ({
  status: "ok",
  data: { kind: "text", text: t, truncated, total_size: 999_999 },
});
const wait = (ms: number) =>
  act(() => new Promise<void>((r) => setTimeout(r, ms)));

afterEach(() => {
  cleanup();
  fsReadPreview.mockReset();
});

describe("C-14 미리보기 경쟁", () => {
  it("a 미리보기 요청이 늦게 끝나도, 그사이 b 로 옮기면 b 내용만 남는다", async () => {
    await i18n.changeLanguage("en");
    fsReadPreview.mockImplementation(async (loc: Location) => {
      const slow = String(loc.path).endsWith("a.txt");
      await new Promise((r) => setTimeout(r, slow ? 400 : 30));
      return text(slow ? "AAA-content" : "BBB-content");
    });
    // ".." 가 0번 → a.txt=1, b.txt=2
    seed(["a.txt", "b.txt"], 1);
    render(<PreviewPane />);
    await wait(200); // a 디바운스(150ms) 지나 요청 진행 중
    act(() => usePanes.getState().setCursor("left", 2));
    // 머신 부하로 타이머가 늦을 수 있다 — 1.5초 동안 50ms 간격으로 화면을 본다.
    // a 내용은 한 번도 보이면 안 되고, b 내용은 결국 보여야 한다.
    let sawA = false;
    let sawB = false;
    for (let i = 0; i < 30; i++) {
      await wait(50);
      const body = document.body.textContent ?? "";
      if (body.includes("AAA-content")) sawA = true;
      if (body.includes("BBB-content")) sawB = true;
    }
    expect(sawA).toBe(false);
    expect(sawB).toBe(true);
  });

  it("오류는 패널에 문구로, 잘린 텍스트는 잘림 안내가 보인다", async () => {
    await i18n.changeLanguage("en");
    fsReadPreview.mockResolvedValueOnce({
      status: "error",
      error: { kind: "PermissionDenied", message: "/p/a.txt" },
    });
    seed(["a.txt", "b.txt"], 1);
    render(<PreviewPane />);
    await wait(250);
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/Permission denied/);
    fsReadPreview.mockResolvedValue(text("x".repeat(10), true));
    act(() => usePanes.getState().setCursor("left", 2));
    await wait(250);
    const body2 = document.body.textContent ?? "";
    expect(body2).toMatch(/Preview truncated/);
    expect(body2).toMatch(/xxxxxxxxxx/);
  });
});

describe("C-14 previewUrl 인코딩", () => {
  const utf8hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

  it("한글·이모지·Windows 경로가 UTF-8 hex 로 그대로 인코딩된다 (백엔드 parse_target 형식)", () => {
    const p = "C:\\사진 폴더\\😀 a#b?.png";
    const url = previewStreamUrl({ source: { kind: "local" }, path: p });
    const seg = url.split("/").slice(-2);
    expect(seg).toEqual(["local", utf8hex(p)]);
    const ssh = thumbUrl({
      source: {
        kind: "ssh",
        connection_id: "prod:abc",
        host_ip: "1.1.1.1",
        user: "u",
      },
      path: "/srv/한글.jpg",
    });
    expect(ssh.split("/").slice(-3)).toEqual([
      "ssh",
      utf8hex("prod:abc"),
      utf8hex("/srv/한글.jpg"),
    ]);
  });
});
