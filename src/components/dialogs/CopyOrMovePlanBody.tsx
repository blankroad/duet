import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { formatSize } from "@/lib/format";
import { shortenPath } from "@/lib/paths";
import type { CopyStrategy, EntryRef } from "@/types/bindings";

/**
 * 복사/이동 확인 다이얼로그 본문.
 *
 * "무엇을" 옮기는지가 먼저다 — 개수·크기만으로는 어떤 파일인지 확인할 수 없어
 * 잘못된 대상을 그대로 승인하게 된다. 1개면 파일명을 그대로, 여러 개면 목록으로
 * 보여주고, 개수/크기/전략은 보조 정보로 내린다.
 *
 * 목적지 경로는 파일명과 한 줄에 섞지 않는다 — CSS truncate 는 뒤를 자르므로
 * 이어붙이면 정작 말단이 사라진다. shortenPath 로 가운데를 접고 전체는 tooltip.
 */
export function CopyOrMovePlanBody({
  items,
  totalSize,
  dstPath,
  conflicts,
  strategy,
}: {
  items: EntryRef[];
  totalSize: number;
  dstPath: string;
  conflicts: number;
  strategy: CopyStrategy;
}) {
  const { t } = useTranslation();
  const count = items.length;
  return (
    <div className="space-y-2">
      {count === 1 ? (
        <div
          className="truncate font-mono text-base font-medium text-fg"
          title={items[0]!.name}
        >
          {items[0]!.name}
        </div>
      ) : (
        <ul className="max-h-28 divide-y divide-border overflow-auto rounded border border-border">
          {items.map((it) => (
            <li
              key={it.name}
              className="truncate px-2 py-0.5 font-mono text-meta"
              title={it.name}
            >
              {it.name}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-baseline gap-2 text-meta text-fg-muted">
        <span className="shrink-0">{t("dialog.progress.dest")}</span>
        <span className="min-w-0 flex-1 truncate font-mono" title={dstPath}>
          {shortenPath(dstPath)}
        </span>
      </div>
      <div className="text-meta text-fg-muted">
        {t("dialog.transfer.summary", { count, size: formatSize(totalSize) })}
        {" · "}
        {t("dialog.transfer.strategy", { label: strategyLabel(strategy) })}
      </div>
      {conflicts > 0 && (
        <div className="text-meta text-danger">
          {t("dialog.transfer.conflicts", { count: conflicts })}
        </div>
      )}
    </div>
  );
}

function strategyLabel(s: CopyStrategy): string {
  switch (s.kind) {
    case "local_to_local":
      return i18n.t("dialog.transfer.strategyLocal");
    case "relay":
      return i18n.t("dialog.transfer.strategyRelay");
    case "ssh_same_host":
      return i18n.t("dialog.transfer.strategySameHost");
  }
}
