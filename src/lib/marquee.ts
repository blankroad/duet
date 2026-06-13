/**
 * 마키(러버밴드) 드래그 선택의 순수 기하 계산 — 컴포넌트에서 분리해 단위테스트.
 * 모든 좌표는 스크롤 *콘텐츠* 좌표계(스크롤 offset 포함) 기준.
 */

export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** x1<=x2, y1<=y2 로 정규화. */
export function normRect(r: Rect): Rect {
  return {
    x1: Math.min(r.x1, r.x2),
    y1: Math.min(r.y1, r.y2),
    x2: Math.max(r.x1, r.x2),
    y2: Math.max(r.y1, r.y2),
  };
}

/** 균일 높이 리스트에서 y 범위와 겹치는 행 인덱스들. */
export function rowsInRect(y1: number, y2: number, rowH: number, count: number): number[] {
  if (count <= 0 || rowH <= 0) return [];
  const top = Math.min(y1, y2);
  const bot = Math.max(y1, y2);
  const lo = Math.max(0, Math.floor(top / rowH));
  const hi = Math.min(count - 1, Math.floor(bot / rowH));
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

/** cols 열 그리드(셀 cellW×cellH)에서 rect 와 겹치는 셀 인덱스 (row-major). */
export function cellsInRect(
  r: Rect,
  cols: number,
  cellW: number,
  cellH: number,
  count: number,
): number[] {
  if (count <= 0 || cols <= 0 || cellW <= 0 || cellH <= 0) return [];
  const n = normRect(r);
  const c0 = Math.max(0, Math.floor(n.x1 / cellW));
  const c1 = Math.min(cols - 1, Math.floor(n.x2 / cellW));
  const r0 = Math.max(0, Math.floor(n.y1 / cellH));
  const r1 = Math.floor(n.y2 / cellH);
  const out: number[] = [];
  for (let ry = r0; ry <= r1; ry++) {
    for (let cx = c0; cx <= c1; cx++) {
      const idx = ry * cols + cx;
      if (idx < count) out.push(idx);
    }
  }
  return out;
}

/** 드래그 거리가 임계값을 넘었는지 (클릭 vs 마키 구분). */
export function exceedsThreshold(dx: number, dy: number, threshold = 4): boolean {
  return Math.abs(dx) >= threshold || Math.abs(dy) >= threshold;
}
