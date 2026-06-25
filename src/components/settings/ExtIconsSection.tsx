import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { commands } from "@/types/bindings";
import { buildSettingsPatch } from "@/lib/settingsPatch";
import { ICON_PALETTE, paletteIcon } from "@/lib/iconPalette";
import { useAppSettings } from "@/stores/settings";

/** 확장자 정규화 — 소문자, 선두 점 제거, trim. */
function normExt(s: string): string {
  return s.trim().toLowerCase().replace(/^\.+/, "");
}

/**
 * 확장자 → 아이콘 지정. 내장 매핑보다 우선. 색은 팔레트 아이콘에 따라온다.
 * 저장은 settings.ext_icon_overrides, 즉시 반영은 useAppSettings.
 */
export function ExtIconsSection() {
  const [map, setMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [ext, setExt] = useState("");

  useEffect(() => {
    let cancelled = false;
    commands.settingsGet().then((r) => {
      if (cancelled) return;
      if (r.status === "ok")
        setMap((r.data.ext_icon_overrides ?? {}) as Record<string, string>);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = async (next: Record<string, string>) => {
    setMap(next);
    useAppSettings.getState().setExtIconOverrides(next); // 리스트 즉시 반영
    await commands.settingsSet(
      buildSettingsPatch({ ext_icon_overrides: next }),
    );
  };

  const assign = (iconName: string) => {
    const e = normExt(ext);
    if (!e) return;
    void persist({ ...map, [e]: iconName });
    setExt("");
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
        <div className="text-base">Custom file icons</div>
        <div className="text-meta text-fg-muted">
          Assign an icon to a file extension — overrides the built-in icon. Type
          an extension, then click a shape (its color comes with it).
        </div>
      </div>

      {entries.length > 0 && (
        <div className="space-y-1">
          {entries.map(([e, name]) => {
            const desc = paletteIcon(name);
            return (
              <div
                key={e}
                className="flex items-center gap-2 rounded border border-border px-2 py-1"
              >
                {desc && (
                  <desc.Icon
                    size={16}
                    className={`shrink-0 ${desc.className}`}
                  />
                )}
                <span className="font-mono text-base">.{e}</span>
                <span className="ml-auto text-meta text-fg-muted">{name}</span>
                <button
                  type="button"
                  onClick={() => remove(e)}
                  aria-label="Remove"
                  className="rounded p-1 text-fg-muted hover:bg-border hover:text-fg"
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-2">
        <input
          value={ext}
          onChange={(e) => setExt(e.target.value)}
          placeholder="extension — e.g. pptx"
          spellCheck={false}
          className="w-48 rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
        />
        <div className="text-meta text-fg-muted">
          {pending
            ? `Pick an icon for .${pending}:`
            : "Type an extension above, then click an icon."}
        </div>
        <div className="grid grid-cols-8 gap-1">
          {ICON_PALETTE.map((p) => (
            <button
              key={p.name}
              type="button"
              disabled={!pending}
              onClick={() => assign(p.name)}
              title={p.name}
              aria-label={p.name}
              className="flex items-center justify-center rounded border border-transparent p-1.5 hover:border-accent hover:bg-subtle disabled:opacity-30"
            >
              <p.Icon size={18} className={p.className} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
