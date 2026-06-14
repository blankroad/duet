import { ArrowLeft, ArrowRight, Equal, AlertTriangle, FileWarning } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CompareEntry, CompareStatus, CopyStrategy } from "@/types/bindings";
import { formatSize, formatTime } from "@/lib/format";

/**
 * CompareDialog 표시용 헬퍼/상수 (순수 — JSX 렌더는 컴포넌트가 담당).
 *
 * 방향은 색이 아니라 **화살표 아이콘(모양)** 으로 인코딩 — 색맹에서도 구분 가능.
 * 색은 기존 theme 토큰만 사용(accent/amber/danger/fg-muted) — 새 색 도입 없음.
 */

/** 차이 상태(기본 표시). same 은 기본 숨김, unreadable 은 경고라 기본 표시. */
export const DIFF_STATUSES: CompareStatus[] = [
  "left_only",
  "right_only",
  "newer_left",
  "newer_right",
  "differ",
];

/** 칩 노출 순서. */
export const ALL_STATUSES: CompareStatus[] = [...DIFF_STATUSES, "same", "unreadable"];

export const LABEL: Record<CompareStatus, string> = {
  left_only: "← only",
  right_only: "only →",
  newer_left: "← newer",
  newer_right: "newer →",
  differ: "differ",
  same: "same",
  unreadable: "unreadable",
};

export const TONE: Record<CompareStatus, string> = {
  left_only: "text-accent",
  right_only: "text-accent",
  newer_left: "text-amber-500",
  newer_right: "text-amber-500",
  differ: "text-danger",
  same: "text-fg-muted",
  unreadable: "text-danger",
};

/** 방향/종류를 모양으로 인코딩(색맹 대비). */
export const ICON: Record<CompareStatus, LucideIcon> = {
  left_only: ArrowLeft,
  right_only: ArrowRight,
  newer_left: ArrowLeft,
  newer_right: ArrowRight,
  differ: AlertTriangle,
  same: Equal,
  unreadable: FileWarning,
};

export interface StrategyBadge {
  label: string;
  tone: string;
  title: string;
}

/** 머지/싱크가 어떤 경로로 실행될지 — 대역폭 사전 고지. */
export function strategyBadge(s: CopyStrategy): StrategyBadge {
  switch (s.kind) {
    case "ssh_same_host":
      return {
        label: "⚡ 같은 호스트 직접",
        tone: "border-accent bg-subtle text-accent",
        title: "머지가 서버 내부에서 직접 실행됩니다 — 본인 PC 대역폭 0",
      };
    case "relay":
      return {
        label: "↔ 본인 PC 경유",
        tone: "border-amber-500/40 bg-amber-500/10 text-amber-600",
        title: "파일이 본인 PC 를 거쳐 복사됩니다 (cross-host)",
      };
    case "local_to_local":
      return {
        label: "로컬",
        tone: "border-border bg-subtle text-fg-muted",
        title: "로컬 ↔ 로컬",
      };
  }
}

/** 크기 셀 — 양쪽이면 다를 때 `a → b`, 같으면 `a`. 한쪽이면 그 크기. */
export function sizeText(e: CompareEntry): string {
  const l = e.left_size;
  const r = e.right_size;
  if (l != null && r != null) {
    return l === r ? formatSize(l) : `${formatSize(l)} → ${formatSize(r)}`;
  }
  return formatSize(l ?? r);
}

/** 수정시각 셀 — 더 최신 쪽(단일이면 그 쪽)의 시각. */
export function mtimeText(e: CompareEntry): string {
  const l = e.left_mtime_ms;
  const r = e.right_mtime_ms;
  const pick = l != null && r != null ? Math.max(l, r) : (l ?? r);
  return formatTime(pick);
}
