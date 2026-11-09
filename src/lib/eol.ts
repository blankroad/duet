/**
 * 텍스트 줄 끝(EOL) 판정·분리 — 비교 미리보기가 CRLF(Windows) ↔ LF(macOS·Linux) 차이를
 * "모든 줄이 다름"으로 보이지 않게 한다 (SC-22).
 */

/** 줄 끝 방식. 줄바꿈이 없는 텍스트는 판정하지 않는다(null). */
export type LineEnding = "crlf" | "lf" | "mixed";

/** 텍스트의 줄 끝 방식 — `\r\n` 만이면 crlf, `\n` 만이면 lf, 둘 다면 mixed. */
export function detectLineEnding(text: string): LineEnding | null {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
    if (i > 0 && text[i - 1] === "\r") crlf += 1;
    else lf += 1;
  }
  if (crlf === 0 && lf === 0) return null;
  if (crlf > 0 && lf > 0) return "mixed";
  return crlf > 0 ? "crlf" : "lf";
}

/**
 * 줄로 나눈다 — `\n` 바로 앞의 `\r`(CRLF 의 CR)만 뗀다. 내용 비교는 줄 끝 방식과 무관하게.
 * `\n` 이 뒤따르지 않는 CR(파일 끝 `abc\r` 등)은 줄 끝이 아니라 내용이라 남긴다.
 */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}
