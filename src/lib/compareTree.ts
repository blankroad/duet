import type { CompareEntry, CompareStatus } from "@/types/bindings";

/**
 * flat CompareEntry[] → 디렉토리 트리. 표시 전용(rel 문자열 분해는 §7 위반 아님 —
 * 실경로 조작이 아니라 화면 그룹핑). 한쪽-전용 디렉토리는 leaf(내부 미전개), 양쪽-존재
 * 디렉토리는 자식 rel 들로 합성된 folder 노드.
 */
export interface TreeNode {
  /** 표시 이름(마지막 세그먼트). */
  name: string;
  /** 전체 상대경로. */
  rel: string;
  /** leaf 면 원본 entry, folder(합성)면 undefined. */
  entry?: CompareEntry;
  /** folder 면 자식들, leaf 면 undefined. */
  children?: TreeNode[];
  /** 자손 leaf status 집계(folder) 또는 자기 1개(leaf). */
  rollup: Record<CompareStatus, number>;
}

const STATUS_KEYS: CompareStatus[] = [
  "left_only",
  "right_only",
  "same",
  "newer_left",
  "newer_right",
  "differ",
  "unreadable",
];

function emptyRollup(): Record<CompareStatus, number> {
  return {
    left_only: 0,
    right_only: 0,
    same: 0,
    newer_left: 0,
    newer_right: 0,
    differ: 0,
    unreadable: 0,
  };
}

export function buildCompareTree(entries: CompareEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", rel: "", children: [], rollup: emptyRollup() };
  const folders = new Map<string, TreeNode>([["", root]]);

  const ensureFolder = (rel: string): TreeNode => {
    const existing = folders.get(rel);
    if (existing) return existing;
    const slash = rel.lastIndexOf("/");
    const parentRel = slash >= 0 ? rel.slice(0, slash) : "";
    const name = slash >= 0 ? rel.slice(slash + 1) : rel;
    const parent = ensureFolder(parentRel);
    const node: TreeNode = { name, rel, children: [], rollup: emptyRollup() };
    parent.children?.push(node);
    folders.set(rel, node);
    return node;
  };

  for (const e of entries) {
    const slash = e.rel.lastIndexOf("/");
    const parentRel = slash >= 0 ? e.rel.slice(0, slash) : "";
    const name = slash >= 0 ? e.rel.slice(slash + 1) : e.rel;
    const parent = ensureFolder(parentRel);
    parent.children?.push({
      name,
      rel: e.rel,
      entry: e,
      rollup: { ...emptyRollup(), [e.status]: 1 },
    });
  }

  computeRollup(root);
  sortTree(root);
  return root.children ?? [];
}

function computeRollup(node: TreeNode): Record<CompareStatus, number> {
  if (node.entry) return node.rollup; // leaf — 이미 설정됨
  const r = emptyRollup();
  for (const c of node.children ?? []) {
    const cr = computeRollup(c);
    for (const k of STATUS_KEYS) r[k] += cr[k];
  }
  node.rollup = r;
  return r;
}

function sortTree(node: TreeNode): void {
  if (!node.children) return;
  // folder(자식 있음) 먼저, 그다음 이름순.
  node.children.sort((a, b) => {
    const af = a.children ? 0 : 1;
    const bf = b.children ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) sortTree(c);
}

/** folder 노드의 의미있는 차이 개수(same/unreadable 제외) — 배지 표시 판단용. */
export function diffCount(rollup: Record<CompareStatus, number>): number {
  return (
    rollup.left_only + rollup.right_only + rollup.newer_left + rollup.newer_right + rollup.differ
  );
}
