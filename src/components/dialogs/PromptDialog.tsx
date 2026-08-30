import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePromptDialog } from "@/stores/promptDialog";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogInput } from "./DialogInput";

/**
 * window.prompt 대체 인풋 다이얼로그 렌더러 — App 루트에 1개 마운트.
 * Enter/OK = 확정, Esc/취소/닫기 = null. 열릴 때 초기값 전체 선택.
 */
export function PromptDialogHost() {
  const { t } = useTranslation();
  const req = usePromptDialog((s) => s.req);
  const settle = usePromptDialog((s) => s.settle);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (req) setValue(req.initial ?? "");
  }, [req]);

  if (!req) return null;

  return (
    <DialogShell
      width="sm"
      title={req.title}
      onClose={() => settle(null)}
      initialFocus={inputRef}
      selectOnFocus
      footer={
        <>
          <DialogButton hint="esc" onClick={() => settle(null)}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton
            tone="primary"
            hint="enter"
            onClick={() => settle(value)}
          >
            {t("common.ok")}
          </DialogButton>
        </>
      }
    >
      <DialogInput
        ref={inputRef}
        type="text"
        value={value}
        placeholder={req.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            settle(value);
          }
        }}
      />
    </DialogShell>
  );
}
