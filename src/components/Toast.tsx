import { CheckCircle2, AlertCircle, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast, type ToastItem } from "@/stores/toast";

/**
 * 토스트 스택 — 하단 중앙, 최신이 아래. 각 항목은 X 로 즉시 dismiss 가능.
 * error 는 danger 색 + 아이콘, success 는 accent 체크 아이콘으로 구분.
 */
export function Toast() {
  const toasts = useToast((s) => s.toasts);
  const stackRef = useRef<HTMLDivElement>(null);
  const newestId = toasts.at(-1)?.id;
  useEffect(() => {
    const stack = stackRef.current;
    if (stack) stack.scrollTop = stack.scrollHeight;
  }, [newestId]);
  if (toasts.length === 0) return null;
  return (
    <div
      ref={stackRef}
      className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex max-h-[60vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col items-center gap-1.5 overflow-y-auto overscroll-contain p-1"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const { t } = useTranslation();
  const dismiss = useToast((s) => s.dismiss);
  return (
    <div
      className={clsx(
        "pointer-events-auto flex w-full shrink-0 items-start gap-2 rounded-panel border bg-base px-3 py-2 text-base text-fg shadow-raised",
        toast.kind === "error" ? "border-danger" : "border-border",
      )}
    >
      {toast.kind === "success" && (
        <CheckCircle2
          size={14}
          className="mt-0.5 shrink-0 text-accent"
          aria-hidden
        />
      )}
      {toast.kind === "error" && (
        <AlertCircle
          size={14}
          className="mt-0.5 shrink-0 text-danger"
          aria-hidden
        />
      )}
      {/* 최대 4개 스택의 버튼·여백을 먼저 확보. 긴 본문만 스크롤해 X는 항상 고정. */}
      <div
        role={toast.kind === "error" ? "alert" : "status"}
        tabIndex={0}
        className="max-h-[clamp(1.5rem,calc((60vh-7rem)/4),8rem)] min-w-0 flex-1 overflow-y-auto overscroll-contain whitespace-pre-wrap [overflow-wrap:anywhere] leading-5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        {toast.message}
      </div>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-border hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={t("common.close")}
        title={t("common.close")}
      >
        <X size={12} />
      </button>
    </div>
  );
}
