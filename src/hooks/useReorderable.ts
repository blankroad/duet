import { useCallback, useRef, useState } from "react";
import { exceedsThreshold } from "@/lib/marquee";

/**
 * 포인터 기반 드래그 재정렬 — HTML5 DnD 회피(useEntryDrag 와 동일 이유: Tauri OS-drop
 * 충돌 방지). 임계값 초과 시 드래그 시작, 포인터 위치 항목 기준으로 삽입 위치 계산,
 * mouseup 에 새 순서를 onCommit. 임계값 미만이면 click/double-click 이 그대로
 * 동작하고, 드래그 직후 click 은 1회 억제.
 *
 * 항목 엘리먼트는 `data-reorder-key` + `data-reorder-group` 필수. `group` 으로 스코프 제한.
 *
 * 선택적 머지(Dock 폴더): `onMerge` 를 주면 항목 **중앙 40% 밴드(0.30~0.70)** 에
 * 300ms 머무를 때 "드롭-온토"로 판정해 reorder 대신 onMerge 호출. `mergeTargetKey`
 * 로 시각 강조(ring). `axis:"x"` 는 가로 스트립(상단 툴바)용.
 */
export function useReorderable(opts: {
  group: string;
  keys: string[];
  onCommit: (next: string[]) => void;
  axis?: "x" | "y";
  onMerge?: (dragKey: string, targetKey: string) => void;
  canMerge?: (targetKey: string) => boolean;
}) {
  const { group, keys, onCommit, axis = "y", onMerge, canMerge } = opts;
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [insertBeforeKey, setInsertBeforeKey] = useState<string | null>(null);
  const [mergeTargetKey, setMergeTargetKey] = useState<string | null>(null);

  const keysRef = useRef(keys);
  keysRef.current = keys;
  const insertRef = useRef<string | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onMergeRef = useRef(onMerge);
  onMergeRef.current = onMerge;
  const canMergeRef = useRef(canMerge);
  canMergeRef.current = canMerge;

  const mergeTargetRef = useRef<string | null>(null);
  const mergeArmedRef = useRef(false);
  const dwellTimer = useRef<number | undefined>(undefined);

  const clearMerge = useCallback(() => {
    if (dwellTimer.current !== undefined) {
      clearTimeout(dwellTimer.current);
      dwellTimer.current = undefined;
    }
    if (mergeTargetRef.current !== null) {
      mergeTargetRef.current = null;
      mergeArmedRef.current = false;
      setMergeTargetKey(null);
    }
  }, []);

  const onItemMouseDown = useCallback(
    (e: React.MouseEvent, key: string) => {
      if (e.button !== 0) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const horizontal = axis === "x";
      let started = false;

      const onMove = (ev: MouseEvent) => {
        if (!started) {
          if (!exceedsThreshold(ev.clientX - sx, ev.clientY - sy)) return;
          started = true;
          setDragKey(key);
          document.body.style.cursor = "grabbing";
        }
        const el = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest<HTMLElement>("[data-reorder-key]");
        if (!el || el.dataset.reorderGroup !== group) {
          insertRef.current = null;
          setInsertBeforeKey(null);
          clearMerge();
          return;
        }
        const targetKey = el.dataset.reorderKey!;
        const r = el.getBoundingClientRect();
        const size = horizontal ? r.width : r.height;
        const pos = (horizontal ? ev.clientX - r.left : ev.clientY - r.top) / size;

        const canMergeHere =
          !!onMergeRef.current && targetKey !== key && (canMergeRef.current?.(targetKey) ?? true);
        if (canMergeHere && pos >= 0.3 && pos <= 0.7) {
          insertRef.current = null;
          setInsertBeforeKey(null);
          if (mergeTargetRef.current !== targetKey) {
            clearMerge();
            mergeTargetRef.current = targetKey;
            setMergeTargetKey(targetKey);
            dwellTimer.current = window.setTimeout(() => {
              mergeArmedRef.current = true;
            }, 300);
          }
          return;
        }
        clearMerge();
        const after = pos > 0.5;
        const ks = keysRef.current;
        const ti = ks.indexOf(targetKey);
        const before = after ? (ks[ti + 1] ?? null) : targetKey;
        insertRef.current = before;
        setInsertBeforeKey(before);
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp, true);
        document.body.style.cursor = "";
        if (!started) {
          clearMerge();
          return; // 단순 클릭 — onClick/onDoubleClick 이 처리
        }
        // 드래그 직후의 합성 click 1회 억제
        const suppress = (c: MouseEvent) => {
          c.stopPropagation();
          c.preventDefault();
        };
        window.addEventListener("click", suppress, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", suppress, true), 0);

        // 머지(드롭-온토)가 armed 면 reorder 대신 onMerge.
        if (mergeTargetRef.current != null && mergeArmedRef.current && onMergeRef.current) {
          const target = mergeTargetRef.current;
          setDragKey(null);
          setInsertBeforeKey(null);
          insertRef.current = null;
          clearMerge();
          onMergeRef.current(key, target);
          return;
        }

        const ks = keysRef.current;
        const before = insertRef.current;
        const without = ks.filter((k) => k !== key);
        const idx = before == null ? without.length : without.indexOf(before);
        const next = idx < 0 ? ks : [...without.slice(0, idx), key, ...without.slice(idx)];
        setDragKey(null);
        setInsertBeforeKey(null);
        insertRef.current = null;
        clearMerge();
        if (next.length === ks.length && next.some((k, i) => k !== ks[i])) {
          onCommitRef.current(next);
        }
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp, true);
    },
    [group, axis, clearMerge],
  );

  return { dragKey, insertBeforeKey, mergeTargetKey, onItemMouseDown };
}
