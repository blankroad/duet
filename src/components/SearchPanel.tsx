import { useEffect, useRef, useState } from "react";
import { Loader, Search, X, RefreshCw } from "lucide-react";
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

  // 인덱스 재색인 후 재검색 트리거(파일명 모드).
  const [reindexNonce, setReindexNonce] = useState(0);
  const reindex = () => {
    if (!root) return;
    void commands.indexReindex(root).then(() => setReindexNonce((n) => n + 1));
  };

  const inputRef = useRef<HTMLInputElement>(null);
  // 요청 경합 가드 — 매 검색마다 증가. 응답 도착 시 최신 seq 아니면 버림
  // (느린 첫-빌드 응답이 더 새 쿼리 결과를 덮어쓰는 버그 방지).
  const seqRef = useRef(0);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // debounce 200ms — query 또는 root 변경 시 IPC.
  useEffect(() => {
    if (!isOpen || !root) return;
    // 이 effect 실행의 id. 변경마다 증가하므로 in-flight 이전 검색은 stale 처리됨.
    const seq = ++seqRef.current;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setStatus("idle");
      return;
    }
    setStatus("searching");
    const opts = {
      case_sensitive: false,
      include_hidden: false,
      max_results: 500,
      content,
    };
    const t = setTimeout(() => {
      void (async () => {
        // 파일명 = 인덱스(즉시·오프라인), 내용 = grep/rg(원격 연결 필요).
        const r = content
          ? await commands.searchGlobal(root, trimmed, opts)
          : await commands.indexSearch(root, trimmed, opts);
        if (seq !== seqRef.current) return; // 더 새 검색이 시작됨 → 이 응답은 버림
        if (r.status === "ok") setResults(r.data ?? []);
        else setError(r.error.kind);
      })();
    }, 200);
    return () => clearTimeout(t);
  }, [
    isOpen,
    root,
    query,
    content,
    reindexNonce,
    setResults,
    setStatus,
    setError,
  ]);

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
              // Enter = 이동 + 닫기(확정). 마우스 클릭은 패널 유지(여러 결과 탐색).
              e.preventDefault();
              onPickHit(results[0]);
              close();
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
        {!content && (
          <button
            type="button"
            onClick={reindex}
            className="shrink-0 rounded p-0.5 text-fg-muted hover:bg-border"
            title="Reindex (refresh file-name index)"
            aria-label="Reindex"
          >
            <RefreshCw size={11} />
          </button>
        )}
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
