import clsx from "clsx";
import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

export type DialogBandTone = "warning" | "danger";

const TONE: Record<DialogBandTone, { box: string; icon: string }> = {
  warning: { box: "border-warning/30 bg-warning/10", icon: "text-warning" },
  danger: { box: "border-danger/30 bg-danger/10", icon: "text-danger" },
};

/**
 * 경고/오류 밴드 — 본문 안에서 눈에 띄어야 하는 한 줄(또는 몇 줄).
 * 첫 줄은 아이콘과 나란히, `children` 으로 아래에 컨트롤을 덧붙일 수 있다.
 */
export function DialogBand({
  tone,
  message,
  children,
}: {
  tone: DialogBandTone;
  message: ReactNode;
  children?: ReactNode | undefined;
}) {
  const c = TONE[tone];
  return (
    <div
      className={clsx(
        "flex flex-col gap-2 rounded-panel border px-3 py-2.5",
        c.box,
      )}
    >
      <div className="flex items-center gap-2 text-base text-fg">
        <AlertTriangle size={14} className={clsx("shrink-0", c.icon)} />
        <span className="min-w-0">{message}</span>
      </div>
      {children}
    </div>
  );
}
