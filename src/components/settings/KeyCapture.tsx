import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { formatKeyEvent } from "@/lib/keyEvent";
import { displayKey } from "@/lib/keyDisplay";

/**
 * 활성 동안 Esc 를 가로챈다 — window **capture** 단계라 Radix 다이얼로그의
 * document capture Esc(설정 창 닫기)보다 먼저 받는다. 예전엔 키 캡처를 Esc 로
 * 취소하면 설정 창이 통째로 닫혔다.
 */
function useEscapeTrap(onEscape: () => void): void {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cb.current();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);
}

/** 키 캡처 입력 — 다음 키 조합을 받아 onCapture. Esc = 취소(설정 창은 유지). */
export function KeyCaptureInput({
  onCancel,
  onCapture,
}: {
  onCancel: () => void;
  onCapture: (key: string) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  useEscapeTrap(onCancel);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      readOnly
      value=""
      aria-label={t("settings.keymap.pressKey")}
      placeholder={t("settings.keymap.pressKey")}
      onKeyDown={(e) => {
        const ks = formatKeyEvent(e.nativeEvent);
        if (ks) {
          e.preventDefault();
          onCapture(ks);
        }
      }}
      onBlur={onCancel}
      className="w-full rounded border border-accent bg-subtle px-2 py-0.5 font-mono text-meta focus:outline-none"
    />
  );
}

/**
 * 고른 키를 다른 명령이 쓰고 있을 때 — 조용히 빼앗지 않고 행 아래에서 묻는다.
 * [바꾸기] 에 포커스(Enter = 바꾸기), Esc/[취소] = 원래대로.
 */
export function KeyConflictPrompt({
  keyStr,
  ownerLabel,
  onReplace,
  onCancel,
}: {
  keyStr: string;
  ownerLabel: string;
  onReplace: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  useEscapeTrap(onCancel);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      role="alert"
      className="mx-2 mb-1 flex flex-wrap items-center gap-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-meta text-fg"
    >
      <AlertTriangle size={12} className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1">
        {t("settings.keymap.conflictPrompt", {
          key: displayKey(keyStr),
          command: ownerLabel,
        })}
      </span>
      <button
        type="button"
        onClick={onCancel}
        className="rounded border border-border bg-base px-2 py-0.5 hover:bg-subtle"
      >
        {t("common.cancel")}
      </button>
      <button
        ref={ref}
        type="button"
        onClick={onReplace}
        className="rounded bg-accent px-2 py-0.5 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        {t("settings.keymap.conflictReplace")}
      </button>
    </div>
  );
}
