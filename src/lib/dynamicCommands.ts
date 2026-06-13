import { useEffect, useRef } from "react";
import { useCommands } from "@/stores/commands";
import { useSavedHosts } from "@/stores/savedHosts";
import { useBookmarks } from "@/stores/bookmarks";
import { useHostFavorites } from "@/stores/hostFavorites";
import { useUserAliases } from "@/stores/userAliases";
import type { Command } from "@/lib/commands";
import type { Location, SavedHost, HostFavorite, UserAlias } from "@/types/bindings";

export interface DynamicDeps {
  onSavedActivate: (host: SavedHost) => void;
  onBookmarkActivate: (location: Location) => void;
  onFavoriteActivate: (favorite: HostFavorite) => void;
  onAliasExecute: (alias: UserAlias) => void;
}

/**
 * 4 store subscribe → useCommands.setDynamic.
 *
 * deps 는 ref 로 보관 — App 이 inline 객체 전달하므로 deps 자체는 deps array
 * 에 포함하면 안 됨 (무한 루프). store 변경 시에만 재계산.
 */
export function useDynamicCommands(deps: DynamicDeps) {
  const savedHosts = useSavedHosts((s) => s.hosts);
  const bookmarks = useBookmarks((s) => s.items);
  const hostFavorites = useHostFavorites((s) => s.items);
  const userAliases = useUserAliases((s) => s.items);
  const setDynamic = useCommands((s) => s.setDynamic);

  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const d = depsRef.current;
    const cmds: Command[] = [
      ...savedHosts.map((h) => ({
        id: `host.connect:${h.alias}`,
        label: `Connect: ${h.alias}`,
        category: "Connection" as const,
        action: () => depsRef.current.onSavedActivate(h),
      })),
      ...bookmarks.map((b) => ({
        id: `bookmark.open:${b.id}`,
        label: `Bookmark: ${b.name}`,
        category: "Navigation" as const,
        action: () => depsRef.current.onBookmarkActivate(b.location),
      })),
      ...hostFavorites.map((f) => ({
        id: `favorite.open:${f.id}`,
        label: `${f.host_alias} → ${f.name}`,
        category: "Connection" as const,
        action: () => depsRef.current.onFavoriteActivate(f),
      })),
      ...userAliases.map((a) => ({
        id: `alias:${a.id}`,
        label: a.name,
        category: "User" as const,
        action: () => depsRef.current.onAliasExecute(a),
      })),
    ];
    void d; // eslint: 직접 capture 안 하지만 ref 통해 사용
    setDynamic(cmds);
  }, [savedHosts, bookmarks, hostFavorites, userAliases, setDynamic]);
}
