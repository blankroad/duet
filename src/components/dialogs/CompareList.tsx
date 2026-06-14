import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import clsx from "clsx";
import type { ApplyDirection, CompareEntry, CompareStatus } from "@/types/bindings";
import {
  LABEL,
  TONE,
  ICON,
  sizeText,
  mtimeText,
  allowedDirections,
  DirectionToggle,
} from "./compareView";

export interface CompareListProps {
  /** 필터/검색 적용된 표시 행. */
  rows: CompareEntry[];
  /** 비교 결과 자체가 비었는지(동일 폴더) — 빈 메시지 구분. */
  entriesEmpty: boolean;
  dirOf: (rel: string, status: CompareStatus) => ApplyDirection;
  setDir: (rel: string, dir: ApplyDirection) => void;
  /** 다이얼로그 열릴 때 포커스를 줄 대상(부모가 onOpenAutoFocus 에서 사용). */
  listRef: RefObject<HTMLDivElement>;
}

/**
 * 비교 결과 리스트 — 키보드(↑↓ 행 이동, ←→ 선택행 방향) + roving 선택.
 * 선택 상태는 이 컴포넌트가 소유(부모는 decisions 만 관리). 메타 컬럼 + 방향 토글.
 */
export function CompareList({ rows, entriesEmpty, dirOf, setDir, listRef }: CompareListProps) {
  const [sel, setSel] = useState(0);
  const selectedRowRef = useRef<HTMLTableRowElement>(null);
  const selClamped = useMemo(
    () => Math.min(sel, Math.max(0, rows.length - 1)),
    [sel, rows.length],
  );
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selClamped, rows.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(Math.min(selClamped + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(Math.max(selClamped - 1, 0));
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const row = rows[selClamped];
      if (!row) return;
      const dir: ApplyDirection = e.key === "ArrowLeft" ? "to_left" : "to_right";
      if (allowedDirections(row.status).includes(dir)) {
        e.preventDefault();
        setDir(row.rel, dir);
      }
    }
  };

  return (
    <div
      ref={listRef}
      className="min-h-0 flex-1 overflow-y-auto rounded border border-border focus:outline-none focus:ring-1 focus:ring-accent"
      tabIndex={0}
      role="listbox"
      aria-label="비교 결과"
      aria-activedescendant={rows.length === 0 ? undefined : `cmp-opt-${selClamped}`}
      onKeyDown={onKeyDown}
    >
      {rows.length === 0 ? (
        <div className="px-2 py-3 text-center text-meta text-fg-muted">
          {entriesEmpty
            ? "차이 없음 — 두 폴더가 동일합니다."
            : "표시할 항목 없음 (필터/검색 조건)."}
        </div>
      ) : (
        <table className="w-full text-meta">
          <tbody>
            {rows.map((e, i) => {
              const RowIcon = ICON[e.status];
              return (
                <tr
                  key={e.rel}
                  id={`cmp-opt-${i}`}
                  ref={i === selClamped ? selectedRowRef : undefined}
                  role="option"
                  aria-selected={i === selClamped}
                  onClick={() => setSel(i)}
                  className={clsx(
                    "cursor-default",
                    i === selClamped ? "bg-accent/15" : "even:bg-subtle/40",
                  )}
                >
                  <td className={clsx("w-24 px-2 py-0.5 font-medium", TONE[e.status])}>
                    <span className="flex items-center gap-1">
                      <RowIcon size={11} />
                      {LABEL[e.status]}
                    </span>
                  </td>
                  <td className="truncate px-2 py-0.5 font-mono" title={e.rel}>
                    {e.kind === "dir" ? `${e.rel}/` : e.rel}
                  </td>
                  <td className="w-28 whitespace-nowrap px-2 py-0.5 text-right text-fg-muted">
                    {sizeText(e)}
                  </td>
                  <td className="w-20 whitespace-nowrap px-2 py-0.5 text-right text-fg-muted">
                    {mtimeText(e)}
                  </td>
                  <td className="w-16 px-2 py-0.5">
                    <DirectionToggle
                      status={e.status}
                      value={dirOf(e.rel, e.status)}
                      onChange={(dir) => setDir(e.rel, dir)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
