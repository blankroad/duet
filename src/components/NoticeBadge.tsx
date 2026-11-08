import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, AlertTriangle, X } from "lucide-react";
import clsx from "clsx";
import { useNotices, type Notice } from "@/stores/notices";

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

  // 열려 있는 동안 새로 온 알림도 바로 읽음.
  useEffect(() => {
    if (open) useNotices.getState().markAllRead();
  }, [open, items.length]);

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
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  if (items.length === 0) return null;

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const label =
    unread > 0
      ? t("notices.openUnread", { count: unread })
      : t("notices.openRead");

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
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
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.stopPropagation();
              close();
            }}
            className="fixed bottom-7 right-2 z-[60] flex max-h-[50vh] w-[min(28rem,calc(100vw-1rem))] flex-col rounded-panel border border-border bg-base text-base text-fg shadow-raised focus:outline-none"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              <span className="flex-1 font-medium">{t("notices.title")}</span>
              <button
                type="button"
                onClick={() => {
                  useNotices.getState().clear();
                  close();
                }}
                className="rounded px-1.5 py-0.5 text-meta text-fg-muted hover:bg-border hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {t("notices.clear")}
              </button>
              <button
                type="button"
                onClick={close}
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
