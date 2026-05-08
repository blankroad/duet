import { Folder, Server, Star } from "lucide-react";
import { useUI } from "@/stores/ui";
import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * MVP-0: placeholder. 토글만 동작.
 * MVP-1에서 호스트 목록, MVP-6에서 북마크 채워짐.
 */
export function Sidebar() {
  const open = useUI((s) => s.sidebarOpen);
  if (!open) return null;

  return (
    <aside className="flex w-48 flex-col border-r border-border bg-subtle text-base">
      <Section title="Local" icon={<Folder size={14} />}>
        <Item label="Home" />
      </Section>
      <Section title="Hosts" icon={<Server size={14} />}>
        <Item label="(MVP-1)" muted />
      </Section>
      <Section title="Bookmarks" icon={<Star size={14} />}>
        <Item label="(MVP-6)" muted />
      </Section>
    </aside>
  );
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="border-b border-border px-2 py-1">
      <div className="flex items-center gap-1 text-meta text-fg-muted">
        {icon}
        <span>{title}</span>
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Item({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <div className={clsx("rounded px-2 py-0.5 hover:bg-border", muted && "text-fg-muted")}>
      {label}
    </div>
  );
}
