import { useToast } from "@/stores/toast";

export function Toast() {
  const message = useToast((s) => s.message);
  if (!message) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      <div className="rounded-md border border-border bg-base px-3 py-1.5 text-base shadow-lg">
        {message}
      </div>
    </div>
  );
}
