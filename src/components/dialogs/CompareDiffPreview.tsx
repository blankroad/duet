import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  commands,
  type CompareEntry,
  type ComparePairPreview,
  type Location,
  type PreviewData,
} from "@/types/bindings";
import { lineDiff } from "@/lib/lineDiff";
import { formatErr } from "@/lib/error";

const MAX_DIFF_LINES = 600; // LCS O(n*m) 보호 — 초과분은 잘라 표시.

const dataUrl = (p: PreviewData) => `data:${p.mime};base64,${p.bytes_base64}`;

/**
 * 선택된 비교 행의 좌/우 인라인 미리보기 — 텍스트는 라인 diff, 이미지는 좌우 비교.
 * 양쪽에 존재하는 파일(differ/newer/same)만 대상. 경로 결합은 백엔드(§7).
 */
export function CompareDiffPreview({
  entry,
  left,
  right,
}: {
  entry: CompareEntry | null;
  left: Location;
  right: Location;
}) {
  const [data, setData] = useState<ComparePairPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const rel = entry?.rel ?? null;
  const previewable =
    entry != null &&
    entry.kind === "file" &&
    (entry.status === "differ" ||
      entry.status === "newer_left" ||
      entry.status === "newer_right" ||
      entry.status === "same");

  useEffect(() => {
    if (!previewable || rel == null) {
      setData(null);
      setError(null);
      return;
    }
    let stale = false;
    setLoading(true);
    setError(null);
    void (async () => {
      const r = await commands.fsComparePairPreview(left, right, rel);
      if (stale) return;
      if (r.status === "ok") setData(r.data);
      else {
        setData(null);
        setError(formatErr(r.error));
      }
      setLoading(false);
    })();
    return () => {
      stale = true;
    };
  }, [previewable, rel, left, right]);

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="mt-2 max-h-48 min-h-[3rem] overflow-auto rounded border border-border bg-subtle/40 text-meta">
      {children}
    </div>
  );

  if (!entry) return <Shell>{note("Select a row to preview.")}</Shell>;
  if (!previewable) return <Shell>{note("No preview (one-side only / directory).")}</Shell>;
  if (loading) return <Shell>{note("Loading…")}</Shell>;
  if (error) return <Shell>{note(`Preview failed: ${error}`, true)}</Shell>;
  if (!data) return null;

  if (data.left.kind === "text" && data.right.kind === "text") {
    const a = (data.left.text ?? "").split("\n").slice(0, MAX_DIFF_LINES);
    const b = (data.right.text ?? "").split("\n").slice(0, MAX_DIFF_LINES);
    const ops = lineDiff(a, b);
    const truncated =
      data.left.truncated ||
      data.right.truncated ||
      (data.left.text ?? "").split("\n").length > MAX_DIFF_LINES;
    return (
      <Shell>
        <div className="font-mono">
          {ops.map((op, i) => (
            <div
              key={i}
              className={clsx(
                "whitespace-pre px-2",
                op.t === "add" && "bg-accent/10 text-accent",
                op.t === "del" && "bg-danger/10 text-danger",
              )}
            >
              <span className="select-none text-fg-muted">
                {op.t === "add" ? "+" : op.t === "del" ? "-" : " "}
              </span>{" "}
              {op.text}
            </div>
          ))}
          {truncated && note("(truncated — large file)", false)}
        </div>
      </Shell>
    );
  }

  if (data.left.kind === "image" && data.right.kind === "image") {
    return (
      <Shell>
        <div className="flex items-start gap-2 p-2">
          <img src={dataUrl(data.left)} alt="left" className="max-h-40 max-w-[48%] object-contain" />
          <img
            src={dataUrl(data.right)}
            alt="right"
            className="max-h-40 max-w-[48%] object-contain"
          />
        </div>
      </Shell>
    );
  }

  return <Shell>{note(`Preview: ${data.left.kind} ↔ ${data.right.kind} (not text/image)`)}</Shell>;
}

function note(text: string, danger = false) {
  return <div className={clsx("px-2 py-3 text-center", danger ? "text-danger" : "text-fg-muted")}>{text}</div>;
}
