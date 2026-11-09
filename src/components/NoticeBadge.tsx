import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, AlertTriangle, X } from "lucide-react";
import clsx from "clsx";
import { useNotices, type Notice } from "@/stores/notices";
import { releaseFocusAfterMouse } from "@/lib/keyIsolation";

/**
 * 상태바 알림 배지 — 사라진 오류·경고 토스트를 다시 보는 곳.
 *
 * - 읽지 않은 알림이 있으면 danger 색 아이콘 + 개수, 다 읽었으면 흐린 아이콘만,
 *   기록이 없으면 렌더하지 않는다.
 * - 누르면 상태바 위에 최근 알림 목록이 열린다(최신이 위). 열면 모두 읽음 처리.
 *   원문(백엔드 오류)은 항목별 "자세히"에 접어 둔다.
 * - 목록은 role=dialog — 열려 있는 동안 전역 단축키·패널 키가 뒤 패널을 건드리지 않는다
 *   (`modalDialogOpen`). Esc·바깥 클릭으로 닫는다.
 */
export function NoticeBadge() {
  const { t } = useTranslation();
  const items = useNotices((s) => s.items);
  const unread = useNotices((s) => s.unread);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const pointerFocusCaptured = useRef(false);
  const close = useCallback((clearing = false) => {
    setOpen(false);
    const target = clearing ? returnFocusRef.current : buttonRef.current;
    if (target?.isConnected) {
      target.focus();
      if (document.activeElement === target) return;
    }
    if (!clearing) return;
    // 기억할 컨트롤이 없으면 토글 버튼 대신 상태바 자체로 돌아간다.
    // Tab 순서에는 넣지 않고, 다음 Enter가 인접 버튼을 누르지 않게 한다.
    const container = buttonRef.current?.parentElement;
    if (!container || container === document.body) return;
    if (!container.hasAttribute("tabindex")) {
      container.tabIndex = -1;
      container.addEventListener(
        "blur",
        () => container.removeAttribute("tabindex"),
        { once: true },
      );
    }
    container.focus();
  }, []);

  const rememberFocus = (allowDomFallback: boolean) => {
    returnFocusRef.current = null;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== buttonRef.current
    ) {
      returnFocusRef.current = active;
      return;
    }
    if (!allowDomFallback) return;
    // 키보드로 연 경우에만 인접 컨트롤로 돌아간다.
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        "button, a[href], input, select, textarea, [tabindex]",
      ),
    ).filter(
      (el) =>
        el.tabIndex >= 0 &&
        !el.matches(":disabled") &&
        !el.closest('[hidden], [aria-hidden="true"]'),
    );
    const index = buttonRef.current ? controls.indexOf(buttonRef.current) : -1;
    if (index >= 0)
      returnFocusRef.current =
        controls[index - 1] ?? controls[index + 1] ?? null;
  };

  // 열려 있는 동안 새로 온 알림도 바로 읽음.
  useEffect(() => {
    if (open && unread > 0) useNotices.getState().markAllRead();
  }, [open, unread]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        panelRef.current?.contains(target) ||
        buttonRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      const dialog =
        target instanceof Element
          ? target.closest('[role="dialog"], [aria-modal="true"]')
          : null;
      if (dialog && dialog !== panelRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const controls = Array.from(
        panel.querySelectorAll<HTMLElement>(
          "button, a[href], input, select, textarea, summary, [tabindex]",
        ),
      ).filter((el) => el.tabIndex >= 0 && !el.matches(":disabled"));
      const first = controls[0];
      const last = controls.at(-1);
      const active = document.activeElement;
      if (
        !panel.contains(active) ||
        active === panel ||
        (e.shiftKey ? active === first : active === last)
      ) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  if (items.length === 0) return null;

  const label =
    unread > 0
      ? t("notices.openUnread", { count: unread })
      : t("notices.openRead");

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onPointerDown={(e) => {
          if (open || e.button > 0) return;
          rememberFocus(false);
          pointerFocusCaptured.current = true;
        }}
        onPointerCancel={() => {
          pointerFocusCaptured.current = false;
        }}
        onClick={(e) => {
          if (!open && !pointerFocusCaptured.current)
            rememberFocus(e.detail === 0);
          pointerFocusCaptured.current = false;
          releaseFocusAfterMouse(e);
          setOpen((v) => !v);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={clsx(
          "flex h-full shrink-0 items-center gap-1 rounded px-1 hover:bg-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
          unread > 0
            ? "font-medium text-danger"
            : "text-fg-muted hover:text-fg",
        )}
      >
        <AlertCircle size={12} aria-hidden="true" />
        {unread > 0 && <span>{unread}</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t("notices.title")}
            tabIndex={-1}
            className="fixed bottom-7 right-2 z-[60] flex max-h-[50vh] w-[min(28rem,calc(100vw-1rem))] flex-col rounded-panel border border-border bg-base text-base text-fg shadow-raised focus:outline-none"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              <span className="flex-1 font-medium">{t("notices.title")}</span>
              <button
                type="button"
                onClick={(e) => {
                  // 복귀한 컨테이너를 상태바의 mouse blur가 다시 해제하지 않게 한다.
                  e.stopPropagation();
                  releaseFocusAfterMouse(e);
                  close(true);
                  useNotices.getState().clear();
                }}
                className="rounded px-1.5 py-0.5 text-meta text-fg-muted hover:bg-border hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {t("notices.clear")}
              </button>
              <button
                type="button"
                onClick={() => close()}
                aria-label={t("common.close")}
                title={t("common.close")}
                className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-border hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X size={12} />
              </button>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {items.map((n) => (
                <NoticeRow key={n.id} notice={n} />
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}

function NoticeRow({ notice }: { notice: Notice }) {
  const { t } = useTranslation();
  const time = new Date(notice.at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const Icon = notice.kind === "error" ? AlertCircle : AlertTriangle;
  // 원문이 보인 문장과 같으면 접어 둘 것이 없다.
  const detail =
    notice.detail && notice.detail !== notice.message
      ? notice.detail
      : undefined;
  return (
    <li className="flex gap-2 border-b border-border px-3 py-2 last:border-b-0">
      <Icon
        size={14}
        aria-hidden="true"
        className={clsx(
          "mt-0.5 shrink-0",
          notice.kind === "error" ? "text-danger" : "text-warning",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex gap-2">
          <span className="min-w-0 flex-1 whitespace-pre-wrap leading-5 [overflow-wrap:anywhere]">
            {notice.message}
          </span>
          <time className="shrink-0 text-meta text-fg-muted">{time}</time>
        </div>
        {detail && (
          <details className="mt-1 text-meta text-fg-muted">
            <summary className="cursor-pointer select-none hover:text-fg">
              {t("notices.detail")}
            </summary>
            <pre className="mt-1 select-text whitespace-pre-wrap rounded bg-subtle p-1.5 font-mono [overflow-wrap:anywhere]">
              {detail}
            </pre>
          </details>
        )}
      </div>
    </li>
  );
}
