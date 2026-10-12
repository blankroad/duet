import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FilePlus2, FolderPlus } from "lucide-react";
import { platform } from "@tauri-apps/plugin-os";
import type { Location } from "@/types/bindings";
import { useHostLabel } from "@/lib/hostLabel";
import { validateEntryName } from "@/lib/newEntry";
import { formatErr } from "@/lib/error";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogInput } from "./DialogInput";

export interface NewEntryDialogProps {
  kind: "dir" | "file";
  parent: Location;
  onClose: () => void;
  onSubmit: (name: string, edit?: boolean) => void | Promise<void>;
}

export function NewEntryDialog({
  kind,
  parent,
  onClose,
  onSubmit,
}: NewEntryDialogProps) {
  const { t } = useTranslation();
  const host = useHostLabel(parent.source);
  const k = kind === "dir" ? "mkdir" : "newFile";
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const invalid = name
    ? validateEntryName(
        name,
        parent.source.kind === "local" && platform() === "windows",
      )
    : null;
  const close = () => {
    if (!busy.current) onClose();
  };
  const submit = async (edit = false) => {
    if (busy.current || !name.trim() || invalid) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await onSubmit(name, edit);
    } catch (e) {
      const detail = formatErr(e);
      setError(
        /already exists|file exists/i.test(detail)
          ? t("dialog.newEntry.exists")
          : detail,
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const message = error ?? (invalid ? t(`dialog.newEntry.${invalid}`) : null);
  return (
    <DialogShell
      width="sm"
      title={t(`dialog.${k}.title`)}
      subtitle={
        <span title={`${host} · ${parent.path}`}>
          {host} · {parent.path}
        </span>
      }
      description={t(`dialog.${k}.desc`, { path: parent.path })}
      icon={kind === "dir" ? FolderPlus : FilePlus2}
      onClose={close}
      initialFocus={inputRef}
      dismissOnOutsideClick={!pending}
      footer={
        <>
          <DialogButton hint="esc" disabled={pending} onClick={close}>
            {t("common.cancel")}
          </DialogButton>
          {kind === "file" && (
            <DialogButton
              disabled={pending || !name.trim() || !!invalid}
              onClick={() => void submit(true)}
            >
              {t("dialog.newEntry.createAndEdit")}
            </DialogButton>
          )}
          <DialogButton
            tone="primary"
            hint="enter"
            disabled={pending || !name.trim() || !!invalid}
            onClick={() => void submit()}
          >
            {pending ? t("dialog.newEntry.creating") : t(`dialog.${k}.create`)}
          </DialogButton>
        </>
      }
    >
      <DialogInput
        ref={inputRef}
        mono
        type="text"
        value={name}
        disabled={pending}
        aria-label={t(`dialog.${k}.placeholder`)}
        aria-invalid={!!message}
        aria-describedby={message ? errorId : undefined}
        placeholder={t(`dialog.${k}.placeholder`)}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {message && (
        <p
          id={errorId}
          role="alert"
          className="text-meta text-danger [overflow-wrap:anywhere]"
        >
          {message}
        </p>
      )}
    </DialogShell>
  );
}
