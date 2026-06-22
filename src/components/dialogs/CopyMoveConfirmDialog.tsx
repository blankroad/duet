import * as Dialog from "@radix-ui/react-dialog";
import { X, FilePlus2, SkipForward, Copy } from "lucide-react";
import type { ReactNode } from "react";
import type { ConflictPolicy } from "@/types/bindings";

/**
 * 복사/이동 확인 다이얼로그. 충돌(같은 이름)이 있으면 탐색기/파인더/TC 식 선택지
 * (Replace / Skip / Keep both) 를 보여주고, 없으면 단순 확인.
 *
 * onConfirm(policy) — 선택한 정책으로 실행. 충돌 없을 땐 "replace"(무의미, 그냥 복사).
 */
export function CopyMoveConfirmDialog({
  title,
  body,
  ctaLabel,
  conflicts,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: ReactNode;
  ctaLabel: string;
  conflicts: number;
  onCancel: () => void;
  onConfirm: (policy: ConflictPolicy) => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">
              {title}
            </Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>
          <div className="text-base">{body}</div>

          {conflicts > 0 ? (
            <div className="mt-4 space-y-2">
              <div className="text-meta text-fg-muted">
                {conflicts} item(s) already exist at the destination. Choose how
                to resolve:
              </div>
              <div className="flex flex-col gap-1.5">
                <ChoiceButton
                  icon={<Copy size={14} />}
                  label="Replace"
                  hint="Overwrite (existing kept as .bak — undoable)"
                  onClick={() => onConfirm("replace")}
                />
                <ChoiceButton
                  icon={<SkipForward size={14} />}
                  label="Skip"
                  hint="Don't copy conflicting items"
                  onClick={() => onConfirm("skip")}
                />
                <ChoiceButton
                  icon={<FilePlus2 size={14} />}
                  label="Keep both"
                  hint="Copy with a new name — name (1).ext"
                  onClick={() => onConfirm("keepboth")}
                />
              </div>
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={onCancel}
                  className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onConfirm("replace")}
                className="rounded bg-accent px-3 py-1 text-base text-white"
              >
                {ctaLabel}
              </button>
            </div>
          )}

          <Dialog.Description className="sr-only">{title}</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ChoiceButton({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded border border-border px-3 py-2 text-left hover:border-accent hover:bg-subtle"
    >
      <span className="shrink-0 text-fg-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block text-base text-fg">{label}</span>
        <span className="block text-meta text-fg-muted">{hint}</span>
      </span>
    </button>
  );
}
