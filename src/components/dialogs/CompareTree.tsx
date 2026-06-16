import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown, Folder } from "lucide-react";
import clsx from "clsx";
import type { ApplyDirection, CompareEntry, CompareStatus } from "@/types/bindings";
import { buildCompareTree, type TreeNode } from "@/lib/compareTree";
import {
  LABEL,
  TONE,
  ICON,
  sizeText,
  mtimeText,
  DirectionToggle,
  allowedDirections,
} from "./compareView";

const ROLLUP_STATUSES: CompareStatus[] = [
  "left_only",
  "right_only",
  "newer_left",
  "newer_right",
  "differ",
];

export interface CompareTreeProps {
  /** 필터/검색 적용된 표시 행 — 트리는 이걸로 재구성. */
  rows: CompareEntry[];
  dirOf: (rel: string, status: CompareStatus) => ApplyDirection;
  setDir: (rel: string, dir: ApplyDirection) => void;
  onSelect?: (entry: CompareEntry | null) => void;
}

/**
 * 비교 결과 트리뷰 — 디렉토리 접기/펼치기 + 폴더별 상태 롤업 배지.
 * leaf 행은 list 와 동일(상태/메타/방향토글). 키보드 내비는 list 모드 전용(v1).
 */
export function CompareTree({ rows, dirOf, setDir, onSelect }: CompareTreeProps) {
  const tree = useMemo(() => buildCompareTree(rows), [rows]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (rel: string) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(rel)) n.delete(rel);
      else n.add(rel);
      return n;
    });

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded border border-border text-meta">
      {tree.length === 0 ? (
        <div className="px-2 py-3 text-center text-fg-muted">No items to show</div>
      ) : (
        tree.map((n) => (
          <TreeRow
            key={n.rel}
            node={n}
            depth={0}
            collapsed={collapsed}
            toggle={toggle}
            dirOf={dirOf}
            setDir={setDir}
            onSelect={onSelect}
          />
        ))
      )}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  collapsed,
  toggle,
  dirOf,
  setDir,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (rel: string) => void;
  dirOf: (rel: string, status: CompareStatus) => ApplyDirection;
  setDir: (rel: string, dir: ApplyDirection) => void;
  onSelect: ((entry: CompareEntry | null) => void) | undefined;
}) {
  const pad = { paddingLeft: `${depth * 14 + 4}px` };

  // leaf — 파일/한쪽전용 디렉토리
  if (node.entry) {
    const e = node.entry;
    const Icon = ICON[e.status];
    return (
      <div
        onClick={() => onSelect?.(e)}
        className="flex cursor-default items-center gap-2 px-2 py-0.5 hover:bg-subtle/40"
        title={`${LABEL[e.status]} — ${e.rel}`}
      >
        <span style={pad} className="flex min-w-0 flex-1 items-center gap-1.5">
          <Icon size={11} className={TONE[e.status]} />
          <span className="truncate font-mono">{e.kind === "dir" ? `${node.name}/` : node.name}</span>
        </span>
        <span className="w-24 shrink-0 whitespace-nowrap text-right text-fg-muted">{sizeText(e)}</span>
        <span className="w-14 shrink-0 whitespace-nowrap text-right text-fg-muted">{mtimeText(e)}</span>
        <span className="w-14 shrink-0">
          <DirectionToggle status={e.status} value={dirOf(e.rel, e.status)} onChange={(d) => setDir(e.rel, d)} />
        </span>
      </div>
    );
  }

  // folder — 합성 컨테이너
  const isCollapsed = collapsed.has(node.rel);
  const Chevron = isCollapsed ? ChevronRight : ChevronDown;
  // 폴더 방향 일괄 지정 — 서브트리 모든 leaf 에 전파(허용 안 되는 방향은 skip).
  const setFolderDir = (dir: ApplyDirection) => {
    const walk = (n: TreeNode) => {
      if (n.entry) {
        setDir(n.entry.rel, allowedDirections(n.entry.status).includes(dir) ? dir : "skip");
      } else n.children?.forEach(walk);
    };
    walk(node);
  };
  return (
    <>
      <div className="flex items-center px-2 py-0.5 hover:bg-subtle/40">
        <span
          onClick={() => toggle(node.rel)}
          style={pad}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1"
        >
          <Chevron size={12} className="text-fg-muted" />
          <Folder size={11} className="text-fg-muted" />
          <span className="truncate font-medium">{node.name}/</span>
          <Rollup rollup={node.rollup} />
        </span>
        <FolderDirSet onSet={setFolderDir} />
      </div>
      {!isCollapsed &&
        node.children?.map((c) => (
          <TreeRow
            key={c.rel}
            node={c}
            depth={depth + 1}
            collapsed={collapsed}
            toggle={toggle}
            dirOf={dirOf}
            setDir={setDir}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

/** 폴더 행의 서브트리 일괄 방향 지정 (← · →) — 클릭 시 자손 leaf 전체에 전파. */
function FolderDirSet({ onSet }: { onSet: (dir: ApplyDirection) => void }) {
  const btn = (dir: ApplyDirection, label: string, title: string) => (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation();
        onSet(dir);
      }}
      title={title}
      className="px-1 leading-none text-fg-muted hover:text-fg"
    >
      {label}
    </button>
  );
  return (
    <span className="flex w-14 shrink-0 items-center justify-end font-mono">
      {btn("to_left", "←", "이 폴더 전체: 오른쪽 → 왼쪽")}
      {btn("skip", "·", "이 폴더 전체: 건너뜀")}
      {btn("to_right", "→", "이 폴더 전체: 왼쪽 → 오른쪽")}
    </span>
  );
}

function Rollup({ rollup }: { rollup: Record<CompareStatus, number> }) {
  const parts = ROLLUP_STATUSES.filter((s) => rollup[s] > 0);
  if (parts.length === 0) return null;
  return (
    <span className="ml-1.5 flex items-center gap-1.5">
      {parts.map((s) => {
        const I = ICON[s];
        return (
          <span key={s} className={clsx("flex items-center gap-0.5", TONE[s])}>
            <I size={9} />
            {rollup[s]}
          </span>
        );
      })}
    </span>
  );
}
