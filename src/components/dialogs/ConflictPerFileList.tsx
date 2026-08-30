import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import clsx from "clsx";
import { formatSize, formatTime } from "@/lib/format";
import { iconForEntry } from "@/lib/fileIcon";
import type { Conflict, ConflictPolicy } from "@/types/bindings";
import { Segmented, type SegmentedOption } from "./Segmented";

/** 충돌 정책 선택지 — 안전한 것부터, 파괴적인 교체는 마지막·danger. */
export function policyOptions(t: TFunction): SegmentedOption<ConflictPolicy>[] {
  return [
    { value: "skip", label: t("conflict.skip") },
    { value: "keepboth", label: t("conflict.keepBoth") },
    { value: "replace", label: t("conflict.replace"), danger: true },
  ];
}

/**
 * 파일별 충돌 목록 — 항목마다 교체/건너뛰기/둘 다 유지 + 새↔기존 메타 비교.
 * 어떤 파일이 덮어써지는지 보여줘 Replace(영구, undo 불가)의 실수 범위를 줄인다.
 */
export function ConflictPerFileList({
  conflicts,
  decisions,
  onChange,
  onSetAll,
}: {
  conflicts: Conflict[];
  decisions: Record<string, ConflictPolicy>;
  onChange: (name: string, p: ConflictPolicy) => void;
  onSetAll: (p: ConflictPolicy) => void;
}) {
  const { t } = useTranslation();
  const opts = policyOptions(t);
  return (
    <>
      <div className="flex items-center gap-2 text-meta text-fg-muted">
        <span>{t("conflict.setAll")}</span>
        <Segmented value={null} options={opts} onChange={onSetAll} />
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-panel border border-border">
        {conflicts.map((c) => {
          const { Icon, className } = iconForEntry({
            name: c.name,
            kind: "file",
          });
          return (
            <li key={c.name} className="flex flex-col gap-1 px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <Icon size={14} className={clsx("shrink-0", className)} />
                <span
                  className="min-w-0 flex-1 truncate font-mono text-base"
                  title={c.dst_path}
                >
                  {c.name}
                </span>
                <Segmented
                  value={decisions[c.name] ?? "skip"}
                  options={opts}
                  onChange={(p) => onChange(c.name, p)}
                />
              </div>
              <ConflictMeta c={c} />
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * 새(소스)↔기존(대상) 크기/수정시각 비교 한 줄 — 더 최신인 쪽을 진하게.
 * 메타를 못 읽었으면(None) 그 쪽은 생략.
 */
function ConflictMeta({ c }: { c: Conflict }) {
  const { t } = useTranslation();
  const side = (size: number | null, ms: number | null) =>
    [size != null ? formatSize(size) : null, ms != null ? formatTime(ms) : null]
      .filter(Boolean)
      .join(" · ");
  const src = side(c.src_size, c.src_modified_ms);
  const dst = side(c.dst_size, c.dst_modified_ms);
  if (!src && !dst) return null;
  const srcNewer =
    c.src_modified_ms != null &&
    c.dst_modified_ms != null &&
    c.src_modified_ms > c.dst_modified_ms;
  const dstNewer =
    c.src_modified_ms != null &&
    c.dst_modified_ms != null &&
    c.dst_modified_ms > c.src_modified_ms;
  return (
    <div className="pl-[22px] text-meta tabular-nums text-fg-muted">
      {src && (
        <span className={clsx(srcNewer && "text-fg")}>
          {t("conflict.metaNew")} {src}
        </span>
      )}
      {src && dst && <span className="mx-1.5 opacity-60">↔</span>}
      {dst && (
        <span className={clsx(dstNewer && "text-fg")}>
          {t("conflict.metaExisting")} {dst}
        </span>
      )}
    </div>
  );
}
