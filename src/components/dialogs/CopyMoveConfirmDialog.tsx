import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, FilePlus2, SkipForward, Copy, ListChecks } from "lucide-react";
import clsx from "clsx";
import type { ReactNode } from "react";
import type { Conflict, ConflictPolicy } from "@/types/bindings";

/**
 * 복사/이동 확인 다이얼로그. 충돌(같은 이름)이 있으면 탐색기/파인더/TC 식 선택지
 * (Replace / Skip / Keep both) 를 보여주고, 없으면 단순 확인.
 *
 * - 일괄: onConfirm(policy) — 배치 전체에 한 정책.
 * - 개별: "Choose per file" 로 펼쳐 파일마다 정책 선택 → onConfirmPerFile(decisions).
 *   어떤 파일이 덮어써지는지 이름/경로를 보여줘 Replace(영구, undo 불가)의
 *   실수 범위를 줄인다.
 */
export function CopyMoveConfirmDialog({
  title,
  body,
  ctaLabel,
  conflicts,
  onCancel,
  onConfirm,
  onConfirmPerFile,
}: {
  title: string;
  body: ReactNode;
  ctaLabel: string;
  conflicts: Conflict[];
  onCancel: () => void;
  onConfirm: (policy: ConflictPolicy) => void;
  onConfirmPerFile: (decisions: Record<string, ConflictPolicy>) => void;
}) {
  const [perFile, setPerFile] = useState(false);
  // 개별 모드 기본값: skip — 아무것도 덮어쓰거나 새로 만들지 않는 안전한 시작점.
  const [decisions, setDecisions] = useState<Record<string, ConflictPolicy>>(
    () => Object.fromEntries(conflicts.map((c) => [c.name, "skip" as const])),
  );

  const setAll = (p: ConflictPolicy) =>
    setDecisions(Object.fromEntries(conflicts.map((c) => [c.name, p])));

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
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

          {conflicts.length > 0 ? (
            <div className="mt-4 flex min-h-0 flex-col space-y-2">
              <div className="text-meta text-fg-muted">
                {conflicts.length} item(s) already exist at the destination.
                Choose how to resolve:
              </div>

              {!perFile ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <ChoiceButton
                      icon={<Copy size={14} />}
                      label="Replace all"
                      hint="Overwrite existing (permanent — cannot be undone)"
                      onClick={() => onConfirm("replace")}
                    />
                    <ChoiceButton
                      icon={<SkipForward size={14} />}
                      label="Skip all"
                      hint="Don't copy conflicting items"
                      onClick={() => onConfirm("skip")}
                    />
                    <ChoiceButton
                      icon={<FilePlus2 size={14} />}
                      label="Keep both (all)"
                      hint="Copy with a new name — name (1).ext"
                      onClick={() => onConfirm("keepboth")}
                    />
                    <ChoiceButton
                      icon={<ListChecks size={14} />}
                      label="Choose per file…"
                      hint="Decide Replace / Skip / Keep both for each item"
                      onClick={() => setPerFile(true)}
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
                </>
              ) : (
                <>
                  {/* 상단 일괄 세터 — 개별 모드에서도 한 번에 초기화 가능. */}
                  <div className="flex items-center gap-2 text-meta text-fg-muted">
                    <span>Set all:</span>
                    <MiniBtn label="Replace" onClick={() => setAll("replace")} />
                    <MiniBtn label="Skip" onClick={() => setAll("skip")} />
                    <MiniBtn label="Keep both" onClick={() => setAll("keepboth")} />
                  </div>
                  <ul className="min-h-0 flex-1 divide-y divide-border overflow-auto rounded border border-border">
                    {conflicts.map((c) => (
                      <li
                        key={c.name}
                        className="flex items-center gap-2 px-2 py-1.5"
                      >
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-base"
                          title={c.dst_path}
                        >
                          {c.name}
                        </span>
                        <PolicyPicker
                          value={decisions[c.name] ?? "skip"}
                          onChange={(p) =>
                            setDecisions((d) => ({ ...d, [c.name]: p }))
                          }
                        />
                      </li>
                    ))}
                  </ul>
                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={onCancel}
                      className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => onConfirmPerFile(decisions)}
                      className="rounded bg-accent px-3 py-1 text-base text-white"
                    >
                      {ctaLabel} with choices
                    </button>
                  </div>
                </>
              )}
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

/** 개별 충돌 행의 Replace/Skip/Keep both 세그먼트 선택. */
function PolicyPicker({
  value,
  onChange,
}: {
  value: ConflictPolicy;
  onChange: (p: ConflictPolicy) => void;
}) {
  const opts: Array<{ p: ConflictPolicy; label: string; danger?: boolean }> = [
    { p: "replace", label: "Replace", danger: true },
    { p: "skip", label: "Skip" },
    { p: "keepboth", label: "Keep both" },
  ];
  return (
    <div className="flex shrink-0 overflow-hidden rounded border border-border text-meta">
      {opts.map(({ p, label, danger }) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={clsx(
            "px-1.5 py-0.5 transition-colors",
            value === p
              ? danger
                ? "bg-danger text-white"
                : "bg-accent text-white"
              : "text-fg-muted hover:bg-subtle",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function MiniBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-border px-1.5 py-0.5 hover:bg-subtle"
    >
      {label}
    </button>
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
