import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import { commands, events } from "@/types/bindings";

/**
 * 폴더 비교 스캔 중 표시 — 누적 항목 수(CompareProgressEvent) + 취소.
 * 취소 시 fsCompareCancel → 진행 중인 fsCompareDirs 가 Cancelled 로 반환되어
 * triggerCompare 가 다이얼로그를 닫는다.
 */
export function CompareScanningDialog() {
  const [scanned, setScanned] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const unlistenP = events.compareProgressEvent.listen(({ payload }) => {
      if (!cancelled) setScanned(payload.scanned);
    });
    return () => {
      cancelled = true;
      void unlistenP.then((u) => u());
    };
  }, []);

  const cancel = () => void commands.fsCompareCancel();

  return (
    <Dialog.Root open onOpenChange={(o) => !o && cancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-xs -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <Dialog.Title className="flex items-center gap-2 text-title font-medium">
            <Loader2 size={15} className="animate-spin text-accent" /> 폴더 비교 중…
          </Dialog.Title>
          <div className="mt-2 text-meta text-fg-muted">
            <b className="text-fg">{scanned.toLocaleString()}</b> 항목 스캔됨
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={cancel}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              취소
            </button>
          </div>
          <Dialog.Description className="sr-only">
            Scanning two directories for differences.
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
