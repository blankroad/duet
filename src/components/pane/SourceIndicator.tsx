import { Loader, Monitor, Server, Unplug } from "lucide-react";
import clsx from "clsx";
import type { SourceId } from "@/types/bindings";
import { useSourceStatus, type SourceStatus } from "@/lib/hostLabel";

/**
 * 원격 식별 시각 언어 — 탭과 PathBar 가 같은 어휘를 쓴다.
 *
 * - 로컬은 조용히: Monitor 아이콘만 (muted).
 * - 원격은 **Server 아이콘 + 호스트 라벨 텍스트** (accent). 탭이 1개라 탭바가
 *   숨어도 PathBar 칩에서 어느 호스트인지 바로 읽힌다.
 * - 연결 상태는 **모양으로**: 연결됨 = Server, 연결 중 = 도는 Loader,
 *   끊김·복원(미연결)·오류 = Unplug(danger). 색만으로 구분하지 않는다 (사이드바
 *   상태 표식과 같은 원칙).
 *
 * 새 색 토큰은 쓰지 않는다 — DESIGN 의 "UI 크롬 강조색 4개 이하" 규칙.
 */
export function SourceIcon({
  status,
  size,
}: {
  status: SourceStatus;
  size: number;
}) {
  switch (status.state) {
    case "local":
      return (
        <Monitor size={size} className="shrink-0 text-fg-muted" aria-hidden />
      );
    case "connected":
      return (
        <Server size={size} className="shrink-0 text-accent" aria-hidden />
      );
    case "connecting":
      return (
        <Loader
          size={size}
          className="shrink-0 animate-spin text-accent"
          aria-hidden
        />
      );
    default:
      return (
        <Unplug size={size} className="shrink-0 text-danger" aria-hidden />
      );
  }
}

/** 툴팁/접근성 문구 — "prod · deploy@10.0.0.1 · 연결됨". */
export function sourceTooltip(status: SourceStatus): string {
  if (!status.remote) return status.label;
  return [status.label, status.address, status.stateText]
    .filter((x): x is string => !!x)
    .join(" · ");
}

/** 연결이 정상이 아닌가 (끊김·복원·오류) — 강조를 danger 로 바꾼다. */
export function isBroken(status: SourceStatus): boolean {
  return status.state === "disconnected" || status.state === "error";
}

/**
 * PathBar 의 소스 칩 — 패널 헤더의 원격 큐. 경로 편집·아카이브·휴지통 화면에서도
 * 항상 보인다.
 */
export function SourceChip({ source }: { source: SourceId }) {
  const status = useSourceStatus(source);
  const tip = sourceTooltip(status);
  if (!status.remote) {
    return (
      <span
        title={tip}
        aria-label={tip}
        data-testid="source-chip"
        className="ml-2 flex shrink-0 items-center"
      >
        <SourceIcon status={status} size={14} />
      </span>
    );
  }
  const broken = isBroken(status);
  return (
    <span
      title={tip}
      aria-label={tip}
      data-testid="source-chip"
      data-state={status.state}
      className={clsx(
        "ml-2 flex h-6 min-w-0 max-w-[11rem] shrink items-center gap-1 rounded border px-1.5 text-meta font-medium",
        broken
          ? "border-danger/50 bg-danger/10 text-fg"
          : "border-accent/40 bg-accent/10 text-accent",
      )}
    >
      <SourceIcon status={status} size={12} />
      <span className="truncate">{status.label}</span>
    </span>
  );
}
