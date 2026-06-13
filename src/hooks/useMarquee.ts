import { useEffect, useRef, useState, type RefObject } from "react";
import { usePanes, type PaneId } from "@/stores/panes";
import type { Entry } from "@/types/bindings";
import { exceedsThreshold, type Rect } from "@/lib/marquee";

/**
 * 마키(러버밴드) 드래그 선택 훅 — 스크롤 컨테이너의 빈 영역에서 드래그하면
 * 사각형과 겹치는 항목을 선택. 항목(`[data-entry]`) 위 mousedown 은 무시 (DnD/클릭이 담당).
 *
 * 좌표는 스크롤 콘텐츠 좌표계. 반환 `marquee` 를 콘텐츠 컨테이너 안에 오버레이로 렌더.
 */
export function useMarquee(opts: {
  id: PaneId;
  scrollRef: RefObject<HTMLDivElement | null>;
  entries: Entry[];
  hitTest: (rect: Rect) => number[];
}) {
  const { id, scrollRef, entries, hitTest } = opts;
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const hitRef = useRef(hitTest);
  hitRef.current = hitTest;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const start = startRef.current;
      const el = scrollRef.current;
      if (!start || !el) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left + el.scrollLeft;
      const y = e.clientY - r.top + el.scrollTop;
      const rect: Rect = { x1: start.x, y1: start.y, x2: x, y2: y };
      setMarquee(rect);
      if (exceedsThreshold(x - start.x, y - start.y)) {
        const names = hitRef.current(rect)
          .map((i) => entriesRef.current[i]?.name)
          .filter((n): n is string => n !== undefined);
        usePanes.getState().setSelected(id, names);
      }
      // 가장자리 근처면 자동 스크롤
      const margin = 24;
      if (e.clientY < r.top + margin) el.scrollTop -= 12;
      else if (e.clientY > r.bottom - margin) el.scrollTop += 12;
    };
    const onUp = () => {
      startRef.current = null;
      setMarquee(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [id, scrollRef]);

  const onContainerMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-entry]")) return; // 항목 위 — DnD/클릭이 처리
    const el = scrollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left + el.scrollLeft;
    const y = e.clientY - r.top + el.scrollTop;
    startRef.current = { x, y };
    usePanes.getState().setSelected(id, []); // 빈 곳 클릭 = 선택 해제
    setMarquee({ x1: x, y1: y, x2: x, y2: y });
  };

  return { marquee, onContainerMouseDown };
}
