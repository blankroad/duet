import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader, Search, X, RefreshCw } from "lucide-react";
import { commands } from "@/types/bindings";
import { formatErr } from "@/lib/error";
import { formatSize, formatTime } from "@/lib/format";
import type { EntryKind } from "@/types/bindings";
import type { SearchHit } from "@/types/bindings";
import { useSearch } from "@/stores/search";
import { useIndexStatus } from "@/stores/indexStatus";

/**
 * 글로벌 검색 결과 패널. <header> 와 <main>{panes}</main> 사이.
 *
 * - 입력창 autoFocus, 200ms debounce 후 commands.searchGlobal 호출
 * - 결과 클릭 → onPickHit 콜백 (App 이 navigate + 패널 cursor 이동)
 * - ESC = close
 * - 패턴 < 2자: "min 2 chars" 안내 (서버 부하 방지)
 */
type MinSize = "any" | "1M" | "10M" | "100M" | "1G";
type Since = "any" | "1d" | "7d" | "30d";

const filterClass =
  "rounded border border-border bg-base px-1 py-0.5 text-meta focus:border-accent focus:outline-none";

const MIN_SIZE_BYTES: Record<MinSize, number | null> = {
  any: null,
  "1M": 1024 ** 2,
  "10M": 10 * 1024 ** 2,
  "100M": 100 * 1024 ** 2,
  "1G": 1024 ** 3,
};

const SINCE_DAYS: Record<Since, number | null> = {
  any: null,
  "1d": 1,
  "7d": 7,
  "30d": 30,
};

function minSizeBytes(v: MinSize): number | null {
  return MIN_SIZE_BYTES[v];
}

function sinceMs(v: Since): number | null {
  const days = SINCE_DAYS[v];
  return days === null ? null : Date.now() - days * 24 * 60 * 60 * 1000;
}

