import { CheckCircle2, AlertCircle, AlertTriangle, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useToast, type ToastItem } from "@/stores/toast";

/**
 * 토스트 스택 — 하단 중앙, 최신이 아래. 모두 자동으로 사라지고 X 로 바로 닫을 수도 있다.
 * error 는 danger, warning 은 warning 색 + 아이콘, success 는 accent 체크 아이콘으로 구분.
 * 오류·경고는 사라진 뒤에도 상태바 알림 배지(NoticeBadge)에서 다시 볼 수 있다.
 *
 * body 포털 + z-[70] — 대화상자 오버레이(z-50, 겹침 z-60) 위에 뜬다. 예전엔 같은 z 의
 * 오버레이 밑에 깔려 대화상자 안 작업의 실패 토스트가 어둡게 가려졌고, X 를 누르면
 * 오버레이 클릭으로 대화상자가 닫혔다(DialogShell 은 `data-toast-root` 클릭을 바깥으로 보지 않는다).
 */
export function Toast() {
  const toasts = useToast((s) => s.toasts);
  const stackRef = useRef<HTMLDivElement>(null);
  const newestId = toasts.at(-1)?.id;
  useEffect(() => {
    const stack = stackRef.current;
    if (stack) stack.scrollTop = stack.scrollHeight;
  }, [newestId]);
  // 알림은 모달이 떠 있어도 읽혀야 한다 — Radix 모달은 열릴 때 body 의 다른 자식을
  // aria-hidden 으로 숨기는데, 토스트가 먼저 떠 있었으면 이후 오류 토스트까지 스크린리더에서
  // 사라졌다. 이 스택에 붙는 aria-hidden 만 걷어낸다(모달 본문 쪽 숨김은 그대로).
  const shown = toasts.length > 0;
  useEffect(() => {
    const stack = stackRef.current;
    if (!shown || !stack) return;
    const unhide = () => {
      if (stack.hasAttribute("aria-hidden"))
        stack.removeAttribute("aria-hidden");
    };
    unhide();
    const mo = new MutationObserver(unhide);
    mo.observe(stack, { attributes: true, attributeFilter: ["aria-hidden"] });
    return () => mo.disconnect();
  }, [shown]);
  if (!shown) return null;
  return createPortal(
    <div
      ref={stackRef}
      data-toast-root=""
      className="pointer-events-none fixed bottom-4 left-1/2 z-[70] flex max-h-[60vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col items-center gap-1.5 overflow-y-auto overscroll-contain p-1"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>,
    document.body,
  );
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const { t } = useTranslation();
  const dismiss = useToast((s) => s.dismiss);
  return (
    <div
      className={clsx(
        "pointer-events-auto flex w-full shrink-0 items-start gap-2 rounded-panel border bg-base px-3 py-2 text-base text-fg shadow-raised",
        toast.kind === "error"
          ? "border-danger"
          : toast.kind === "warning"
            ? "border-warning"
            : "border-border",
      )}
    >
      {toast.kind === "success" && (
        <CheckCircle2
          size={14}
          className="mt-0.5 shrink-0 text-accent"
          aria-hidden
        />
      )}
      {toast.kind === "warning" && (
        <AlertTriangle
          size={14}
          className="mt-0.5 shrink-0 text-warning"
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
