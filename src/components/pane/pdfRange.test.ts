// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { parseContentRange, preparePdfSource, readPdfRange } from "./pdfRange";
import { PDFDataRangeTransport } from "pdfjs-dist/legacy/build/pdf.mjs";

afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;

it("validates Content-Range offsets and total", () => {
  expect(parseContentRange("bytes 10-19/30")).toEqual({
    begin: 10,
    end: 19,
    total: 30,
  });
  for (const value of [
    null,
    "bytes */30",
    "bytes 20-10/30",
    "bytes 0-30/30",
    "bytes 0-1/9007199254740992",
  ]) {
    expect(() => parseContentRange(value)).toThrow();
  }
});

it("continues short ranges and returns exactly the requested bytes", async () => {
  const full = Uint8Array.from({ length: 25 }, (_, i) => i);
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const header = (init.headers as Record<string, string>).Range!;
      requests.push(header);
      const [, start, last] = /^bytes=(\d+)-(\d+)$/.exec(header)!;
      const begin = Number(start);
      const end = Math.min(Number(last) + 1, begin + 8);
      return new Response(full.slice(begin, end), {
        status: 206,
        headers: { "Content-Range": `bytes ${begin}-${end - 1}/25` },
      });
    }),
  );
  expect(await readPdfRange("pdf", 3, 24, 25, signal())).toEqual(
    full.slice(3, 24),
  );
  expect(requests).toEqual(["bytes=3-23", "bytes=11-23", "bytes=19-23"]);
});

it("handles full responses when the environment ignores Range", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  expect(
    await preparePdfSource("pdf", signal(), PDFDataRangeTransport, vi.fn()),
  ).toEqual({ data: new Uint8Array([1, 2, 3]) });
  expect(await readPdfRange("pdf", 1, 3, 3, signal())).toEqual(
    new Uint8Array([2, 3]),
  );
});

it("uses data directly when the initial partial response contains the whole PDF", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2]), {
          status: 206,
          headers: { "Content-Range": "bytes 0-1/2" },
        }),
    ),
  );
  expect(
    await preparePdfSource("pdf", signal(), PDFDataRangeTransport, vi.fn()),
  ).toEqual({ data: new Uint8Array([1, 2]) });
});

it("rejects failed, empty, shifted, truncated, and changed-total responses", async () => {
  for (const response of [
    new Response(null, { status: 413 }),
    new Response(null, {
      status: 206,
      headers: { "Content-Range": "bytes 0-1/30" },
    }),
    new Response(new Uint8Array(2), {
      status: 206,
      headers: { "Content-Range": "bytes 1-2/30" },
    }),
    new Response(new Uint8Array(2), {
      status: 206,
      headers: { "Content-Range": "bytes 0-1/31" },
    }),
    new Response(new Uint8Array(2)),
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(readPdfRange("pdf", 0, 10, 30, signal())).rejects.toThrow();
  }
});

it("forwards range failures and aborts through the supplied signal", async () => {
  const controller = new AbortController();
  const onError = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      return new Response(new Uint8Array([1, 2]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-1/30" },
      });
    }),
  );
  const source = await preparePdfSource(
    "pdf",
    controller.signal,
    PDFDataRangeTransport,
    onError,
  );
  if (!("range" in source)) throw new Error("Expected range transport");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    ),
  );
  source.range.requestDataRange(10, 20);
  controller.abort();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
});
