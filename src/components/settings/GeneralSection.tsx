import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { commands } from "@/types/bindings";
import type { Settings } from "@/types/bindings";

export function GeneralSection() {
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

  if (loading || !settings) return <div className="text-base text-fg-muted">Loading…</div>;

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={settings.permanent_delete_enabled}
          onChange={togglePermanent}
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="text-base">
            Permanent delete (Shift+Delete) 활성화
          </div>
          <div className="text-meta text-fg-muted">
            CLAUDE.md §3 — 디폴트 OFF. 활성화해도 단어 타이핑 추가 확인 필요.
          </div>
          {settings.permanent_delete_enabled && (
            <div className="mt-1 flex items-center gap-1 text-meta text-danger">
              <AlertTriangle size={11} /> 영구 삭제 위험.
            </div>
          )}
        </div>
      </label>
    </div>
  );
}
