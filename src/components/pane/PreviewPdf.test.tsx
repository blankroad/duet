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
