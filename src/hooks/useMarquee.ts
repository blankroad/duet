import { useEffect, useRef, useState, type RefObject } from "react";
import { usePanes, activeTab, type PaneId } from "@/stores/panes";
import type { Entry } from "@/types/bindings";
import { exceedsThreshold, type Rect } from "@/lib/marquee";
import { setAnchorAt } from "@/lib/selectionAnchor";

const EDGE = 28; // 가장자리 자동 스크롤 감지 폭(px)
const MAX_SPEED = 22; // 프레임당 최대 스크롤(px)

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
/** 가장자리에서 얼마나 벗어났는지(over)에 비례한 스크롤 속도 — 가까울수록 느림. */
function edgeSpeed(over: number): number {
  return Math.min(MAX_SPEED, Math.max(2, Math.ceil(over / 2)));
}
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(b);
  return a.every((x) => s.has(x));
}

/**
 * 마키(러버밴드) 드래그 선택 훅. `data-drag-handle`(아이콘+이름) 위 mousedown 은
 * 무시 — 그건 항목 드래그(이동) 핸들. 그 외(컬럼 여백·셀 간격·빈 영역)에서 시작.
 *
 * 많은 파일 대응:
 * - **연속 자동 스크롤**: 포인터를 가장자리에 두면(움직이지 않아도) RAF 로 계속
 *   스크롤하며 가려진 행까지 선택 확장. 거리 비례 가속.
 * - **Ctrl/Cmd 드래그**: 기존 선택에 더하기(additive).
 *
 * 좌표는 스크롤 콘텐츠 좌표계. 반환 `marquee` 를 콘텐츠 컨테이너에 오버레이로 렌더.
 */
