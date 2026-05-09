import * as Dialog from "@radix-ui/react-dialog";
import { Loader } from "lucide-react";

export function ProgressModal({ title }: { title: string }) {
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <Dialog.Title className="text-title font-medium">{title}</Dialog.Title>
          <div className="mt-3 flex items-center gap-2 text-base text-fg-muted">
            <Loader size={14} className="animate-spin" />
            <span>Working…</span>
          </div>
          <Dialog.Description className="sr-only">{title}</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
