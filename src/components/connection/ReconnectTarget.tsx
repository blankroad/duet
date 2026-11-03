import { useTranslation } from "react-i18next";
import { CornerDownLeft } from "lucide-react";
import type { DuetError } from "@/types/bindings";
import type { PaneId } from "@/stores/panes";

/** 배너 "재연결" 로 연 대화상자의 문맥 — 돌아갈 패널과 자동 재연결 실패 이유. */
export interface ReconnectInfo {
  pane: PaneId;
  /** 대화상자 없이 시도한 재연결이 실패한 이유 (시도 안 했으면 null). */
  error: DuetError | null;
}

/**
 * 재연결 대화상자의 "열 패널" 자리 — 패널은 이미 정해져 있으니 고르게 하지 않고,
 * 연결되면 어디로 돌아가는지만 알려 준다.
 */
export function ReconnectTarget({ pane }: { pane: PaneId }) {
  const { t } = useTranslation();
  const paneLabel = t(
    pane === "left"
      ? "dialog.connection.paneLeft"
      : "dialog.connection.paneRight",
  );
  return (
    <div className="flex items-center gap-1.5 text-meta text-fg-muted">
      <CornerDownLeft size={12} className="shrink-0" aria-hidden />
      <span>{t("dialog.connection.reconnectInto", { pane: paneLabel })}</span>
    </div>
  );
}
