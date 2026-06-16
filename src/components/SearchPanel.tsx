import { useEffect, useRef } from "react";
import { Loader, Search, X } from "lucide-react";
import { commands } from "@/types/bindings";
import type { SearchHit } from "@/types/bindings";
import { useSearch } from "@/stores/search";

/**
 * 글로벌 검색 결과 패널. <header> 와 <main>{panes}</main> 사이.
 *
 * - 입력창 autoFocus, 200ms debounce 후 commands.searchGlobal 호출
 * - 결과 클릭 → onPickHit 콜백 (App 이 navigate + 패널 cursor 이동)
 * - ESC = close
 * - 패턴 < 2자: "min 2 chars" 안내 (서버 부하 방지)
 */
export function SearchPanel({
  onPickHit,
}: {
  onPickHit: (hit: SearchHit) => void;
}) {
  const isOpen = useSearch((s) => s.isOpen);
  const root = useSearch((s) => s.root);
  const query = useSearch((s) => s.query);
  const content = useSearch((s) => s.content);
  const results = useSearch((s) => s.results);
  const status = useSearch((s) => s.status);
  const error = useSearch((s) => s.error);
  const setQueryNow = useSearch((s) => s.setQueryNow);
  const setContent = useSearch((s) => s.setContent);
  const setResults = useSearch((s) => s.setResults);
  const setStatus = useSearch((s) => s.setStatus);
  const setError = useSearch((s) => s.setError);
  const close = useSearch((s) => s.close);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // debounce 200ms — query 또는 root 변경 시 IPC.
  useEffect(() => {
    if (!isOpen || !root) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setStatus("idle");
      return;
    }
    setStatus("searching");
    const t = setTimeout(() => {
      void (async () => {
        const r = await commands.searchGlobal(root, trimmed, {
          case_sensitive: false,
          include_hidden: false,
          max_results: 500,
          content,
        });
        if (r.status === "ok") setResults(r.data ?? []);
        else setError(r.error.kind);
      })();
    }, 200);
    return () => clearTimeout(t);
  }, [isOpen, root, query, content, setResults, setStatus, setError]);

  if (!isOpen) return null;

  return (
    <div className="border-b border-border bg-subtle">
      <div className="flex h-8 items-center gap-2 px-3 text-base">
        <Search size={12} className="shrink-0 text-fg-muted" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQueryNow(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "Enter" && results[0]) {
              e.preventDefault();
              onPickHit(results[0]);
            }
          }}
          placeholder={content ? "Search file contents…" : "Search filenames…"}
          className="flex-1 bg-transparent font-mono focus:outline-none"
        />
        {/* 파일명 ↔ 내용(grep) 모드 토글 */}
        <div className="flex shrink-0 overflow-hidden rounded border border-border text-meta">
          <button
            type="button"
            onClick={() => setContent(false)}
            className={
              !content
                ? "bg-accent px-1.5 py-0.5 text-white"
                : "px-1.5 py-0.5 text-fg-muted hover:bg-border"
            }
            title="Search by filename"
          >
            Name
          </button>
          <button
            type="button"
            onClick={() => setContent(true)}
            className={
              content
                ? "bg-accent px-1.5 py-0.5 text-white"
                : "px-1.5 py-0.5 text-fg-muted hover:bg-border"
            }
            title="Search file contents (grep)"
          >
            Text
          </button>
        </div>
        {status === "searching" && (
          <Loader size={12} className="shrink-0 animate-spin text-fg-muted" />
        )}
        <span className="shrink-0 text-meta text-fg-muted">
          {query.trim().length < 2 ? "min 2 chars" : `${results.length} hits`}
        </span>
        <button
          type="button"
          onClick={close}
          className="rounded p-0.5 text-fg-muted hover:bg-border"
          aria-label="Close search"
        >
          <X size={12} />
        </button>
      </div>
      {error && (
        <div className="border-t border-border px-3 py-1 text-meta text-danger">
          {error}
        </div>
      )}
      {results.length > 0 && (
        <div className="max-h-64 overflow-auto border-t border-border">
          {results.map((hit) => (
            <button
              key={`${hit.location.path}/${hit.name}`}
              type="button"
              onClick={() => onPickHit(hit)}
              className="flex w-full items-center gap-2 px-3 py-1 text-left text-base hover:bg-border"
            >
              <span className="font-mono">{hit.name}</span>
              <span className="ml-auto truncate text-meta text-fg-muted">
                {hit.location.path}
              </span>
            </button>
          ))}
          {results.length >= 500 && (
            <div className="px-3 py-1 text-meta text-fg-muted">
              showing 500 — refine query for more
            </div>
          )}
        </div>
      )}
    </div>
  );
}
