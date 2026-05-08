import { ArrowLeft, ArrowRight, ArrowUp, RotateCw } from "lucide-react";
import type { Location } from "@/types/bindings";

interface PathBarProps {
  location: Location;
  onBack?: () => void;
  onForward?: () => void;
  onUp?: () => void;
  onRefresh?: () => void;
  onSegmentClick?: (path: string) => void;
}

/**
 * 패널 상단 경로 표시 + 네비 버튼.
 * DESIGN.md "패널 헤더 (PathBar)" 참조.
 *
 * MVP-0: breadcrumb 표시 + 새로고침. 직접 입력 모드(Ctrl+L)는 추후.
 */
export function PathBar({ location, onBack, onForward, onUp, onRefresh, onSegmentClick }: PathBarProps) {
  const sourceLabel = location.source.kind === "local" ? "Local" : `${location.source.user}@${location.source.host_ip}`;
  const segments = location.path.split("/").filter(Boolean);

  return (
    <div className="flex h-8 items-center gap-1 border-b border-border bg-subtle px-2 text-base">
      <button onClick={onBack} className="rounded p-1 hover:bg-border" disabled={!onBack} aria-label="Back">
        <ArrowLeft size={14} />
      </button>
      <button onClick={onForward} className="rounded p-1 hover:bg-border" disabled={!onForward} aria-label="Forward">
        <ArrowRight size={14} />
      </button>
      <button onClick={onUp} className="rounded p-1 hover:bg-border" disabled={!onUp} aria-label="Up">
        <ArrowUp size={14} />
      </button>
      <span className="ml-2 font-mono truncate text-fg-muted">{sourceLabel}</span>
      <span className="text-fg-muted">:</span>
      <div className="flex items-center gap-0.5 font-mono truncate">
        <button
          onClick={() => onSegmentClick?.("/")}
          className="rounded px-1 hover:bg-border"
        >
          /
        </button>
        {segments.map((seg, i) => {
          const cumulative = "/" + segments.slice(0, i + 1).join("/");
          return (
            <span key={cumulative} className="flex items-center">
              <button
                onClick={() => onSegmentClick?.(cumulative)}
                className="rounded px-1 hover:bg-border"
              >
                {seg}
              </button>
              {i < segments.length - 1 && <span className="text-fg-muted">/</span>}
            </span>
          );
        })}
      </div>
      <button onClick={onRefresh} className="ml-auto rounded p-1 hover:bg-border" aria-label="Refresh">
        <RotateCw size={14} />
      </button>
    </div>
  );
}
