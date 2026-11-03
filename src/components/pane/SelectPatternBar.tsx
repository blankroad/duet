import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckSquare, MinusSquare, X } from "lucide-react";
import { usePanes, type PaneId } from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { useToast } from "@/stores/toast";

const BAR_BUTTON =
  "flex h-6 shrink-0 items-center justify-center gap-1 rounded text-fg-muted hover:bg-border hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

/**
 * 패턴 선택 바 (glob-select). PaneFilterBar 아래에 위치.
 *
 * - 평소 숨김. ui.requestSelectPattern(pane, mode) → nonce 증가 시,
 *   해당 pane 바가 열리며 input.focus().
 * - Enter / 적용: 패턴을 활성 패널 선택집합에 add/remove 적용 후 닫기(텍스트 유지 — 직후 모드
 *   전환 재적용 편의).
 * - 모드 버튼: 선택 ↔ 선택 해제 전환.
 * - ESC / X / 바 밖으로 포커스 이동: 닫기. 바 안의 버튼으로 Tab 이동은 닫지 않는다.
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

  const isAdd = mode === "add";
  const apply = () => {
    if (pattern.trim().length === 0) return;
    const n = selectByPattern(id, pattern, mode);
    // 매치 항목이 화면 밖이면 하이라이트가 안 보이므로 결과를 토스트로 명시.
    useToast.getState().show(
      n === 0
        ? t("selectPattern.noMatch", { pattern })
        : t(isAdd ? "selectPattern.selected" : "selectPattern.deselected", {
            count: n,
          }),
    );
  };
  const keepInputFocus = (e: React.MouseEvent) => e.preventDefault();
  const applyAndClose = () => {
    apply();
    setOpen(false);
  };

  return (
    <div
      className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-subtle px-2 text-base"
      onBlur={(e) => {
        // 바 안(적용·모드·닫기 버튼)으로 옮기는 포커스는 닫지 않는다 — 키보드로 닿게.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        // WebKit(macOS)은 클릭한 버튼에 포커스를 주지 않아 blur 의 relatedTarget 이
        // null → 바가 닫혀 click 이 사라진다. 입력 포커스를 유지해 클릭이 실행되게.
        onMouseDown={keepInputFocus}
        className={`${BAR_BUTTON} px-1`}
        onClick={() => {
          setMode(isAdd ? "remove" : "add");
          inputRef.current?.focus();
        }}
        title={t("selectPattern.switchMode")}
      >
        {isAdd ? (
          <CheckSquare size={12} className="shrink-0 text-accent" />
        ) : (
          <MinusSquare size={12} className="shrink-0 text-fg-muted" />
        )}
        <span className="text-base">
          {isAdd ? t("selectPattern.select") : t("selectPattern.deselect")}
        </span>
      </button>
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
            applyAndClose();
          }
        }}
        placeholder={t("selectPattern.placeholder")}
        aria-label={
          isAdd ? t("selectPattern.select") : t("selectPattern.deselect")
        }
        className="min-w-0 flex-1 bg-transparent font-mono text-base focus:outline-none"
      />
      <button
        type="button"
        // WebKit(macOS)은 클릭한 버튼에 포커스를 주지 않아 blur 의 relatedTarget 이
        // null → 바가 닫혀 click 이 사라진다. 입력 포커스를 유지해 클릭이 실행되게.
        onMouseDown={keepInputFocus}
        onClick={applyAndClose}
        className={`${BAR_BUTTON} px-1.5 text-base`}
      >
        {t("common.apply")}
      </button>
      <button
        type="button"
        // WebKit(macOS)은 클릭한 버튼에 포커스를 주지 않아 blur 의 relatedTarget 이
        // null → 바가 닫혀 click 이 사라진다. 입력 포커스를 유지해 클릭이 실행되게.
        onMouseDown={keepInputFocus}
        onClick={() => setOpen(false)}
        className={`${BAR_BUTTON} w-6`}
        aria-label={t("common.close")}
        title={t("common.close")}
      >
        <X size={12} />
      </button>
    </div>
  );
}
