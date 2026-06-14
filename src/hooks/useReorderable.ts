import { useCallback, useRef, useState } from "react";
import { exceedsThreshold } from "@/lib/marquee";

/**
 * 사이드바 리스트의 포인터 기반 드래그 재정렬 — HTML5 DnD 회피(useEntryDrag 와 동일
 * 이유: Tauri OS-drop 충돌 방지). 임계값 초과 시 드래그 시작, 포인터 위치의 항목
 * 기준으로 삽입 위치를 계산, mouseup 에 새 순서를 onCommit. 임계값 미만이면 click/
 * double-click 이 그대로 동작(활성화 유지)하고, 드래그 직후의 click 은 1회 억제.
 *
 * 항목 엘리먼트는 `data-reorder-key` + `data-reorder-group` 를 가져야 한다.
 * `group` 으로 스코프를 제한해 다른 섹션/그룹으로 끌고 가지 못하게 한다.
 */
export function useReorderable(opts: {
  group: string;
  keys: string[];
  onCommit: (next: string[]) => void;
}) {
  const { group, keys, onCommit } = opts;
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [insertBeforeKey, setInsertBeforeKey] = useState<string | null>(null);

  const keysRef = useRef(keys);
  keysRef.current = keys;
  const insertRef = useRef<string | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const onItemMouseDown = useCallback(
    (e: React.MouseEvent, key: string) => {
      if (e.button !== 0) return;
      const sx = e.clientX;
      const sy = e.clientY;
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
          return;
        }
        const targetKey = el.dataset.reorderKey!;
        const r = el.getBoundingClientRect();
        const after = ev.clientY > r.top + r.height / 2;
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
        if (!started) return; // 단순 클릭 — 항목의 onClick/onDoubleClick 이 처리
        // 드래그 직후의 합성 click 1회 억제
        const suppress = (c: MouseEvent) => {
          c.stopPropagation();
          c.preventDefault();
        };
        window.addEventListener("click", suppress, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", suppress, true), 0);

        const ks = keysRef.current;
        const before = insertRef.current;
        const without = ks.filter((k) => k !== key);
        const idx = before == null ? without.length : without.indexOf(before);
        const next =
          idx < 0
            ? ks
            : [...without.slice(0, idx), key, ...without.slice(idx)];
        setDragKey(null);
        setInsertBeforeKey(null);
        insertRef.current = null;
        if (next.length === ks.length && next.some((k, i) => k !== ks[i])) {
          onCommitRef.current(next);
        }
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp, true);
    },
    [group],
  );

  return { dragKey, insertBeforeKey, onItemMouseDown };
}
