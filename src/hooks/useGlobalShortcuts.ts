import { useEffect } from "react";
import { useKeymap } from "@/stores/keymap";
import { useAllCommands } from "@/stores/commands";
import { formatKeyEvent } from "@/lib/keyEvent";
import { useContextMenu } from "@/stores/contextMenu";

/**
 * 단축키 처리 — keymap binding 우선, 없으면 command.defaultKey 매칭.
 *
 * 모든 command action 은 store 에 등록된 것 그대로 호출. 이전 hardcoded
 * switch 제거.
 *
 * input/textarea 차단: command.allowInInput 으로 옵트인.
 */
export function useGlobalShortcuts() {
  const bindings = useKeymap((s) => s.bindings);
  const commands = useAllCommands();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isInput = tag === "input" || tag === "textarea";

      const keystr = formatKeyEvent(e);
      if (!keystr) return;
      // 우클릭 메뉴가 열려 있으면 그 메뉴가 키를 처리 — 전역 단축키는 보류.
      if (useContextMenu.getState().open) return;

      // override 우선
      const binding = bindings.find((b) => b.key === keystr);
      let commandId = binding?.command_id;

      if (!commandId) {
        const cmd = commands.find((c) => c.defaultKey === keystr);
        commandId = cmd?.id;
      }

      if (!commandId) return;

      const cmd = commands.find((c) => c.id === commandId);
      if (!cmd) return;

      if (isInput && !cmd.allowInInput) return;

      e.preventDefault();
      cmd.action();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bindings, commands]);
}
