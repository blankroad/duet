import { useEffect, useRef, useState } from "react";
import { commands } from "@/types/bindings";
import type { Entry, Location } from "@/types/bindings";
import { EntryIcon } from "@/lib/fileIcon";
import { formatSize } from "@/lib/format";
import { kindLabel, formatPerms, formatFullDate } from "@/lib/fileInfo";

/**
 * 인스펙터 — 커서 항목(파일/폴더)의 속성 표시. 대부분 Entry 에 이미 있는 값이라
 * fetch 없이 즉시. 폴더는 항목 수(직계)만 가벼운 list 1회(디바운스)로 보강.
 */
export function PreviewInspector({ entry, location }: { entry: Entry; location: Location }) {
  const folderCount = useFolderCount(entry.kind === "dir" ? location : null);
  const sizeRow =
    entry.kind === "dir"
      ? folderCount == null
        ? "Counting…"
        : `${folderCount} item${folderCount === 1 ? "" : "s"}`
      : entry.size != null
        ? formatSize(entry.size)
        : "—";

  return (
    <div className="border-b border-border p-3">
      <div className="mb-2 flex items-center gap-2">
        <EntryIcon entry={entry} size={28} />
        <span className="min-w-0 break-all font-mono text-base">{entry.name}</span>
      </div>
      <dl className="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-meta">
        <Row k="Kind" v={kindLabel(entry)} />
        <Row k={entry.kind === "dir" ? "Items" : "Size"} v={sizeRow} />
        <Row k="Modified" v={formatFullDate(entry.modified_ms)} />
        <Row k="Perms" v={formatPerms(entry.permissions)} mono />
        <Row k="Where" v={String(location.path)} mono titled />
      </dl>
    </div>
  );
}

function Row({ k, v, mono, titled }: { k: string; v: string; mono?: boolean; titled?: boolean }) {
  return (
    <>
      <dt className="text-fg-muted">{k}</dt>
      <dd className={`min-w-0 truncate ${mono ? "font-mono" : ""}`} title={titled ? v : undefined}>
        {v}
      </dd>
    </>
  );
}

/** 폴더 직계 항목 수 (디바운스). location null(파일)이면 비활성. */
function useFolderCount(location: Location | null): number | null {
  const key = location
    ? `${location.source.kind === "ssh" ? location.source.connection_id : "local"}|${location.path}`
    : "";
  const locRef = useRef(location);
  locRef.current = location;
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    setCount(null);
    const loc = locRef.current;
    if (!loc) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await commands.listDirectory(loc);
      if (cancelled) return;
      if (r.status === "ok") setCount(r.data.length);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key]);

  return count;
}
