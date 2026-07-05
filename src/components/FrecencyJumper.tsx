import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import { Compass } from "lucide-react";
import { useFrecency } from "@/stores/frecency";
import { usePanes, type PaneId } from "@/stores/panes";
import { useConnections } from "@/stores/connections";
import { commands } from "@/types/bindings";
import type { FrecencyEntry, Location } from "@/types/bindings";

/** 항목 소스 라벨 — 로컬은 "local", SSH 는 연결 alias(없으면 host_ip). */
function sourceLabel(loc: Location): string {
  const s = loc.source;
  if (s.kind === "local") return "local";
  const conn = Object.values(useConnections.getState().active).find(
    (c) => c.id === s.connection_id,
  );
  return conn?.alias ?? s.host_ip;
}

/**
 * frecency 점퍼 (Ctrl+J) — 자주·최근 방문한 디렉토리를 부분문자열로 즉시 점프.
 * CommandPalette 와 같은 모달 패턴. Enter = 활성 패널로 이동.
 */
export function FrecencyJumper({
  onOpenLocation,
}: {
  onOpenLocation: (location: Location, pane: PaneId) => void;
}) {
  const { t } = useTranslation();
  const isOpen = useFrecency((s) => s.isOpen);
  const close = useFrecency((s) => s.close);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FrecencyEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setCursor(0);
      const timer = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // 질의 → 백엔드 frecency 조회 (150ms 디바운스). 열려 있을 때만.
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      void commands.frecencyQuery(query, 50).then((r) => {
        if (r.status === "ok") {
          setResults(r.data);
          setCursor(0);
        }
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [isOpen, query]);

  if (!isOpen) return null;

  const jump = (entry: FrecencyEntry) => {
    close();
    onOpenLocation(entry.location, usePanes.getState().activePane);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/4 z-50 w-full max-w-xl -translate-x-1/2 rounded-md border border-border bg-base shadow-lg focus:outline-none">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Compass size={14} className="shrink-0 text-fg-muted" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => Math.min(results.length - 1, c + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => Math.max(0, c - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const entry = results[cursor];
                  if (entry) jump(entry);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                }
              }}
              placeholder={t("jumper.placeholder")}
              className="flex-1 bg-transparent font-mono text-base focus:outline-none"
            />
          </div>
          <div className="max-h-80 overflow-auto py-1">
            {results.length === 0 ? (
              <div className="px-3 py-2 text-meta text-fg-muted">
                {query ? t("jumper.noMatch") : t("jumper.noHistory")}
              </div>
            ) : (
              results.map((entry, i) => (
                <button
                  key={`${sourceLabel(entry.location)}:${entry.location.path}`}
                  type="button"
                  onClick={() => jump(entry)}
                  onMouseEnter={() => setCursor(i)}
                  className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-base ${
                    i === cursor ? "bg-active text-fg" : "hover:bg-border"
                  }`}
                >
                  <span className="flex-1 truncate font-mono">
                    {String(entry.location.path)}
                  </span>
                  <span className="shrink-0 text-meta text-fg-muted">
                    {/* React key 는 raw sourceLabel — 표시만 번역 (로컬). */}
                    {entry.location.source.kind === "local"
                      ? t("sidebar.local")
                      : sourceLabel(entry.location)}
                  </span>
                </button>
              ))
            )}
          </div>
          <Dialog.Description className="sr-only">
            {t("jumper.desc")}
          </Dialog.Description>
          <Dialog.Title className="sr-only">{t("jumper.title")}</Dialog.Title>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
