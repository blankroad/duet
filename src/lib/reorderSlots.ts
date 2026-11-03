/**
 * 부분 재정렬 — `order` 에 든 항목들이 **원래 차지하던 자리**에만 새 순서를 채우고,
 * 나머지(필터로 숨은 항목·그룹에 든 항목 등)는 제자리에 둔다. 백엔드 reorder 와 같은 규칙.
 *
 * 낙관적 갱신에서 전달한 키만으로 배열을 새로 만들면, IPC 왕복 동안 나머지 항목이
 * store 에서 잠깐 사라졌다(그룹 폴더가 비고 개수가 바뀜).
 */
export function reorderInSlots<T>(
  all: readonly T[],
  keyOf: (item: T) => string,
  order: readonly string[],
): T[] {
  const byKey = new Map(all.map((x) => [keyOf(x), x]));
  const queue = order
    .map((k) => byKey.get(k))
    .filter((x): x is T => x !== undefined);
  const moving = new Set(queue.map(keyOf));
  let i = 0;
  return all.map((x) => (moving.has(keyOf(x)) ? queue[i++]! : x));
}
