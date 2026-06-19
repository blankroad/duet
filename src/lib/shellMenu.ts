import { commands } from "@/types/bindings";
import type { ShellMenuItem, ShellScope } from "@/types/bindings";
import type { MenuEntry } from "@/stores/contextMenu";

/**
 * Tier 2 셸 컨텍스트 메뉴(IContextMenu) 프론트 통합 — 백엔드가 호스팅한 실제 셸 메뉴
 * 트리를 duet 컨텍스트 메뉴 항목으로 변환하고, 세션 수명을 관리한다.
 *
 * 세션: shell_menu_open 이 STA 스레드를 띄워 COM 객체를 살려둔 채 선택을 기다린다.
 * - 잎 항목 클릭 = shell_menu_invoke(token, id) → 그 스레드가 InvokeCommand.
 * - 메뉴 닫힘(미선택) = shell_menu_close(token) → 세션 취소.
 *
 * ContextMenu 의 run() 이 close()→onSelect() 순이라, 닫힘 시 무조건 취소하면 invoke 보다
 * 먼저 취소돼버린다. 그래서 invoked 플래그 + 마이크로태스크로 "선택이 없었을 때만" 취소.
 */

let invoked = false;

function toEntries(items: ShellMenuItem[], token: number): MenuEntry[] {
  return items.map((it, i): MenuEntry => {
    if (it.separator) return { kind: "separator" };
    if (it.children.length > 0) {
      return {
        id: `shx:${token}:${it.id}:${i}`,
        label: it.label,
        disabled: it.disabled,
        children: toEntries(it.children, token),
      };
    }
    return {
      id: `shi:${token}:${it.id}:${i}`,
      label: it.label,
      disabled: it.disabled,
      onSelect: () => {
        invoked = true;
        void commands.shellMenuInvoke(token, it.id);
      },
    };
  });
}

/** 셸 메뉴 세션 시작 — 항목이 있으면 {token, entries} 반환, 없으면 null. */
export async function openShellMenu(
  path: string,
  scope: ShellScope,
): Promise<{ token: number; entries: MenuEntry[] } | null> {
  invoked = false;
  const r = await commands.shellMenuOpen(path, scope);
  if (r.status !== "ok" || r.data.items.length === 0) return null;
  return {
    token: r.data.token,
    entries: toEntries(r.data.items, r.data.token),
  };
}

/** 메뉴 닫힘 콜백 — 셸 항목 선택이 없었으면(=invoked false) 세션 취소. */
export function onShellMenuClose(token: number): void {
  // run() 의 close() 직후 onSelect() 가 동기 실행되므로, 한 틱 미뤄 invoked 를 확인.
  queueMicrotask(() => {
    if (!invoked) void commands.shellMenuClose(token);
  });
}
