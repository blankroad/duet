import { useCallback } from "react";
import { useTauri } from "@/hooks/useTauri";
import { useUIDialogs, type DialogState } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import { commands, type Entry, type Location } from "@/types/bindings";
import { childLocation } from "@/lib/entryDnd";
import { revealCreatedEntry } from "@/lib/newEntry";
import { formatErr } from "@/lib/error";
import i18n from "@/i18n";

export function useCreateEntry(
  dialog: DialogState,
  listEntries: (location: Location) => Promise<Entry[]>,
  refreshAffected: (locations: Location[], skipTabId?: string) => void,
) {
  const { call: mkdir } = useTauri("fsMkdir");
  const { call: createFile } = useTauri("fsCreateFile");
  return useCallback(
    async (name: string, edit = false) => {
      if (dialog.kind !== "mkdir" && dialog.kind !== "new-file") return;
      const { parent, tabId } = dialog;
      // Errors propagate to the open dialog; input stays available for correction/retry.
      if (dialog.kind === "mkdir") await mkdir(parent, name);
      else await createFile(parent, name);
      if (useUIDialogs.getState().dialog === dialog)
        useUIDialogs.getState().close();
      const show = useToast.getState().show;
      show(
        i18n.t("dialog.newEntry.created", { name, path: parent.path }),
        "success",
      );
      try {
        const entries = await listEntries(parent);
        revealCreatedEntry(tabId, parent, name, entries);
        refreshAffected([parent], tabId);
      } catch (e) {
        show(
          i18n.t("dialog.newEntry.refreshFailed", { err: formatErr(e) }),
          "error",
        );
      }
      if (edit && dialog.kind === "new-file") {
        try {
          const loc = childLocation(parent, name);
          const result =
            parent.source.kind === "ssh"
              ? await commands.sshEditOpen(loc)
              : await commands.openPath(loc, true);
          if (result.status === "error") throw result.error;
        } catch (e) {
          show(
            i18n.t("dialog.newEntry.editFailed", { err: formatErr(e) }),
            "error",
          );
        }
      }
    },
    [dialog, mkdir, createFile, listEntries, refreshAffected],
  );
}
