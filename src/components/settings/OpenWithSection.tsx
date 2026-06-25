import { useEffect, useState } from "react";
import { X, FolderOpen } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "@/types/bindings";
import { buildSettingsPatch } from "@/lib/settingsPatch";

/** 확장자 정규화 — 소문자, 선두 점 제거, trim. */
function normExt(s: string): string {
  return s.trim().toLowerCase().replace(/^\.+/, "");
}
/** 앱 경로에서 표시용 이름(마지막 컴포넌트). */
function appName(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}

/**
 * 확장자 → 연결 프로그램. 파일 열기(open_path) 시 OS 기본 대신 이 앱으로 연다.
 * 저장은 settings.ext_app_overrides (backend open_path 가 읽음).
 */
export function OpenWithSection() {
  const [map, setMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [ext, setExt] = useState("");

  useEffect(() => {
    let cancelled = false;
    commands.settingsGet().then((r) => {
      if (cancelled) return;
      if (r.status === "ok")
        setMap((r.data.ext_app_overrides ?? {}) as Record<string, string>);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = async (next: Record<string, string>) => {
    setMap(next);
    await commands.settingsSet(buildSettingsPatch({ ext_app_overrides: next }));
  };

  const choose = async () => {
    const e = normExt(ext);
    if (!e) return;
    const picked = await openFileDialog({
      multiple: false,
      title: `Choose a program for .${e}`,
    });
    if (typeof picked === "string") {
      void persist({ ...map, [e]: picked });
      setExt("");
    }
  };
  const remove = (e: string) => {
    const next = { ...map };
    delete next[e];
    void persist(next);
  };

  if (loading) return <div className="text-base text-fg-muted">Loading…</div>;

  const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  const pending = normExt(ext);

  return (
    <div className="space-y-4">
      <div>
        <div className="text-base">
          Open with — default program by extension
        </div>
        <div className="text-meta text-fg-muted">
          Pick which program opens files of a given extension. Falls back to the
          OS default when unset. Type an extension, then choose a program.
        </div>
      </div>

      {entries.length > 0 && (
        <div className="space-y-1">
          {entries.map(([e, app]) => (
            <div
              key={e}
              className="flex items-center gap-2 rounded border border-border px-2 py-1"
            >
              <span className="font-mono text-base">.{e}</span>
              <span className="ml-2 truncate text-base" title={app}>
                {appName(app)}
              </span>
              <span className="ml-auto" />
              <button
                type="button"
                onClick={() => remove(e)}
                aria-label="Remove"
                className="rounded p-1 text-fg-muted hover:bg-border hover:text-fg"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={ext}
          onChange={(e) => setExt(e.target.value)}
          placeholder="extension — e.g. psd"
          spellCheck={false}
          className="w-48 rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          disabled={!pending}
          onClick={() => void choose()}
          className="flex items-center gap-1.5 rounded border border-border px-3 py-1 text-base hover:bg-subtle disabled:opacity-30"
        >
          <FolderOpen size={14} className="text-fg-muted" />
          Choose program…
        </button>
      </div>
    </div>
  );
}