export function useMarquee(opts: {
  id: PaneId;
  scrollRef: RefObject<HTMLDivElement | null>;
  entries: Entry[];
  hitTest: (rect: Rect) => number[];
}) {
  const { id, scrollRef, entries, hitTest } = opts;
  const [marquee, setMarquee] = useState<Rect | null>(null);

  const startRef = useRef<{ x: number; y: number } | null>(null); // 콘텐츠 좌표 시작점
  const lastClientRef = useRef<{ x: number; y: number } | null>(null); // 최신 포인터(client)
  const draggingRef = useRef(false);
  const dirtyRef = useRef(false);
  const baseRef = useRef<string[]>([]); // additive 기준 선택
  const lastSelRef = useRef<string[]>([]); // 마지막 적용 선택(중복 setState 방지)
  const lastHitRef = useRef<{ idx: number[]; down: boolean }>({
    idx: [],
    down: true,
  }); // 마지막 히트 인덱스 + 끄는 방향(아래/위) — 끝날 때 커서·기준점
  const beginRef = useRef<(() => void) | null>(null);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const hitRef = useRef(hitTest);
  hitRef.current = hitTest;

  useEffect(() => {
    let raf: number | null = null;

    // 최신 포인터 + 현재 스크롤로 마키 rect 재계산 → 겹치는 항목 선택.
    // client 를 뷰포트 안으로 clamp 해, 가장자리 밖이어도 스크롤이 진행되면
    // rect 끝이 새로 드러난 행까지 따라간다.
    const updateSelection = () => {
      const el = scrollRef.current;
      const start = startRef.current;
      const last = lastClientRef.current;
      if (!el || !start || !last) return;
      const r = el.getBoundingClientRect();
      const x = clamp(last.x - r.left, 0, el.clientWidth) + el.scrollLeft;
      const y = clamp(last.y - r.top, 0, el.clientHeight) + el.scrollTop;
      const rect: Rect = { x1: start.x, y1: start.y, x2: x, y2: y };
      setMarquee(rect);
      if (!exceedsThreshold(x - start.x, y - start.y)) return;
      const hitIdx = hitRef.current(rect);
      lastHitRef.current = { idx: hitIdx, down: y >= start.y };
      const hit = hitIdx
        .map((i) => entriesRef.current[i]?.name)
        .filter((n): n is string => n !== undefined);
      const names = baseRef.current.length
        ? Array.from(new Set([...baseRef.current, ...hit]))
        : hit;
      if (!sameSet(names, lastSelRef.current)) {
        lastSelRef.current = names;
        usePanes.getState().setSelected(id, names);
      }
    };

    const tick = () => {
      if (!draggingRef.current) {
        raf = null;
        return;
      }
      const el = scrollRef.current;
      const last = lastClientRef.current;
      if (el && last) {
        const r = el.getBoundingClientRect();
        let dy = 0;
        let dx = 0;
        if (last.y < r.top + EDGE) dy = -edgeSpeed(r.top + EDGE - last.y);
        else if (last.y > r.bottom - EDGE)
          dy = edgeSpeed(last.y - (r.bottom - EDGE));
        if (last.x < r.left + EDGE) dx = -edgeSpeed(r.left + EDGE - last.x);
        else if (last.x > r.right - EDGE)
          dx = edgeSpeed(last.x - (r.right - EDGE));
        if (dy !== 0) {
          const n = clamp(
            el.scrollTop + dy,
            0,
            el.scrollHeight - el.clientHeight,
          );
          if (n !== el.scrollTop) {
            el.scrollTop = n;
            dirtyRef.current = true;
          }
        }
        if (dx !== 0) {
          const n = clamp(
            el.scrollLeft + dx,
            0,
            el.scrollWidth - el.clientWidth,
          );
          if (n !== el.scrollLeft) {
            el.scrollLeft = n;
            dirtyRef.current = true;
          }
        }
        if (dirtyRef.current) {
          dirtyRef.current = false;
          updateSelection();
        }
      }
      raf = requestAnimationFrame(tick);
    };

    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      lastClientRef.current = { x: e.clientX, y: e.clientY };
      dirtyRef.current = true;
    };
    // 마키 중 휠 스크롤도 선택에 반영(예전엔 포인터를 움직여야 갱신됐다).
    const onScroll = () => {
      if (draggingRef.current) dirtyRef.current = true;
    };
    const onUp = () => {
      // 마키로 고른 게 있으면 커서는 끝낸 쪽 항목, 범위 기준점은 시작 쪽 항목으로 —
      // 이어서 Shift+↓·Enter 가 마키 결과에서 이어지게.
      const { idx, down } = lastHitRef.current;
      if (draggingRef.current && idx.length > 0) {
        const lo = Math.min(...idx);
        const hi = Math.max(...idx);
        usePanes.getState().setCursor(id, down ? hi : lo);
        setAnchorAt(id, down ? lo : hi);
      }
      lastHitRef.current = { idx: [], down: true };
      draggingRef.current = false;
      startRef.current = null;
      lastClientRef.current = null;
      baseRef.current = [];
      lastSelRef.current = [];
      setMarquee(null);
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    };

    beginRef.current = () => {
      if (raf === null) raf = requestAnimationFrame(tick);
    };
    const scrollEl = scrollRef.current;
    scrollEl?.addEventListener("scroll", onScroll);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      scrollEl?.removeEventListener("scroll", onScroll);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [id, scrollRef]);

  const onContainerMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-drag-handle]")) return; // 아이콘/이름 = 항목 드래그(이동)
    const el = scrollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 스크롤바 위 mousedown 은 스크롤 조작 — 마키로 받으면 선택이 지워지고 끄는 동안
    // 지나간 행이 줄줄이 선택됐다. (clientWidth/Height 는 스크롤바를 뺀 내용 영역.)
    if (
      e.clientX - r.left >= el.clientWidth ||
      e.clientY - r.top >= el.clientHeight
    )
      return;
    const x = e.clientX - r.left + el.scrollLeft;
    const y = e.clientY - r.top + el.scrollTop;
    const additive = e.ctrlKey || e.metaKey;
    startRef.current = { x, y };
    lastClientRef.current = { x: e.clientX, y: e.clientY };
    draggingRef.current = true;
    dirtyRef.current = false;
    baseRef.current = additive
      ? Array.from(activeTab(usePanes.getState(), id).selected)
      : [];
    lastSelRef.current = baseRef.current;
    if (!additive) usePanes.getState().setSelected(id, []); // 빈 곳 클릭 = 선택 해제
    setMarquee({ x1: x, y1: y, x2: x, y2: y });
    beginRef.current?.();
  };

  return { marquee, onContainerMouseDown };
}
