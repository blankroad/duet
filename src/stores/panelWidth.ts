import { create } from "zustand";

/**
 * 드래그로 조절하는 패널 폭 store 공장 — 사이드바·미리보기가 같은 규칙을 쓴다.
 * localStorage 영속(비민감 UI 설정이라 settings.toml 아님), 범위 밖 값은 clamp.
 */
export interface PanelWidthState {
  width: number;
  setWidth: (px: number) => void;
  reset: () => void;
}

export function createPanelWidth(opts: {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
}) {
  const clamp = (px: number): number =>
    Math.max(opts.min, Math.min(opts.max, Math.round(px)));

  const load = (): number => {
    try {
      const raw = localStorage.getItem(opts.storageKey);
      if (raw !== null) {
        const n = Number(raw);
        if (Number.isFinite(n)) return clamp(n);
      }
    } catch {
      /* 손상/불가 → 기본값 */
    }
    return opts.defaultWidth;
  };

  const useStore = create<PanelWidthState>((set) => {
    const commit = (px: number) => {
      const w = clamp(px);
      set({ width: w });
      try {
        localStorage.setItem(opts.storageKey, String(w));
      } catch {
        /* localStorage 불가 — 메모리만 */
      }
    };
    return {
      width: load(),
      setWidth: commit,
      reset: () => commit(opts.defaultWidth),
    };
  });

  return { useStore, clamp, defaultWidth: opts.defaultWidth };
}

/**
 * 폭 조절 손잡이의 포인터 드래그 — `edge` 는 어느 쪽 가장자리를 잡았는지.
 * "right"(사이드바)는 오른쪽으로 끌면 넓어지고, "left"(미리보기)는 왼쪽으로 끌면 넓어진다.
 */
export function beginWidthDrag(
  e: React.PointerEvent,
  edge: "left" | "right",
  startWidth: number,
  setWidth: (px: number) => void,
): void {
  e.preventDefault();
  const startX = e.clientX;
  const sign = edge === "right" ? 1 : -1;
  const move = (ev: PointerEvent) =>
    setWidth(startWidth + sign * (ev.clientX - startX));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.cursor = "";
  };
  document.body.style.cursor = "col-resize";
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
