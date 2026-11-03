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
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 30,
      getPage: () =>
        new Promise((r) => {
          releasePage = () => r(page);
        }),
      destroy: () => Promise.resolve(),
    }),
  }),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const { PreviewPdf } = await import("./PreviewPdf");

beforeEach(async () => {
  await i18n.changeLanguage("en");
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
});
afterEach(cleanup);

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
