import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, TriangleAlert } from "lucide-react";
import { commands } from "@/types/bindings";
import type { EntryRef } from "@/types/bindings";
import { formatErr } from "@/lib/error";
import { useToast } from "@/stores/toast";

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
      showToast(`Permissions failed: ${formatErr(r.error)}`);
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
        showToast(`Owner change failed: ${formatErr(o.error)}`);
        return;
      }
    }
    showToast(`Permissions updated (${targets.length})`);
    onApplied();
    onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">
              Permissions
              <span className="ml-2 text-meta font-normal text-fg-muted">
                {targets.length === 1 ? targets[0]!.name : `${targets.length} items`}
              </span>
            </Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>

          {/* rwx 그리드 — 행: Owner/Group/Others, 열: r/w/x. 비트 = 8-(행*3+열). */}
          <div className="grid grid-cols-[5rem_repeat(3,2.5rem)] items-center gap-y-1 text-base">
            <span />
            {BITS.map((b) => (
              <span key={b} className="text-center text-meta text-fg-muted">
                {b}
              </span>
            ))}
            {CLASSES.map((cls, row) => (
              <div key={cls} className="contents">
                <span className="text-meta text-fg-muted">{cls}</span>
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

          <div className="mt-3 flex items-center gap-2">
            <span className="text-meta text-fg-muted">Octal</span>
            <input
              type="text"
              value={octal}
              onChange={(e) => onOctalChange(e.target.value)}
              spellCheck={false}
              className="w-20 rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
            />
            {initialMode === null && (
              <span className="text-meta text-fg-muted">(mixed — applying to all)</span>
            )}
          </div>

          {remote && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-meta text-fg-muted">Owner (chown)</span>
                <input
                  type="text"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="unchanged"
                  spellCheck={false}
                  className="mt-0.5 w-full rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-meta text-fg-muted">Group</span>
                <input
                  type="text"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                  placeholder="unchanged"
                  spellCheck={false}
                  className="mt-0.5 w-full rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
                />
              </label>
            </div>
          )}

          {hasDir && (
            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                checked={recursive}
                onChange={(e) => setRecursive(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-base">Apply recursively to contents</span>
            </label>
          )}

          {irreversible && (
            <div className="mt-2 flex items-center gap-1.5 text-meta text-danger">
              <TriangleAlert size={12} className="shrink-0" />
              {recursive
                ? "Recursive changes cannot be undone (Ctrl+Z won't restore old modes)."
                : "Ownership changes cannot be undone."}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy}
              className={
                irreversible
                  ? "rounded bg-danger px-3 py-1 text-base text-white disabled:opacity-50"
                  : "rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
              }
            >
              {irreversible ? "Apply (no undo)" : "Apply"}
            </button>
          </div>
          <Dialog.Description className="sr-only">
            Edit POSIX permissions and ownership
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
