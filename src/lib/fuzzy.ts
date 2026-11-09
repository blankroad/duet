/**
 * 단순 fuzzy match. subsequence + scoring.
 *
 * - 빈 query: score 0 (모든 항목 통과)
 * - subsequence 안 맞으면 null
 * - bonus: 첫 char 가 word boundary (대문자, 공백/구두점 직후, position 0)
 * - bonus: 연속 매칭 (run length 가 클수록)
 *
 * commands 수가 적어서 (~50) perf 무시.
 *
 * 질의·텍스트는 NFC 로 맞춰 비교한다 — macOS 파일 이름에서 온 NFD 한글(자모 분해)도
 * 키보드로 친 NFC 한글과 같은 글자로 본다 (G-14).
 */
export function fuzzyScore(query: string, rawText: string): number | null {
  if (query.length === 0) return 0;
  const text = rawText.normalize("NFC");
  const q = query.normalize("NFC").toLowerCase();
  const t = text.toLowerCase();

  let score = 0;
  let qi = 0;
  let runLen = 0; // current consecutive match run length
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      runLen++;
      score += 1;
      // Consecutive run bonus: grows quadratically with run length
      score += (runLen - 1) * 3;
      if (i === 0 || isBoundary(text, i)) score += 3;
      qi++;
    } else {
      runLen = 0;
    }
  }
  if (qi < q.length) return null;
  return score - text.length * 0.01;
}

function isBoundary(text: string, i: number): boolean {
  const ch = text[i]!;
  if (ch >= "A" && ch <= "Z") return true;
  if (i > 0) {
    const prev = text[i - 1]!;
    if (!/[a-zA-Z0-9]/.test(prev)) return true;
  }
  return false;
}
