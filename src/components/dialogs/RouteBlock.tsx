import { useTranslation } from "react-i18next";
import { ArrowDown, Check, Monitor, Server } from "lucide-react";
import { useHostLabel } from "@/lib/hostLabel";
import { shortenPath } from "@/lib/paths";
import type { Location } from "@/types/bindings";

/**
 * "원본 → 받는 위치" 블록 — 듀얼 패널 앱의 복사/이동에서 제일 먼저 확인할 것은
 * 어디서 어디로인지다. 호스트(로컬/원격)와 경로를 한 줄씩, 사이에 화살표.
 *
 * 경로는 가운데를 접어(shortenPath) 말단을 남기고 전체는 tooltip — CSS truncate 는
 * 뒤를 잘라 정작 폴더명이 사라진다.
 */
export function RouteBlock({
  src,
  dst,
  hint,
}: {
  /** 원본 위치. 모르면(진행률의 일부 작업 등) null — 받는 위치만 표시. */
  src: Location | null;
  dst: Location;
  /** 전송 경로 설명 한 줄 (예: "서버 안에서 직접 복사 — 이 PC 를 거치지 않음"). */
  hint?: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col rounded-panel border border-border bg-subtle px-2.5 py-1.5">
        {src && (
          <>
            <RouteRow label={t("dialog.route.src")} location={src} />
            <div className="flex h-3.5 items-center gap-2">
              <span className="w-14 shrink-0" />
              <ArrowDown size={12} className="shrink-0 text-fg-muted" />
            </div>
          </>
        )}
        <RouteRow label={t("dialog.progress.dest")} location={dst} />
      </div>
      {hint && (
        <div className="flex items-center gap-1.5 text-meta text-fg-muted">
          <Check size={12} className="shrink-0 text-success" />
          <span>{hint}</span>
        </div>
      )}
    </div>
  );
}

function RouteRow({ label, location }: { label: string; location: Location }) {
  const host = useHostLabel(location.source);
  const isLocal = location.source.kind === "local";
  return (
    <div className="flex h-[22px] items-center gap-2">
      <span className="w-14 shrink-0 text-meta text-fg-muted">{label}</span>
      {isLocal ? (
        <Monitor size={14} className="shrink-0 text-fg-muted" />
      ) : (
        <Server size={14} className="shrink-0 text-fg-muted" />
      )}
      <span className="shrink-0 text-base text-fg">{host}</span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-meta text-fg-muted"
        title={location.path}
      >
        {shortenPath(location.path)}
      </span>
    </div>
  );
}
