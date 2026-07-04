import { CheckCircle2, AlertCircle, X } from "lucide-react";
import clsx from "clsx";
import { useToast, type ToastItem } from "@/stores/toast";

/**
 * 토스트 스택 — 하단 중앙, 최신이 아래. 각 항목은 X 로 즉시 dismiss 가능.
 * error 는 danger 색 + 아이콘, success 는 accent 체크 아이콘으로 구분.
 */
export function Toast() {
  const toasts = useToast((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1.5">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const dismiss = useToast((s) => s.dismiss);
  return (
    <div
      className={clsx(
        "pointer-events-auto flex max-w-lg items-start gap-2 rounded-md border bg-base px-3 py-1.5 text-base shadow-lg",
        toast.kind === "error" ? "border-danger" : "border-border",
      )}
    >
      {toast.kind === "success" && (
        <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
      )}
      {toast.kind === "error" && (
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden />
      )}
      {/* 멀티라인 에러(연결 실패 상세 등)도 잘리지 않게 whitespace 보존. */}
      <span className="whitespace-pre-wrap break-words">{toast.message}</span>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        className="mt-0.5 shrink-0 rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  );
}
