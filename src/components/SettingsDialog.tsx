import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react";
import clsx from "clsx";
import { DialogShell } from "./dialogs/DialogShell";
import { DialogButton } from "./dialogs/DialogButton";
import { GeneralSection } from "./settings/GeneralSection";
import { KeymapSection } from "./settings/KeymapSection";
import { AliasesSection } from "./settings/AliasesSection";
import { ExtIconsSection } from "./settings/ExtIconsSection";
import { OpenWithSection } from "./settings/OpenWithSection";

type SectionId = "general" | "icons" | "openwith" | "keymap" | "aliases";

// label 은 i18n 키 — 렌더 시 t() 로 해석.
const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "general", label: "settings.nav.general" },
  { id: "icons", label: "settings.nav.fileIcons" },
  { id: "openwith", label: "settings.nav.openWith" },
  { id: "keymap", label: "settings.nav.keymap" },
  { id: "aliases", label: "settings.nav.aliases" },
];

/** 설정 — 왼쪽 섹션 내비 + 오른쪽 내용. 높이 고정(섹션 전환 시 창 크기 불변). */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [section, setSection] = useState<SectionId>("general");

  return (
    <DialogShell
      width="xl"
      height="tall"
      bodyFill
      bodyPadding={false}
      divided
      title={t("settings.title")}
      description="Application settings"
      icon={Settings}
      onClose={onClose}
      footer={
        <DialogButton hint="esc" onClick={onClose}>
          {t("common.close")}
        </DialogButton>
      }
    >
      <div className="flex min-h-0 flex-1">
        <aside className="w-32 shrink-0 border-r border-border bg-subtle p-2">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={clsx(
                "w-full rounded px-2 py-1 text-left text-base",
                section === s.id
                  ? "bg-active text-fg"
                  : "text-fg-muted hover:bg-border",
              )}
            >
              {t(s.label)}
            </button>
          ))}
        </aside>
        <main className="flex-1 overflow-auto p-4">
          {section === "general" && <GeneralSection />}
          {section === "icons" && <ExtIconsSection />}
          {section === "openwith" && <OpenWithSection />}
          {section === "keymap" && <KeymapSection />}
          {section === "aliases" && <AliasesSection />}
        </main>
      </div>
    </DialogShell>
  );
}
