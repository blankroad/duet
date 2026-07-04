import { Layers, X, Copy, FolderInput, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShelf, shelfKey } from "@/stores/shelf";
import { useConnections } from "@/stores/connections";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import { applyShelfTo } from "@/lib/fileActions";
import type { EntryRef } from "@/types/bindings";

/** 항목 소스 라벨 — 로컬은 "local", SSH 는 연결 alias(없으면 host_ip). */
function sourceLabel(ref: EntryRef): string {
  const s = ref.location.source;
  if (s.kind === "local") return "local";
  const conn = Object.values(useConnections.getState().active).find(
    (c) => c.id === s.connection_id,
  );
  return conn?.alias ?? s.host_ip;
}

/**
 * Drop Stack / Shelf 사이드바 섹션 — 모은 항목 + 활성 패널로 일괄 복사/이동.
 * 비었으면 렌더 안 함(항목이 생기면 자동 노출).
 */
export function ShelfSection() {
  const { t } = useTranslation();
  const items = useShelf((s) => s.items);
  const remove = useShelf((s) => s.remove);
  const clear = useShelf((s) => s.clear);
  const open = useUIDialogs((s) => s.open);
  const showToast = useToast((s) => s.show);

  if (items.length === 0) return null;

  return (
    <div className="border-b border-border px-2 py-1">
      <div className="flex items-center gap-1 text-meta text-fg-muted">
        <Layers size={12} />
        <span className="truncate">{t("shelf.title")}</span>
        <span className="ml-auto opacity-50">{items.length}</span>
      </div>

      <div className="mt-1 flex items-center gap-1">
        <button
          type="button"
          onClick={() => void applyShelfTo("copy", open, showToast)}
          className="flex flex-1 items-center justify-center gap-1 rounded-panel border border-border py-0.5 text-meta hover:bg-border"
          title={t("shelf.copyHere")}
        >
          <Copy size={11} /> {t("shelf.copy")}
        </button>
        <button
          type="button"
          onClick={() => void applyShelfTo("move", open, showToast)}
          className="flex flex-1 items-center justify-center gap-1 rounded-panel border border-border py-0.5 text-meta hover:bg-border"
          title={t("shelf.moveHere")}
        >
          <FolderInput size={11} /> {t("shelf.move")}
        </button>
        <button
          type="button"
          onClick={() => clear()}
          className="rounded-panel p-1 text-fg-muted hover:bg-border hover:text-danger"
          aria-label={t("shelf.clear")}
          title={t("shelf.clear")}
        >
          <Trash2 size={11} />
        </button>
      </div>

      <ul className="mt-1 space-y-0.5">
        {items.map((it) => (
          <li
            key={shelfKey(it)}
            className="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-border/50"
          >
            <span className="min-w-0 flex-1 truncate font-mono" title={it.name}>
              {it.name}
            </span>
            <span className="shrink-0 text-meta opacity-50" title="source">
              {sourceLabel(it)}
            </span>
            <button
              type="button"
              onClick={() => remove(shelfKey(it))}
              className="shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-danger group-hover:opacity-100"
              aria-label={t("shelf.remove")}
              title={t("shelf.remove")}
            >
              <X size={11} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