export function SearchPanel({
  onPickHit,
}: {
  onPickHit: (hit: SearchHit) => void;
}) {
  const { t } = useTranslation();
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
  // 전체 드라이브 인덱싱 진행 상태(전역).
  const driveIndexed = useIndexStatus((s) => s.indexed);
  const driveDone = useIndexStatus((s) => s.done);

  // 인덱스 재색인 후 재검색 트리거(파일명 모드).
  const [reindexNonce, setReindexNonce] = useState(0);
  const reindex = () => {
    if (!root) return;
    void commands.indexReindex(root).then(() => setReindexNonce((n) => n + 1));
  };

  const inputRef = useRef<HTMLInputElement>(null);
  // 결과를 좁히는 필터 — 값은 셀렉트의 문자열, IPC 로는 바이트/epoch 로 변환한다.
  const [minSize, setMinSize] = useState<MinSize>("any");
  const [since, setSince] = useState<Since>("any");
  const [onlyKind, setOnlyKind] = useState<EntryKind | null>(null);
  // 요청 경합 가드 — 매 검색마다 증가. 응답 도착 시 최신 seq 아니면 버림
  // (느린 첫-빌드 응답이 더 새 쿼리 결과를 덮어쓰는 버그 방지).
  const seqRef = useRef(0);
  const [indexing, setIndexing] = useState(false);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // 검색 열릴 때(파일명 모드) 인덱스를 미리 빌드/신선화 — 첫 쿼리가 즉시 뜨고
  // 결과가 stale 하지 않도록. TTL 내면 backend 가 즉시 반환.
  useEffect(() => {
    if (!isOpen || !root || content) return;
    let cancelled = false;
    setIndexing(true);
    void commands.indexEnsure(root).finally(() => {
      if (!cancelled) setIndexing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, root, content]);

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
      // "지난주 이후 수정된 100MB 이상" 같은 질의 — 예전엔 이름만으로 500개를
      // 받아 놓고 눈으로 골라야 했다.
      min_size: minSizeBytes(minSize),
      max_size: null,
      modified_after_ms: sinceMs(since),
      modified_before_ms: null,
      only_kind: onlyKind,
    };
    const timer = setTimeout(() => {
      void (async () => {
        // 파일명 = 인덱스(즉시·오프라인), 내용 = grep/rg(원격 연결 필요).
        const r = content
          ? await commands.searchGlobal(root, trimmed, opts)
          : await commands.indexSearch(root, trimmed, opts);
        if (seq !== seqRef.current) return; // 더 새 검색이 시작됨 → 이 응답은 버림
        if (r.status === "ok") setResults(r.data ?? []);
        else setError(formatErr(r.error));
      })();
    }, 200);
    return () => clearTimeout(timer);
  }, [
    isOpen,
    root,
    query,
    content,
    minSize,
    since,
    onlyKind,
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
          placeholder={
            content
              ? t("search.contentPlaceholder")
              : t("search.namePlaceholder")
          }
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
            title={t("search.modeNameTitle")}
          >
            {t("search.modeName")}
          </button>
          <button
            type="button"
            onClick={() => setContent(true)}
            className={
              content
                ? "bg-accent px-1.5 py-0.5 text-white"
                : "px-1.5 py-0.5 text-fg-muted hover:bg-border"
            }
            title={t("search.modeTextTitle")}
          >
            {t("search.modeText")}
          </button>
        </div>
        {!content && (
          <button
            type="button"
            onClick={reindex}
            className="shrink-0 rounded p-0.5 text-fg-muted hover:bg-border"
            title={t("search.reindexTitle")}
            aria-label={t("search.reindex")}
          >
            <RefreshCw size={11} />
          </button>
        )}
        {status === "searching" && (
          <Loader size={12} className="shrink-0 animate-spin text-fg-muted" />
        )}
        <span className="shrink-0 text-meta text-fg-muted">
          {!content && !driveDone
            ? t("search.indexingDrive", { n: driveIndexed.toLocaleString() })
            : indexing
              ? t("search.indexing")
              : query.trim().length < 2
                ? t("search.minChars")
                : t("search.hits", { count: results.length })}
        </span>
        <button
          type="button"
          onClick={close}
          className="rounded p-0.5 text-fg-muted hover:bg-border"
          aria-label={t("search.close")}
        >
          <X size={12} />
        </button>
      </div>
      {/* 필터 바 — 이름만으로 좁히기 어려운 질의를 위해. */}
      <div className="flex h-7 items-center gap-2 border-t border-border px-3 text-meta text-fg-muted">
        <span>{t("search.filters")}</span>
        <select
          className={filterClass}
          value={onlyKind ?? "any"}
          onChange={(e) =>
            setOnlyKind(
              e.target.value === "any" ? null : (e.target.value as EntryKind),
            )
          }
        >
          <option value="any">{t("search.kindAny")}</option>
          <option value="file">{t("search.kindFile")}</option>
          <option value="dir">{t("search.kindDir")}</option>
        </select>
        <select
          className={filterClass}
          value={minSize}
          onChange={(e) => setMinSize(e.target.value as MinSize)}
        >
          <option value="any">{t("search.sizeAny")}</option>
          <option value="1M">≥ 1 MB</option>
          <option value="10M">≥ 10 MB</option>
          <option value="100M">≥ 100 MB</option>
          <option value="1G">≥ 1 GB</option>
        </select>
        <select
          className={filterClass}
          value={since}
          onChange={(e) => setSince(e.target.value as Since)}
        >
          <option value="any">{t("search.timeAny")}</option>
          <option value="1d">{t("search.time1d")}</option>
          <option value="7d">{t("search.time7d")}</option>
          <option value="30d">{t("search.time30d")}</option>
        </select>
        {(onlyKind !== null || minSize !== "any" || since !== "any") && (
          <button
            type="button"
            className="rounded px-1.5 text-accent hover:underline"
            onClick={() => {
              setOnlyKind(null);
              setMinSize("any");
              setSince("any");
            }}
          >
            {t("search.clearFilters")}
          </button>
        )}
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
              <span className="ml-auto min-w-0 truncate text-meta text-fg-muted">
                {hit.location.path}
              </span>
              {/* 원격 find 결과는 크기·시각이 미상(0/None) — 그때는 빈칸. */}
              <span className="w-20 shrink-0 text-right text-meta tabular-nums text-fg-muted">
                {hit.kind === "file" && hit.size > 0
                  ? formatSize(hit.size)
                  : ""}
              </span>
              <span className="w-24 shrink-0 text-right text-meta tabular-nums text-fg-muted">
                {formatTime(hit.modified_ms)}
              </span>
            </button>
          ))}
          {results.length >= 500 && (
            <div className="px-3 py-1 text-meta text-fg-muted">
              {t("search.truncated")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
