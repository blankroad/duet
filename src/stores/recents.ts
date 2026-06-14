import { create } from "zustand";
import type { Location } from "@/types/bindings";
import { useConnections } from "@/stores/connections";

/**
 * 최근 방문 폴더 — 전역, 저큐레이션, localStorage 영속(자격증명 아닌 경로 메타라 §5 무관).
 * SSH 는 (alias, path) 로 저장해 재접속에서도 유효(connection_id 안 박음).
 */
export type RecentEntry =
  | { source: "local"; path: string; label: string }
  | { source: "ssh"; alias: string; path: string; label: string };

const KEY = "duet.recents";
const CAP = 12;

function recentKey(e: RecentEntry): string {
  return e.source === "ssh" ? `ssh:${e.alias}:${e.path}` : `local:${e.path}`;
}

function load(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RecentEntry[]) : [];
  } catch {
    return [];
  }
}
function save(items: RecentEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* localStorage 불가 환경 — 메모리만 */
  }
}

interface State {
  items: RecentEntry[];
  add: (e: RecentEntry) => void;
  clear: () => void;
}

export const useRecents = create<State>((set) => ({
  items: load(),
  add: (e) =>
    set((s) => {
      const k = recentKey(e);
      const items = [e, ...s.items.filter((x) => recentKey(x) !== k)].slice(0, CAP);
      save(items);
      return { items };
    }),
  clear: () => {
    save([]);
    set({ items: [] });
  },
}));

/** 성공한 navigate 직후 호출 — 최근 목록에 기록 (루트 제외). */
export function recordRecent(location: Location): void {
  const path = String(location.path);
  if (path === "/" || path.length === 0) return;
  const label = path.split("/").filter(Boolean).pop() ?? path;
  if (location.source.kind === "local") {
    useRecents.getState().add({ source: "local", path, label });
    return;
  }
  const connId = location.source.connection_id;
  const conn = Object.values(useConnections.getState().active).find((c) => c.id === connId);
  if (conn) useRecents.getState().add({ source: "ssh", alias: conn.alias, path, label });
}
