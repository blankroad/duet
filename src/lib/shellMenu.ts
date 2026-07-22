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
 * 트리를 duet 컨텍스트 메뉴 항목으로 변환하고, 세션 수명을 관리한다.
 *
 * 세션: shell_menu_open 이 STA 스레드를 띄워 COM 객체를 살려둔 채 선택을 기다린다.
 * - 잎 항목 클릭 = shell_menu_invoke(token, id) → 그 스레드가 InvokeCommand.
 * - 메뉴 닫힘(미선택) = shell_menu_close(token) → 세션 취소.
 *
 * ContextMenu 의 run() 이 close()→onSelect() 순이라, 닫힘 시 무조건 취소하면 invoke 보다
 * 먼저 취소돼버린다. 그래서 invoked 기록 + 마이크로태스크로 "선택이 없었을 때만" 취소.
 *
 * invoked 는 token 별로 기록한다(전역 플래그 아님) — 예열(shellPrewarm)로 세션이 여러 개
 * 동시에 살아 있을 수 있어, 어느 세션이 소비됐는지 개별로 판별해야 한다.
 */

const invokedTokens = new Set<number>();

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
        invokedTokens.add(token);
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
  const r = await commands.shellMenuOpen(path, scope);
  if (r.status !== "ok" || r.data.items.length === 0) return null;
  return {
    token: r.data.token,
    entries: toEntries(r.data.items, r.data.token),
  };
}

/**
 * 이 token 이 invoke(선택)됐는지 확인하고 그 기록을 소비(삭제)한다.
 * true 면 백엔드가 invoke 시점에 세션을 이미 파기했으므로 close 를 보내면 안 된다.
 */
export function consumeInvoked(token: number): boolean {
  return invokedTokens.delete(token);
}

/** 셸 메뉴 세션 정리 — 선택이 없었을 때만 백엔드 close (선택 시엔 invoke 가 이미 파기). */
export function closeShellSession(token: number): void {
  // run() 의 close() 직후 onSelect() 가 동기 실행되므로, 한 틱 미뤄 invoked 를 확인.
  queueMicrotask(() => {
    if (!consumeInvoked(token)) void commands.shellMenuClose(token);
  });
}
