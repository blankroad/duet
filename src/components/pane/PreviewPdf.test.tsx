import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import i18n from "@/i18n";

// pdf.js 는 모킹 — 문서 정보는 바로, 첫 페이지는 테스트가 풀어 줄 때까지 대기.
let releasePage!: () => void;
const page = {
  getViewport: () => ({ width: 100, height: 100 }),
  render: () => ({ promise: Promise.resolve() }),
};
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  PDFDataRangeTransport: class {
    requestDataRange(_begin: number, _end: number) {}
    onDataRange(_begin: number, _chunk: Uint8Array) {}
  },
  getDocument: (source: {
    range?: { requestDataRange: (begin: number, end: number) => void };
  }) => {
    if (source.range)
      queueMicrotask(() => source.range?.requestDataRange(65536, 131072));
    return {
      destroy: () => Promise.resolve(),
      promise: Promise.resolve({
        numPages: 30,
        getPage: () =>
          new Promise((r) => {
            releasePage = () => r(page);
          }),
        destroy: () => Promise.resolve(),
      }),
    };
  },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const { PreviewPdf } = await import("./PreviewPdf");

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps the loading notice until the first page is drawn, then shows the page limit", async () => {
  render(
    <PreviewPdf url="duet-preview://x" fallback={<button>open</button>} />,
  );
  await act(async () => {}); // 문서 정보 수신
  expect(screen.getByText("Loading…")).toBeTruthy();
  await act(async () => releasePage());
  expect(screen.queryByText("Loading…")).toBeNull();
  expect(screen.getByText(/first 20 pages \(of 30\)/)).toBeTruthy();
});

it("re-reads the same PDF path when the file version changes", async () => {
  const pdfjs = await import("pdfjs-dist");
  const spy = vi.spyOn(pdfjs, "getDocument");
  const { PreviewView } = await import("./PreviewView");
  const loc = { source: { kind: "local" as const }, path: "/w/a.pdf" };
  const data = { kind: "pdf", total_size: 10 } as never;
  const { rerender } = render(
    <PreviewView name="a.pdf" location={loc} data={data} version="v1" />,
  );
  await act(async () => {});
  const before = spy.mock.calls.length;
  rerender(
    <PreviewView name="a.pdf" location={loc} data={data} version="v1" />,
  );
  await act(async () => {});
  expect(spy.mock.calls.length).toBe(before); // 같은 버전: 다시 읽지 않음
  rerender(
    <PreviewView name="a.pdf" location={loc} data={data} version="v2" />,
  );
  await act(async () => {});
  expect(spy.mock.calls.length).toBe(before + 1);
});

it("requests the initial PDF range explicitly", async () => {
  render(
    <PreviewPdf url="duet-preview://x" fallback={<button>open</button>} />,
  );
  await act(async () => {});
  expect(fetch).toHaveBeenCalledWith("duet-preview://x", {
    headers: { Range: "bytes=0-65535" },
    signal: expect.any(AbortSignal),
  });
});

it("shows the existing fallback when the initial range fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 413 })),
  );
  render(
    <PreviewPdf url="duet-preview://x" fallback={<button>open</button>} />,
  );
  await act(async () => {});
  expect(screen.getByRole("button", { name: "open" })).toBeTruthy();
  expect(screen.queryByText("Loading…")).toBeNull();
});

it("aborts an in-flight fetch when unmounted", async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }),
  );
  const view = render(<PreviewPdf url="duet-preview://x" fallback={null} />);
  await act(async () => {});
  view.unmount();
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(true);
});

it("shows the fallback when a later PDF range fails", async () => {
  const mockFetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(new Uint8Array(65536), {
        status: 206,
        headers: { "Content-Range": "bytes 0-65535/200000" },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 500 }));
  vi.stubGlobal("fetch", mockFetch);
  render(
    <PreviewPdf url="duet-preview://x" fallback={<button>open</button>} />,
  );
  await act(async () => {});
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "open" })).toBeTruthy();
  expect(screen.queryByText("Loading…")).toBeNull();
});
