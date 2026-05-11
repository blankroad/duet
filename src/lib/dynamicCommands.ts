import { useEffect } from "react";
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
 */
export function useDynamicCommands(deps: DynamicDeps) {
  const savedHosts = useSavedHosts((s) => s.hosts);
  const bookmarks = useBookmarks((s) => s.items);
  const hostFavorites = useHostFavorites((s) => s.items);
  const userAliases = useUserAliases((s) => s.items);
  const setDynamic = useCommands((s) => s.setDynamic);

  useEffect(() => {
    const cmds: Command[] = [
      ...savedHosts.map((h) => ({
        id: `host.connect:${h.alias}`,
        label: `Connect: ${h.alias}`,
        category: "Connection" as const,
        action: () => deps.onSavedActivate(h),
      })),
      ...bookmarks.map((b) => ({
        id: `bookmark.open:${b.id}`,
        label: `Bookmark: ${b.name}`,
        category: "Navigation" as const,
        action: () => deps.onBookmarkActivate(b.location),
      })),
      ...hostFavorites.map((f) => ({
        id: `favorite.open:${f.id}`,
        label: `${f.host_alias} → ${f.name}`,
        category: "Connection" as const,
        action: () => deps.onFavoriteActivate(f),
      })),
      ...userAliases.map((a) => ({
        id: `alias:${a.id}`,
        label: a.name,
        category: "User" as const,
        action: () => deps.onAliasExecute(a),
      })),
    ];
    setDynamic(cmds);
  }, [savedHosts, bookmarks, hostFavorites, userAliases, setDynamic, deps]);
}
