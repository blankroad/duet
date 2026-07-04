import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Copy, Check, CircleAlert, LoaderCircle } from "lucide-react";
import { commands } from "@/types/bindings";
import type { ChecksumAlgo, EntryRef } from "@/types/bindings";
import { childLocation } from "@/lib/entryDnd";
import { formatErr } from "@/lib/error";
import { useToast } from "@/stores/toast";

export interface ChecksumDialogProps {
  targets: EntryRef[];
  onClose: () => void;
}

type RowState =
  | { status: "pending" }
  | { status: "done"; hash: string }
  | { status: "error"; message: string };

/**
 * 체크섬 다이얼로그 — 선택 파일들의 해시를 순차 계산해 표시.
 *
 * - 알고리즘 전환(SHA-256/512) 시 재계산. 원격 파일은 호스트측 해시(다운로드 0).
 * - Verify: 기대 해시를 붙여넣으면 각 행에 일치(✓)/불일치(✗) 표시 — 배포 파일
 *   무결성 확인 워크플로우.
 * - 행 복사는 `<hash>  <name>` (sha256sum 텍스트 포맷) — 그대로 검증 파일로 사용 가능.
 */
export function ChecksumDialog({ targets, onClose }: ChecksumDialogProps) {
  const [algo, setAlgo] = useState<ChecksumAlgo>("sha256");
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [verify, setVerify] = useState("");
  const showToast = useToast((s) => s.show);
  // 실행 세대 — algo 변경/언마운트 시 이전 루프 결과 무시(늦게 도착한 IPC 응답 가드).
  const genRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    setRows(Object.fromEntries(targets.map((t) => [t.name, { status: "pending" }])));
    void (async () => {
      // 순차 계산 — 원격 호스트에 동시 해시 폭주 방지 + 진행이 위에서 아래로 보임.
      for (const t of targets) {
        const r = await commands.fsChecksum(childLocation(t.location, t.name), algo);
        if (genRef.current !== gen) return;
        setRows((m) => ({
          ...m,
          [t.name]:
            r.status === "ok"
              ? { status: "done", hash: r.data }
              : { status: "error", message: formatErr(r.error) },
        }));
      }
    })();
    return () => {
      genRef.current += 1;
    };
  }, [algo, targets]);

  const expected = verify.trim().toLowerCase();
  const copyRow = (name: string, hash: string) => {
    void navigator.clipboard
      .writeText(`${hash}  ${name}`)
      .then(() => showToast("Copied", "success"))
      .catch(() => showToast("Clipboard unavailable", "error"));
  };
  const doneRows = targets
    .map((t) => ({ name: t.name, st: rows[t.name] }))
    .filter((r): r is { name: string; st: RowState & { status: "done" } } => r.st?.status === "done");
  const copyAll = () => {
    const text = doneRows.map((r) => `${r.st.hash}  ${r.name}`).join("\n");
    void navigator.clipboard
      .writeText(text)
      .then(() => showToast("Copied all", "success"))
      .catch(() => showToast("Clipboard unavailable", "error"));
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">Checksum</Dialog.Title>
            <div className="flex items-center gap-2">
              <select
                value={algo}
                onChange={(e) => setAlgo(e.target.value as ChecksumAlgo)}
                className="rounded border border-border bg-subtle px-2 py-1 text-base focus:border-accent focus:outline-none"
              >
                <option value="sha256">SHA-256</option>
                <option value="sha512">SHA-512</option>
              </select>
              <Dialog.Close
                className="rounded p-1 text-fg-muted hover:bg-border"
                aria-label="Close"
              >
                <X size={14} />
              </Dialog.Close>
            </div>
          </div>

          <div className="max-h-72 space-y-1 overflow-y-auto">
            {targets.map((t) => {
              const st = rows[t.name] ?? { status: "pending" as const };
              const match =
                expected && st.status === "done" ? st.hash === expected : null;
              return (
                <div key={t.name} className="rounded border border-border px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-base">
                      {t.name}
                    </span>
                    {st.status === "pending" && (
                      <LoaderCircle size={13} className="animate-spin text-fg-muted" />
                    )}
                    {match === true && (
                      <span className="flex items-center gap-1 text-meta text-icon-code">
                        <Check size={12} /> match
                      </span>
                    )}
                    {match === false && (
                      <span className="flex items-center gap-1 text-meta text-danger">
                        <CircleAlert size={12} /> mismatch
                      </span>
                    )}
                    {st.status === "done" && (
                      <button
                        type="button"
                        title="Copy (hash + name)"
                        onClick={() => copyRow(t.name, st.hash)}
                        className="rounded p-1 text-fg-muted hover:bg-border"
                      >
                        <Copy size={12} />
                      </button>
                    )}
                  </div>
                  {st.status === "done" && (
                    <div className="select-text break-all font-mono text-meta text-fg-muted">
                      {st.hash}
                    </div>
                  )}
                  {st.status === "error" && (
                    <div className="break-all text-meta text-danger">{st.message}</div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-3">
            <input
              type="text"
              value={verify}
              onChange={(e) => setVerify(e.target.value)}
              placeholder="Verify: paste an expected hash to compare"
              spellCheck={false}
              className="w-full rounded border border-border bg-subtle px-2 py-1 font-mono text-meta focus:border-accent focus:outline-none"
            />
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={copyAll}
              disabled={doneRows.length === 0}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle disabled:opacity-50"
            >
              Copy all
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-accent px-3 py-1 text-base text-white"
            >
              Close
            </button>
          </div>
          <Dialog.Description className="sr-only">
            File checksums for integrity verification
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
