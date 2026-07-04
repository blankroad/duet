import { Files } from "lucide-react";
import { useDragState } from "@/stores/dragState";

/**
 * 포인터 드래그 중 커서를 따라다니는 고스트. `pointer-events:none` 이라
 * elementFromPoint 드롭 대상 판정을 가리지 않음.
 */
export function DragGhost() {
  const active = useDragState((s) => s.active);
  const x = useDragState((s) => s.x);
  const y = useDragState((s) => s.y);
  const label = useDragState((s) => s.label);
  if (!active) return null;
  return (
    <div
      className="pointer-events-none fixed z-50"
      style={{ left: x + 10, top: y + 10 }}
    >
      <div className="flex items-center gap-1.5 rounded-panel border border-border bg-base px-2 py-1 text-meta shadow-panel">
        <Files size={13} className="text-accent" />
        <span className="font-mono">{label}</span>
      </div>
    </div>
  );
}
