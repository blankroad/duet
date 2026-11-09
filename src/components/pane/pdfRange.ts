import type { PDFDataRangeTransport } from "pdfjs-dist";

/** A validated single byte range; end is inclusive as in HTTP Content-Range. */
export function parseContentRange(value: string | null) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) throw new Error("Missing PDF Content-Range");
  const begin = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    ![begin, end, total].every(Number.isSafeInteger) ||
    begin < 0 ||
    end < begin ||
    end >= total
  )
    throw new Error("Invalid PDF Content-Range");
  return { begin, end, total };
}

async function fetchPart(
  url: string,
  begin: number,
  end: number,
  signal: AbortSignal,
) {
  const response = await fetch(url, {
    headers: { Range: `bytes=${begin}-${end - 1}` },
    signal,
  });
  if (response.status !== 200 && response.status !== 206) {
    throw new Error(`PDF request failed (${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes };
}

/** Fetch the exact pdf.js window, continuing when the server caps each response. */
export async function readPdfRange(
  url: string,
  begin: number,
  end: number,
  total: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(begin) ||
    !Number.isSafeInteger(end) ||
    begin < 0 ||
    end <= begin ||
    end > total
  ) {
    throw new Error("Invalid PDF range request");
  }
  const result = new Uint8Array(end - begin);
  let cursor = begin;
  while (cursor < end) {
    const { response, bytes } = await fetchPart(url, cursor, end, signal);
    if (response.status === 200) {
      if (bytes.length !== total)
        throw new Error("Incomplete PDF full response");
      result.set(bytes.subarray(cursor, end), cursor - begin);
      return result;
    }
    const range = parseContentRange(response.headers.get("Content-Range"));
    if (
      range.begin !== cursor ||
      range.total !== total ||
      range.end >= end ||
      bytes.length !== range.end - range.begin + 1
    ) {
      throw new Error("Unexpected PDF range response");
    }
    result.set(bytes, cursor - begin);
    cursor += bytes.length;
  }
  return result;
}

/** Bootstrap with an explicit Range so a large file is never mistaken for a short one. */
export async function preparePdfSource(
  url: string,
  signal: AbortSignal,
  Transport: typeof PDFDataRangeTransport,
  onError: (error: unknown) => void,
): Promise<{ data: Uint8Array } | { range: PDFDataRangeTransport }> {
  const { response, bytes } = await fetchPart(url, 0, 65536, signal);
  if (response.status === 200) return { data: bytes };
  const range = parseContentRange(response.headers.get("Content-Range"));
  if (
    range.begin !== 0 ||
    range.end >= 65536 ||
    bytes.length !== range.end + 1
  ) {
    throw new Error("Unexpected initial PDF range response");
  }
  if (bytes.length === range.total) return { data: bytes };
  // No progressive stream follows the initial bytes: pdf.js must request missing ranges.
  const transport = new Transport(range.total, bytes, true);
  transport.requestDataRange = (begin, end) => {
    void readPdfRange(url, begin, end, range.total, signal)
      .then((chunk) => {
        if (!signal.aborted) transport.onDataRange(begin, chunk);
      })
      .catch(onError);
  };
  return { range: transport };
}
