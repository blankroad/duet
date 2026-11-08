// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * browse 점검 R3 (opus) — F-sol-201: Range 없는 첫 요청에 `preview_stream.rs` 가 16MiB 로
 * 자른 본문을 200 + Content-Length(=잘린 길이)로 보낸다. pdf.js 는 Content-Length 를 파일
 * 길이로 믿으므로(Windows fetch 경로는 그 안에서만 Range 요청, macOS 커스텀 스킴은 XHR 로
 * 본문 그대로) 실제로 받는 문서는 "앞 16MiB" 다. 그 바이트를 설치된 pdf.js 로 열어 본다.
 */

const ROOT = process.cwd();
const STREAM = readFileSync(
  resolve(ROOT, "src-tauri/src/services/preview_stream.rs"),
  "utf8",
);

/** 제품 코드의 No-Range 상한을 그대로 확인 (값이 바뀌면 테스트가 알려 준다). */
function productCap(): number {
  expect(STREAM).toContain("const MAX_FULL: usize = 16 * 1024 * 1024;");
  expect(STREAM).toContain("let want = (total as usize).min(MAX_FULL);");
  expect(STREAM).toContain(
    ".header(header::CONTENT_LENGTH, bytes.len().to_string())",
  );
  return 16 * 1024 * 1024;
}

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

describe("F-sol-201 큰 PDF 미리보기 (pdf.js 4.10.38 실측)", () => {
  it("대조: 20MiB 넘는 정상 PDF 전체 바이트는 열린다", async () => {
    expect(await openPdf(buildPdf(false))).toBe(2);
    expect(await openPdf(buildPdf(true))).toBe(2);
  }, 60_000);

  it.fails(
    "browse-33 (F-sol-201): 미리보기가 실제로 받는 앞 16MiB 는 열리지 않는다 (카탈로그가 뒤쪽)",
    async () => {
      const cap = productCap();
      const full = buildPdf(false);
      expect(full.length).toBeGreaterThan(cap);
      expect(await openPdf(full.slice(0, cap))).toBe(2);
    },
    60_000,
  );

  it.fails(
    "browse-33 (F-sol-201): 카탈로그·1쪽이 앞 16MiB 안에 있어도 열리지 않는다",
    async () => {
      const cap = productCap();
      expect(await openPdf(buildPdf(true).slice(0, cap))).toBe(2);
    },
    60_000,
  );
});
