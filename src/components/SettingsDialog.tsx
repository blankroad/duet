import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, AlertTriangle } from "lucide-react";
import { commands } from "@/types/bindings";
import type { Settings } from "@/types/bindings";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    commands.settingsGet().then((r) => {
      if (cancelled) return;
      if (r.status === "ok") setSettings(r.data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const togglePermanent = async () => {
    if (!settings) return;
    const next = !settings.permanent_delete_enabled;
    const r = await commands.settingsSet({ permanent_delete_enabled: next });
    if (r.status === "ok") setSettings(r.data);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">Settings</Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>
          {loading || !settings ? (
            <div className="text-base text-fg-muted">Loading…</div>
          ) : (
            <div className="space-y-3">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={settings.permanent_delete_enabled}
                  onChange={togglePermanent}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-base">
                    Enable permanent delete (Shift+Delete)
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 text-meta text-danger">
                    <AlertTriangle size={11} />
                    Permanent delete is irreversible. Word typing still required.
                  </span>
                </span>
              </label>
            </div>
          )}
          <Dialog.Description className="sr-only">Application settings</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
