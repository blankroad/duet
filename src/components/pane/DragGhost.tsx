import { Files, FolderInput } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDragState } from "@/stores/dragState";

/**
 * 포인터 드래그 중 커서를 따라다니는 고스트. `pointer-events:none` 이라
 * elementFromPoint 드롭 대상 판정을 가리지 않음.
 *
 * 놓으면 복사인지 이동인지(시작할 때 수식키로 확정)를 배지로 보여 준다 — 예전엔 놓기
 * 전에는 알 수 없었다. Esc 로 취소할 수 있다는 것도 툴팁 대신 배지 옆 짧은 힌트로.
 */
export function DragGhost() {
  const { t } = useTranslation();
  const active = useDragState((s) => s.active);
  const x = useDragState((s) => s.x);
  const y = useDragState((s) => s.y);
  const label = useDragState((s) => s.label);
  const mode = useDragState((s) => s.mode);
  if (!active) return null;
  const Icon = mode === "move" ? FolderInput : Files;
  return (
    <div
      className="pointer-events-none fixed z-50"
      style={{ left: x + 10, top: y + 10 }}
    >
      <div className="flex items-center gap-1.5 rounded-panel border border-border bg-base px-2 py-1 text-meta shadow-panel">
        <Icon size={13} className="text-accent" />
        <span className="font-mono">{label}</span>
        <span className="rounded bg-subtle px-1 text-fg-muted">
          {t(mode === "move" ? "dnd.move" : "dnd.copy")}
        </span>
        <span className="text-fg-muted">{t("dnd.escCancel")}</span>
      </div>
    </div>
  );
}
