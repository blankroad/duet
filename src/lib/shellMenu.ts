import { createElement } from "react";
import { commands } from "@/types/bindings";
import type { ShellMenuItem, ShellScope } from "@/types/bindings";
import type { MenuEntry } from "@/stores/contextMenu";

/** 셸 항목 아이콘 PNG 바이트 → data URL (.ts 라 JSX 없이 createElement). */
function iconEl(it: ShellMenuItem) {
  const bytes = it.icon;
  if (!bytes || bytes.length === 0) return undefined;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return createElement("img", {
    src: `data:image/png;base64,${btoa(bin)}`,
    alt: "",
    draggable: false,
    className: "h-4 w-4 object-contain",
  });
}

/**
 * Tier 2 셸 컨텍스트 메뉴(IContextMenu) 프론트 통합 — 백엔드가 호스팅한 실제 셸 메뉴
 * 트리를 duet 컨텍스트 메뉴 항목으로 변환한다.
 *
 * 세션 수명은 **백엔드(경로 캐시)가 관리**한다 — FE 는 close 를 보내지 않는다.
 * - 우클릭 = shell_menu_open(path) → 캐시 있으면 즉시, 없으면 빌드. {token, items} 반환.
 * - 커서 멈춤/폴더 변경 = shell_menu_warm(path) → 백그라운드로 캐시 채움(useShellWarm).
 * - 잎 항목 클릭 = shell_menu_invoke(token, id) → 백엔드가 그 파일의 IContextMenu 로 실행.
 */

function toEntries(items: ShellMenuItem[], token: number): MenuEntry[] {
  return items.map((it, i): MenuEntry => {
    if (it.separator) return { kind: "separator" };
    if (it.children.length > 0) {
      return {
        id: `shx:${token}:${it.id}:${i}`,
        label: it.label,
        disabled: it.disabled,
        icon: iconEl(it),
        children: toEntries(it.children, token),
      };
    }
    return {
      id: `shi:${token}:${it.id}:${i}`,
      label: it.label,
      disabled: it.disabled,
      icon: iconEl(it),
      onSelect: () => {
        void commands.shellMenuInvoke(token, it.id);
      },
    };
  });
}

/** 우클릭 — 셸 메뉴를 연다(캐시 있으면 즉시). 항목이 있으면 {token, entries}, 없으면 null. */
export async function openShellMenu(
  path: string,
  scope: ShellScope,
): Promise<{ token: number; entries: MenuEntry[] } | null> {
  const r = await commands.shellMenuOpen(path, scope);
  if (r.status !== "ok" || r.data.items.length === 0) return null;
  return {
    token: r.data.token,
    entries: toEntries(r.data.items, r.data.token),
  };
}

/** 백그라운드 예열 — 그 경로의 셸 메뉴를 미리 빌드해 캐시(fire-and-forget). */
export function warmShellMenu(path: string, scope: ShellScope): void {
  void commands.shellMenuWarm(path, scope);
}
