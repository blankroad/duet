import {
  Layers,
  X,
  Copy,
  FolderInput,
  Trash2,
  Plus,
  ArrowRight,
  Circle,
  CircleDot,
} from "lucide-react";
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
 * Shelf 사이드바 섹션 — 항목을 **영역(섹션)으로 나눠** 담고 섹션 단위로 활성 패널에
 * 복사/이동. 새 항목은 타깃 섹션(◉)으로. 비었으면(기본 섹션 1개+무항목) 렌더 안 함.
 */
export function ShelfSection() {
  const { t } = useTranslation();
  const sections = useShelf((s) => s.sections);
  const targetId = useShelf((s) => s.targetId);
  const open = useUIDialogs((s) => s.open);
  const showToast = useToast((s) => s.show);

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const hasContent = total > 0 || sections.length > 1;
  if (!hasContent) return null;

  const st = () => useShelf.getState();

  return (
    <div className="border-b border-border px-2 py-1">
      <div className="flex items-center gap-1 text-meta text-fg-muted">
        <Layers size={12} />
        <span className="truncate">{t("shelf.title")}</span>
        <span className="ml-auto opacity-50">{total}</span>
        <button
          type="button"
          onClick={() =>
            st().newSection(t("shelf.sectionN", { n: sections.length + 1 }))
          }
          className="rounded p-0.5 hover:bg-border hover:text-fg"
          aria-label={t("shelf.newSection")}
          title={t("shelf.newSection")}
        >
          <Plus size={12} />
        </button>
      </div>

      {sections.map((sec) => (
        <div key={sec.id} className="mt-1.5">
          {/* 섹션 헤더 */}
          <div className="group/sec flex items-center gap-1">
            <button
              type="button"
              onClick={() => st().setTarget(sec.id)}
              className="shrink-0 text-fg-muted hover:text-accent"
              title={t("shelf.setTarget")}
              aria-label={t("shelf.setTarget")}
            >
              {sec.id === targetId ? (
                <CircleDot size={12} className="text-accent" />
              ) : (
                <Circle size={12} />
              )}
            </button>
            <input
              value={sec.name}
              onChange={(e) => st().renameSection(sec.id, e.target.value)}
              className="min-w-0 flex-1 truncate bg-transparent text-meta text-fg-muted focus:text-fg focus:outline-none"
              aria-label={t("shelf.sectionName")}
            />
            <span className="shrink-0 text-meta opacity-50">{sec.items.length}</span>
            <button
              type="button"
              disabled={sec.items.length === 0}
              onClick={() => void applyShelfTo("copy", open, showToast, sec.id)}
              className="shrink-0 rounded p-0.5 hover:bg-border disabled:opacity-30"
              title={t("shelf.copyHere")}
              aria-label={t("shelf.copyHere")}
            >
              <Copy size={11} />
            </button>
            <button
              type="button"
              disabled={sec.items.length === 0}
              onClick={() => void applyShelfTo("move", open, showToast, sec.id)}
              className="shrink-0 rounded p-0.5 hover:bg-border disabled:opacity-30"
              title={t("shelf.moveHere")}
              aria-label={t("shelf.moveHere")}
            >
              <FolderInput size={11} />
            </button>
            {sec.items.length > 0 && (
              <button
                type="button"
                onClick={() => st().clearSection(sec.id)}
                className="shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-danger group-hover/sec:opacity-100"
                title={t("shelf.clear")}
                aria-label={t("shelf.clear")}
              >
                <Trash2 size={11} />
              </button>
            )}
            {sections.length > 1 && (
              <button
                type="button"
                onClick={() => st().deleteSection(sec.id)}
                className="shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-danger group-hover/sec:opacity-100"
                title={t("shelf.deleteSection")}
                aria-label={t("shelf.deleteSection")}
              >
                <X size={11} />
              </button>
            )}
          </div>

          {/* 항목 */}
          <ul className="mt-0.5 space-y-0.5 pl-4">
            {sec.items.map((it) => (
              <li
                key={shelfKey(it)}
                className="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-border/50"
              >
                <span
                  className="min-w-0 flex-1 truncate font-mono"
                  title={it.name}
                >
                  {it.name}
                </span>
                <span className="shrink-0 text-meta opacity-50" title="source">
                  {it.location.source.kind === "local"
                    ? t("sidebar.local")
                    : sourceLabel(it)}
                </span>
                {sec.id !== targetId && (
                  <button
                    type="button"
                    onClick={() => st().moveItem(shelfKey(it), targetId)}
                    className="shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-accent focus:opacity-100 group-hover:opacity-100"
                    title={t("shelf.moveToTarget")}
                    aria-label={t("shelf.moveToTarget")}
                  >
                    <ArrowRight size={11} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => st().remove(shelfKey(it))}
                  className="shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-danger focus:opacity-100 group-hover:opacity-100"
                  aria-label={t("shelf.remove")}
                  title={t("shelf.remove")}
                >
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
