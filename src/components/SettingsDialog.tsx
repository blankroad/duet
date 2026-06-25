import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { GeneralSection } from "./settings/GeneralSection";
import { KeymapSection } from "./settings/KeymapSection";
import { AliasesSection } from "./settings/AliasesSection";
import { ExtIconsSection } from "./settings/ExtIconsSection";
import { OpenWithSection } from "./settings/OpenWithSection";

type SectionId = "general" | "icons" | "openwith" | "keymap" | "aliases";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "icons", label: "File icons" },
  { id: "openwith", label: "Open with" },
  { id: "keymap", label: "Keymap" },
  { id: "aliases", label: "Aliases" },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("general");

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[32rem] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-base shadow-lg focus:outline-none">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <Dialog.Title className="text-title font-medium">Settings</Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>
          <div className="flex flex-1 min-h-0">
            <aside className="w-32 shrink-0 border-r border-border bg-subtle p-2">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSection(s.id)}
                  className={`w-full rounded px-2 py-1 text-left text-base ${
                    section === s.id ? "bg-active text-fg" : "text-fg-muted hover:bg-border"
                  }`}
                >
                  {s.label}
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
          <Dialog.Description className="sr-only">Application settings</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
