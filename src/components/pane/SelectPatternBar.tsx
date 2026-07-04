import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckSquare, MinusSquare, X } from "lucide-react";
import { usePanes, type PaneId } from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { useToast } from "@/stores/toast";

/**
 * 패턴 선택 바 (glob-select). PaneFilterBar 아래에 위치.
 *
 * - 평소 숨김. ui.requestSelectPattern(pane, mode) → nonce 증가 시,
 *   해당 pane 바가 열리며 input.focus().
 * - Enter: 패턴을 활성 패널 선택집합에 add/remove 적용 후 닫기(텍스트 유지 — 직후 모드
 *   전환 재적용 편의).
 * - ESC / X / blur: 닫기.
 *
 * 필터(PaneFilterBar)와 독립 — 대상은 항상 현재 표시 항목(displayedEntries).
 */
export function SelectPatternBar({ id }: { id: PaneId }) {
  const { t } = useTranslation();
  const reqPane = useUI((s) => s.selectPatternPane);
  const reqMode = useUI((s) => s.selectPatternMode);
  const nonce = useUI((s) => s.selectPatternNonce);
  const selectByPattern = usePanes((s) => s.selectByPattern);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [pattern, setPattern] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 이 패널로 요청이 오면 열고 모드 반영 + 포커스. nonce 로 매 요청 감지.
  useEffect(() => {
    if (nonce === 0 || reqPane !== id) return;
    setOpen(true);
    setMode(reqMode);
    // 다음 프레임에 포커스 (렌더 후).
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [nonce, reqPane, reqMode, id]);

  if (!open) return null;

  const apply = () => {
    if (pattern.trim().length === 0) return;
    const n = selectByPattern(id, pattern, mode);
    // 매치 항목이 화면 밖이면 하이라이트가 안 보이므로 결과를 토스트로 명시.
    useToast
      .getState()
      .show(
        n === 0
          ? `No matches: ${pattern}`
          : `${n} item${n === 1 ? "" : "s"} ${mode === "add" ? "selected" : "deselected"}`,
      );
  };

  const isAdd = mode === "add";

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-subtle px-2 text-base">
      {isAdd ? (
        <CheckSquare size={11} className="shrink-0 text-accent" />
      ) : (
        <MinusSquare size={11} className="shrink-0 text-fg-muted" />
      )}
      <span className="shrink-0 text-base text-fg-muted">
        {isAdd ? t("selectPattern.select") : t("selectPattern.deselect")}
      </span>
      <input
        ref={inputRef}
        type="text"
        value={pattern}
        onChange={(e) => setPattern(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          } else if (e.key === "Enter") {
            e.preventDefault();
            apply();
            setOpen(false);
          }
        }}
        onBlur={() => setOpen(false)}
        placeholder={t("selectPattern.placeholder")}
        className="flex-1 bg-transparent font-mono text-base focus:outline-none"
      />
      <button
        type="button"
        onMouseDown={(e) => {
          // blur 로 닫히기 전에 적용.
          e.preventDefault();
          apply();
          setOpen(false);
        }}
        className="rounded px-1 py-0.5 text-base text-fg-muted hover:bg-border"
      >
        {t("common.apply")}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded p-0.5 text-fg-muted hover:bg-border"
        aria-label="Close"
      >
        <X size={11} />
      </button>
    </div>
  );
}
