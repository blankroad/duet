import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useUserAliases, addUserAlias, removeUserAlias } from "@/stores/userAliases";
import { useSavedHosts } from "@/stores/savedHosts";
import { usePanes, activeTab } from "@/stores/panes";
import type { AliasKind } from "@/types/bindings";

export function AliasesSection() {
  const items = useUserAliases((s) => s.items);
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_5rem_1fr_2rem] gap-2 border-b border-border px-2 py-1 text-meta text-fg-muted">
        <div>Name</div>
        <div>Kind</div>
        <div>Target</div>
        <div></div>
      </div>
      {items.map((a) => (
        <div
          key={a.id}
          className="grid grid-cols-[1fr_5rem_1fr_2rem] items-center gap-2 px-2 py-0.5 text-base hover:bg-subtle"
        >
          <div className="truncate">{a.name}</div>
          <div className="text-meta text-fg-muted">{a.kind.kind}</div>
          <div className="truncate font-mono text-meta">
            {a.kind.kind === "navigate"
              ? `${a.kind.location.source.kind === "ssh" ? "ssh:" : ""}${a.kind.location.path}`
              : a.kind.saved_host_alias}
          </div>
          <button
            type="button"
            onClick={() => void removeUserAlias(a.id)}
            className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-danger"
            aria-label="Remove alias"
          >
            <X size={11} />
          </button>
        </div>
      ))}
      {adding ? (
        <AddForm onClose={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 rounded border border-dashed border-border px-2 py-1 text-meta text-fg-muted hover:bg-subtle"
        >
          <Plus size={11} /> Add alias
        </button>
      )}
    </div>
  );
}

function AddForm({ onClose }: { onClose: () => void }) {
  const savedHosts = useSavedHosts((s) => s.hosts);
  const [name, setName] = useState("");
  const [kindStr, setKindStr] = useState<"navigate" | "connect">("navigate");
  const tab = usePanes((s) => activeTab(s, s.activePane));
  const [savedHost, setSavedHost] = useState<string>(savedHosts[0]?.alias ?? "");

  const submit = async () => {
    if (!name.trim()) return;
    let kind: AliasKind;
    if (kindStr === "navigate") {
      kind = { kind: "navigate", location: tab.location };
    } else {
      if (!savedHost) return;
      kind = { kind: "connect", saved_host_alias: savedHost };
    }
    await addUserAlias(name.trim(), kind);
    onClose();
  };

  return (
    <div className="rounded border border-accent bg-subtle p-2">
      <div className="grid grid-cols-[5rem_1fr] items-center gap-2 text-base">
        <label htmlFor="alias-name" className="text-fg-muted">Name</label>
        <input
          id="alias-name"
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-border bg-base px-2 py-1 font-mono"
        />
        <label htmlFor="alias-kind" className="text-fg-muted">Kind</label>
        <select
          id="alias-kind"
          value={kindStr}
          onChange={(e) => setKindStr(e.target.value as "navigate" | "connect")}
          className="rounded border border-border bg-base px-2 py-1"
        >
          <option value="navigate">Navigate (active tab location)</option>
          <option value="connect">Connect (saved host)</option>
        </select>
        {kindStr === "navigate" ? (
          <>
            <div className="text-fg-muted">Target</div>
            <div className="truncate font-mono text-meta text-fg-muted">{tab.location.path}</div>
          </>
        ) : (
          <>
            <label htmlFor="alias-host" className="text-fg-muted">Host</label>
            <select
              id="alias-host"
              value={savedHost}
              onChange={(e) => setSavedHost(e.target.value)}
              className="rounded border border-border bg-base px-2 py-1"
            >
              {savedHosts.length === 0 ? (
                <option value="">(no saved hosts)</option>
              ) : (
                savedHosts.map((h) => <option key={h.alias} value={h.alias}>{h.alias}</option>)
              )}
            </select>
          </>
        )}
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border px-3 py-1 text-base hover:bg-base"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          className="rounded bg-accent px-3 py-1 text-base text-white"
        >
          Add
        </button>
      </div>
    </div>
  );
}
