import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { commands } from "@/types/bindings";
import type { EntryRef } from "@/types/bindings";
import { formatErr } from "@/lib/error";
import { useToast } from "@/stores/toast";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogInput } from "./DialogInput";
import { DialogBand } from "./DialogBand";

export interface PermissionsDialogProps {
  targets: EntryRef[];
  /** 선택 항목들의 공통 mode (0o777) — 서로 다르면 null(빈 상태에서 설정). */
  initialMode: number | null;
  /** 원격(SSH)이면 소유자/그룹 편집 노출. */
  remote: boolean;
  /** 폴더 포함 선택이면 재귀 옵션 노출. */
  hasDir: boolean;
  onClose: () => void;
  /** 적용 성공 후 — 호출부가 영향 location refresh. */
  onApplied: () => void;
}

const CLASSES = ["Owner", "Group", "Others"] as const;
const CLASS_KEYS: Record<(typeof CLASSES)[number], string> = {
  Owner: "dialog.permissions.classOwner",
  Group: "dialog.permissions.classGroup",
  Others: "dialog.permissions.classOthers",
};
const BITS = ["r", "w", "x"] as const;

/**
 * 권한/소유자 편집 (WinSCP Properties 대응).
 *
 * - rwx 9비트 체크박스 ↔ 8진수 입력 양방향 동기화.
 * - 비재귀 적용은 undo 가능(백엔드가 이전 mode 기록). 재귀는 되돌릴 수 없어
 *   경고 표시(§4 — 사용자 명시 승인 후에만 Irreversible 허용).
 * - 소유자/그룹(chown)은 원격 전용 + 항상 Irreversible — 값을 넣었을 때만 실행.
 */
export function PermissionsDialog({
  targets,
  initialMode,
  remote,
  hasDir,
  onClose,
  onApplied,
}: PermissionsDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<number>(initialMode ?? 0o644);
  const [octal, setOctal] = useState<string>(
    (initialMode ?? 0o644).toString(8).padStart(3, "0"),
  );
  const [recursive, setRecursive] = useState(false);
  const [owner, setOwner] = useState("");
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const showToast = useToast((s) => s.show);

  const setModeBoth = (m: number) => {
    setMode(m);
    setOctal(m.toString(8).padStart(3, "0"));
  };
  const toggleBit = (bit: number) => setModeBoth(mode ^ bit);
  const onOctalChange = (s: string) => {
    setOctal(s);
    if (/^[0-7]{3,4}$/.test(s)) setMode(parseInt(s, 8) & 0o777);
  };

  const chownWanted = remote && (owner.trim() !== "" || group.trim() !== "");
  const irreversible = recursive || chownWanted;

  const apply = async () => {
    setBusy(true);
    const r = await commands.fsSetPermissions(targets, mode, recursive);
    if (r.status === "error") {
      setBusy(false);
      showToast(
        t("dialog.permissions.failed", { err: formatErr(r.error) }),
        "error",
      );
      return;
    }
    if (chownWanted) {
      const o = await commands.fsSetOwner(
        targets,
        owner.trim() || null,
        group.trim() || null,
        recursive,
      );
      if (o.status === "error") {
        setBusy(false);
        showToast(
          t("dialog.permissions.ownerFailed", { err: formatErr(o.error) }),
          "error",
        );
        return;
      }
    }
    showToast(
      t("dialog.permissions.updated", { count: targets.length }),
      "success",
    );
    onApplied();
    onClose();
  };

  const subtitle =
    targets.length === 1
      ? targets[0]!.name
      : t("dialog.permissions.items", { count: targets.length });

  return (
    <DialogShell
      width="sm"
      title={t("dialog.permissions.title")}
      subtitle={<span className="font-mono">{subtitle}</span>}
      description={t("dialog.permissions.desc")}
      icon={ShieldCheck}
      iconTone={irreversible ? "danger" : "muted"}
      onClose={onClose}
      footer={
        <>
          <DialogButton hint="esc" onClick={onClose}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton
            tone={irreversible ? "danger" : "primary"}
            hint="enter"
            disabled={busy}
            onClick={() => void apply()}
          >
            {irreversible
              ? t("dialog.permissions.applyNoUndo")
              : t("common.apply")}
          </DialogButton>
        </>
      }
    >
      {/* rwx 그리드 — 행: Owner/Group/Others, 열: r/w/x. 비트 = 8-(행*3+열). */}
      <div className="grid grid-cols-[5rem_repeat(3,2.5rem)] items-center gap-y-1">
        <span />
        {BITS.map((b) => (
          <span
            key={b}
            className="text-center font-mono text-meta text-fg-muted"
          >
            {b}
          </span>
        ))}
        {CLASSES.map((cls, row) => (
          <div key={cls} className="contents">
            <span className="text-meta text-fg-muted">
              {t(CLASS_KEYS[cls])}
            </span>
            {BITS.map((b, col) => {
              const bit = 1 << (8 - (row * 3 + col));
              return (
                <span key={b} className="text-center">
                  <input
                    type="checkbox"
                    checked={(mode & bit) !== 0}
                    onChange={() => toggleBit(bit)}
                  />
                </span>
              );
            })}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-meta text-fg-muted">
          {t("dialog.permissions.octal")}
        </span>
        <DialogInput
          mono
          type="text"
          value={octal}
          onChange={(e) => onOctalChange(e.target.value)}
          className="w-20"
        />
        {initialMode === null && (
          <span className="text-meta text-fg-muted">
            {t("dialog.permissions.mixed")}
          </span>
        )}
      </div>

      {remote && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-meta text-fg-muted">
              {t("dialog.permissions.ownerChown")}
            </span>
            <DialogInput
              mono
              type="text"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder={t("dialog.permissions.unchanged")}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-meta text-fg-muted">
              {t("dialog.permissions.group")}
            </span>
            <DialogInput
              mono
              type="text"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder={t("dialog.permissions.unchanged")}
            />
          </label>
        </div>
      )}

      {hasDir && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={recursive}
            onChange={(e) => setRecursive(e.target.checked)}
            className="mt-0.5"
          />
          <span>{t("dialog.permissions.recursive")}</span>
        </label>
      )}

      {irreversible && (
        <DialogBand
          tone="danger"
          message={
            recursive
              ? t("dialog.permissions.recursiveWarn")
              : t("dialog.permissions.ownerWarn")
          }
        />
      )}
    </DialogShell>
  );
}
