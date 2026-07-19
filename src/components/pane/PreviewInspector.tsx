import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/types/bindings";
import type { Entry, Location } from "@/types/bindings";
import { activeTab, usePanes, type PaneId } from "@/stores/panes";
import { calcDirSizes } from "@/lib/dirSize";
import { EntryIcon } from "@/lib/fileIcon";
import { formatSize } from "@/lib/format";
import { kindLabel, formatPerms, formatFullDate } from "@/lib/fileInfo";

/**
 * 인스펙터 — 커서 항목(파일/폴더)의 속성 표시. 대부분 Entry 에 이미 있는 값이라
 * fetch 없이 즉시. 폴더는 항목 수(직계)만 가벼운 list 1회(디바운스)로 보강.
 *
 * 폴더 재귀 크기는 자동 계산하지 않는다 — 커서/호버가 옮겨갈 때마다 재귀 walk(로컬)
 * 나 `du -sb`(SSH) 가 돌면 큰 트리·원격에서 감당이 안 된다. 크기 컬럼과 같은 탭
 * 캐시(dirSizes)를 읽어 이미 계산된 값이면 즉시 보여주고, 없으면 "계산" 버튼으로
 * 사용자가 명시적으로 실행 (Shift+Space 와 동일 경로).
 */
export function PreviewInspector({
  entry,
  location,
  paneId,
}: {
  entry: Entry;
  location: Location;
  paneId: PaneId;
}) {
  const { t } = useTranslation();
  const isDir = entry.kind === "dir";
  const folderCount = useFolderCount(isDir ? location : null);
  const dirSize = usePanes((s) =>
    isDir ? activeTab(s, paneId).dirSizes[entry.name] : undefined,
  );

  // 계산 중 표시는 "이 항목"에 한정 — 계산 도중 커서가 옮겨가도 새 항목에 번지지 않게.
  const pathKey = String(location.path);
  const [calcKey, setCalcKey] = useState<string | null>(null);
  const calculating = calcKey === pathKey;

  async function onCalcSize() {
    setCalcKey(pathKey);
    try {
      await calcDirSizes(paneId, [entry.name]);
    } finally {
      setCalcKey((k) => (k === pathKey ? null : k));
    }
  }

  const itemsRow =
    folderCount == null
      ? t("preview.counting")
      : t("preview.itemCount", { count: folderCount });

  let sizeRow: ReactNode;
  if (!isDir) sizeRow = entry.size != null ? formatSize(entry.size) : "—";
  else if (dirSize != null) sizeRow = formatSize(dirSize);
  else if (calculating) sizeRow = t("preview.calculating");
  else
    sizeRow = (
      <button
        type="button"
        onClick={onCalcSize}
        className="text-accent hover:underline"
      >
        {t("preview.calcSize")}
      </button>
    );

  return (
    <div className="border-b border-border p-3">
      <div className="mb-2 flex items-center gap-2">
        <EntryIcon
          entry={entry}
          size={28}
          localPath={
            // 인스펙터의 location 은 엔트리 자신의 경로 (목록과 달리 join 불필요).
            location.source.kind === "local" ? String(location.path) : null
          }
        />
        <span className="min-w-0 break-all font-mono text-base">
          {entry.name}
        </span>
      </div>
      <dl className="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-meta">
        <Row k={t("preview.kind")} v={kindLabel(entry)} />
        {isDir && <Row k={t("preview.items")} v={itemsRow} />}
        <Row k={t("preview.size")} v={sizeRow} />
        <Row k={t("preview.modified")} v={formatFullDate(entry.modified_ms)} />
        <Row k={t("preview.perms")} v={formatPerms(entry.permissions)} mono />
        <Row k={t("preview.where")} v={pathKey} mono title={pathKey} />
      </dl>
    </div>
  );
}

function Row({
  k,
  v,
  mono,
  title,
}: {
  k: string;
  v: ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <>
      <dt className="text-fg-muted">{k}</dt>
      <dd
        className={`min-w-0 truncate ${mono ? "font-mono" : ""}`}
        title={title}
      >
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
