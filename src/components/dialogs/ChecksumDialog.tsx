import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check, CircleAlert, Hash, LoaderCircle } from "lucide-react";
import { commands } from "@/types/bindings";
import type { ChecksumAlgo, EntryRef } from "@/types/bindings";
import { childLocation } from "@/lib/entryDnd";
import { formatErr } from "@/lib/error";
import { useToast } from "@/stores/toast";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogInput } from "./DialogInput";

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
  const { t } = useTranslation();
  const [algo, setAlgo] = useState<ChecksumAlgo>("sha256");
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [verify, setVerify] = useState("");
  const showToast = useToast((s) => s.show);
  // 실행 세대 — algo 변경/언마운트 시 이전 루프 결과 무시(늦게 도착한 IPC 응답 가드).
  const genRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    setRows(
      Object.fromEntries(targets.map((t) => [t.name, { status: "pending" }])),
    );
    void (async () => {
      // 순차 계산 — 원격 호스트에 동시 해시 폭주 방지 + 진행이 위에서 아래로 보임.
      for (const t of targets) {
        const r = await commands.fsChecksum(
          childLocation(t.location, t.name),
          algo,
        );
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
      .then(() => showToast(t("dialog.checksum.copied"), "success"))
      .catch(() => showToast(t("toast.clipboardUnavailable"), "error"));
  };
  const doneRows = targets
    .map((t) => ({ name: t.name, st: rows[t.name] }))
    .filter(
      (r): r is { name: string; st: RowState & { status: "done" } } =>
        r.st?.status === "done",
    );
  const copyAll = () => {
    const text = doneRows.map((r) => `${r.st.hash}  ${r.name}`).join("\n");
    void navigator.clipboard
      .writeText(text)
      .then(() => showToast(t("dialog.checksum.copiedAll"), "success"))
      .catch(() => showToast(t("toast.clipboardUnavailable"), "error"));
  };

  return (
    <DialogShell
      width="xl"
      title={t("dialog.checksum.title")}
      subtitle={t("dialog.permissions.items", { count: targets.length })}
      description={t("dialog.checksum.desc")}
      icon={Hash}
      onClose={onClose}
      headerRight={
        <select
          value={algo}
          onChange={(e) => setAlgo(e.target.value as ChecksumAlgo)}
          className="h-7 rounded border border-border bg-subtle px-2 text-base focus:border-accent focus:outline-none"
        >
          <option value="sha256">SHA-256</option>
          <option value="sha512">SHA-512</option>
        </select>
      }
      footer={
        <>
          <DialogButton disabled={doneRows.length === 0} onClick={copyAll}>
            {t("dialog.checksum.copyAll")}
          </DialogButton>
          <DialogButton tone="primary" hint="esc" onClick={onClose}>
            {t("common.close")}
          </DialogButton>
        </>
      }
    >
      <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        {targets.map((tgt) => {
          const st = rows[tgt.name] ?? { status: "pending" as const };
          const match =
            expected && st.status === "done" ? st.hash === expected : null;
          return (
            <div
              key={tgt.name}
              className="rounded-panel border border-border px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-base"
                  title={tgt.name}
                >
                  {tgt.name}
                </span>
                {st.status === "pending" && (
                  <LoaderCircle
                    size={13}
                    className="animate-spin text-fg-muted"
                  />
                )}
                {match === true && (
                  <span className="flex items-center gap-1 text-meta text-success">
                    <Check size={12} /> {t("dialog.checksum.match")}
                  </span>
                )}
                {match === false && (
                  <span className="flex items-center gap-1 text-meta text-danger">
                    <CircleAlert size={12} /> {t("dialog.checksum.mismatch")}
                  </span>
                )}
                {st.status === "done" && (
                  <button
                    type="button"
                    title={t("dialog.checksum.copyRow")}
                    onClick={() => copyRow(tgt.name, st.hash)}
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
                <div className="break-all text-meta text-danger">
                  {st.message}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <DialogInput
        mono
        type="text"
        value={verify}
        onChange={(e) => setVerify(e.target.value)}
        placeholder={t("dialog.checksum.verifyPlaceholder")}
        className="text-meta"
      />
    </DialogShell>
  );
}
