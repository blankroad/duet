/**
 * 라인 단위 diff (LCS 기반) — 의존성 없이 텍스트 비교 미리보기에 사용.
 * 큰 입력은 호출측에서 줄 수를 cap 한 뒤 넘긴다(LCS 는 O(n*m)).
 */
export type DiffOp = { t: "ctx" | "del" | "add"; text: string };

export function lineDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..], b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] ?? [];
    const next = dp[i + 1] ?? [];
    const ai = a[i] ?? "";
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        ai === (b[j] ?? "")
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] ?? "";
    const bj = b[j] ?? "";
    if (ai === bj) {
      out.push({ t: "ctx", text: ai });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ t: "del", text: ai });
      i++;
    } else {
      out.push({ t: "add", text: bj });
      j++;
    }
  }
  while (i < n) out.push({ t: "del", text: a[i++] ?? "" });
  while (j < m) out.push({ t: "add", text: b[j++] ?? "" });
  return out;
}
