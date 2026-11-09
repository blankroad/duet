// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { preparePdfSource } from "../pdfRange";
import { afterEach, vi } from "vitest";
const ROOT = process.cwd();
afterEach(() => vi.unstubAllGlobals());

/** 2쪽짜리 정상 PDF + 20MiB 패딩 스트림. catalogFirst=true 면 카탈로그·1쪽이 앞쪽에 있다. */
function buildPdf(catalogFirst: boolean): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: Record<number, number> = {};
  let pos = 0;
  const push = (s: string | Uint8Array) => {
    const b = typeof s === "string" ? enc.encode(s) : s;
    parts.push(b);
    pos += b.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  const stream = (n: number, data: Uint8Array) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n<< /Length ${data.length} >>\nstream\n`);
    push(data);
    push("\nendstream\nendobj\n");
  };
  const content = enc.encode("BT /F1 24 Tf 72 700 Td (Hello page) Tj ET");
  const page = (n: number, c: number) =>
    obj(
      n,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 7 0 R >> >> >>`,
    );
  const catalog = () => {
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>");
  };
  push("%PDF-1.4\n");
  const pad = new Uint8Array(20 * 1024 * 1024).fill(0x30);
  if (catalogFirst) {
    catalog();
    page(3, 4);
    stream(4, content);
    stream(5, pad);
    page(6, 8);
    stream(8, content);
  } else {
    stream(5, pad);
    catalog();
    page(3, 4);
    stream(4, content);
    page(6, 8);
    stream(8, content);
  }
  obj(7, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const xref = pos;
  let x = "xref\n0 9\n0000000000 65535 f \n";
  for (let i = 1; i < 9; i++)
    x += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(`${x}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function openPdf(bytes: Uint8Array): Promise<number> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    resolve(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ).href;
  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  const n = doc.numPages;
  await doc.getPage(1);
  await doc.destroy();
  return n;
}

describe("browse-33 large PDF range preview (pdf.js 4.10.38)", () => {
  it("opens a complete large PDF as a control", async () => {
    expect(await openPdf(buildPdf(false))).toBe(2);
  });

  for (const catalogFirst of [false, true]) {
    it(`opens both pages through capped ranges (catalogFirst=${catalogFirst})`, async () => {
      const full = buildPdf(catalogFirst);
      const requests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const header = (init.headers as Record<string, string>).Range!;
          requests.push(header);
          const [, start, last] = /^bytes=(\d+)-(\d+)$/.exec(header)!;
          const begin = Number(start);
          const end = Math.min(
            Number(last) + 1,
            begin + 8 * 1024 * 1024,
            full.length,
          );
          return new Response(full.slice(begin, end), {
            status: 206,
            headers: {
              "Content-Range": `bytes ${begin}-${end - 1}/${full.length}`,
            },
          });
        }),
      );
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
        resolve(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
      ).href;
      const controller = new AbortController();
      let fail!: (error: unknown) => void;
      const failed = new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
      const source = await preparePdfSource(
        "pdf",
        controller.signal,
        pdfjs.PDFDataRangeTransport,
        fail,
      );
      // Force a request larger than the server cap so continuation is exercised with real pdf.js.
      const task = pdfjs.getDocument({
        ...source,
        rangeChunkSize: 16 * 1024 * 1024,
        verbosity: 0,
      });
      try {
        const doc = await Promise.race([task.promise, failed]);
        expect(doc.numPages).toBe(2);
        await Promise.race([
          Promise.all([doc.getPage(1), doc.getPage(2)]),
          failed,
        ]);
        const complete = await Promise.race([doc.getData(), failed]);
        expect(createHash("sha256").update(complete).digest("hex")).toBe(
          createHash("sha256").update(full).digest("hex"),
        );
        expect(requests[0]).toBe("bytes=0-65535");
        expect(requests.length).toBeGreaterThan(2);
      } finally {
        controller.abort();
        await task.destroy();
      }
    }, 30_000);
  }
});
