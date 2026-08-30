import { useEffect, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { FilePlus2, FolderSync, Trash2, Loader2 } from "lucide-react";
import clsx from "clsx";
import {
  commands,
  type Location,
  type SyncPreview,
  type TrashUsage,
} from "@/types/bindings";
import { formatErr } from "@/lib/error";
import { formatSize } from "@/lib/format";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogBand } from "./DialogBand";
import { RouteBlock } from "./RouteBlock";

export interface SyncDialogProps {
  src: Location;
  dst: Location;
  onClose: () => void;
  /** prune=true 면 src 에 없는 dst 파일을 휴지통으로(삭제 전파). */
  onConfirm: (prune: boolean) => void;
}

/**
 * 단방향 미러 확인 — 방향(RouteBlock) + dry-run(복사/삭제 목록 사전 표시) + prune 토글.
 * prune 은 기본 OFF. 켜면 대상 전용 파일을 휴지통으로(undo 가능). 켰을 때 CTA danger.
 */
export function SyncDialog({ src, dst, onClose, onConfirm }: SyncDialogProps) {
  const { t } = useTranslation();
  const [prune, setPrune] = useState(false);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trash, setTrash] = useState<TrashUsage | null>(null);

  useEffect(() => {
    let stale = false;
    void (async () => {
      const r = await commands.fsSyncPreview(src, dst);
      if (stale) return;
      if (r.status === "ok") setPreview(r.data);
      else setError(formatErr(r.error));
    })();
    return () => {
      stale = true;
    };
  }, [src, dst]);

  // 원격 휴지통 누적 — prune/백업이 쌓이는 곳(dst 우선). 로컬↔로컬이면 생략.
  useEffect(() => {
    const sshSource =
      dst.source.kind === "ssh"
        ? dst.source
        : src.source.kind === "ssh"
          ? src.source
          : null;
    if (!sshSource) return;
    let stale = false;
    void (async () => {
      const r = await commands.fsTrashUsage(sshSource);
      if (!stale && r.status === "ok" && r.data.available) setTrash(r.data);
    })();
    return () => {
      stale = true;
    };
  }, [src, dst]);

  return (
    <DialogShell
      title={t("dialog.sync.title")}
      description={t("dialog.sync.desc")}
      icon={FolderSync}
      onClose={onClose}
      footer={
        <>
          <DialogButton hint="esc" onClick={onClose}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton
            tone={prune ? "danger" : "primary"}
            hint="enter"
            onClick={() => onConfirm(prune)}
          >
            {prune ? t("dialog.sync.ctaPruned") : t("dialog.sync.cta")}
          </DialogButton>
        </>
      }
    >
      <RouteBlock src={src} dst={dst} />

      {/* dry-run 요약 + 목록 */}
      {error ? (
        <DialogBand
          tone="danger"
          message={t("dialog.sync.previewFailed", { err: error })}
        />
      ) : preview == null ? (
        <div className="flex items-center gap-2 text-meta text-fg-muted">
          <Loader2 size={13} className="animate-spin" />{" "}
          {t("dialog.sync.computing")}
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-meta">
          <Section
            icon={<FilePlus2 size={12} className="text-accent" />}
            label={t("dialog.sync.copyLabel")}
            items={preview.copy}
            tone="text-fg"
          />
          <Section
            icon={
              <Trash2
                size={12}
                className={prune ? "text-danger" : "text-fg-muted"}
              />
            }
            label={
              prune
                ? t("dialog.sync.deleteLabel")
                : t("dialog.sync.targetOnlyLabel")
            }
            items={preview.prune}
            tone={prune ? "text-danger" : "text-fg-muted"}
          />
          {preview.truncated && (
            <div className="text-warning">{t("dialog.sync.truncated")}</div>
          )}
        </div>
      )}

      <label className="flex cursor-pointer items-start gap-2 text-base">
        <input
          type="checkbox"
          checked={prune}
          onChange={(e) => setPrune(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          {t("dialog.sync.pruneOption")}
          <span className="block text-meta text-fg-muted">
            {preview
              ? t("dialog.sync.pruneHintCount", {
                  count: preview.prune.length,
                })
              : t("dialog.sync.pruneHint")}
          </span>
        </span>
      </label>

      {trash && (
        <div className="text-meta text-fg-muted">
          <Trans
            i18nKey="dialog.sync.remoteTrash"
            components={{ 1: <span className="font-mono" /> }}
          />{" "}
          <b className={trash.bytes > 0 ? "text-fg" : ""}>
            {formatSize(trash.bytes)}
          </b>
          {trash.bytes > 0 && t("dialog.sync.remoteTrashPile")}
        </div>
      )}

      {prune && (
        <DialogBand tone="warning" message={t("dialog.sync.pruneWarn")} />
      )}
    </DialogShell>
  );
}

function Section({
  icon,
  label,
  items,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  items: string[];
  tone: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-fg-muted">
        {icon}
        <span>
          {label}: <b className="text-fg">{items.length}</b>
        </span>
      </div>
      {items.length > 0 && (
        <div
          className={clsx(
            "mt-1 max-h-24 overflow-auto rounded border border-border bg-subtle/40 px-2 py-1 font-mono",
            tone,
          )}
        >
          {items.slice(0, 200).map((rel) => (
            <div key={rel} className="truncate" title={rel}>
              {rel}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
