import { useCommands } from "@/stores/commands";
import { useKeymap, effectiveKey } from "@/stores/keymap";
import { displayKey } from "@/lib/keyDisplay";

/**
 * 커맨드의 **현재** 단축키를 화면 표기로 — 툴팁·메뉴가 리바인딩을 따라가게.
 *
 * 예전에는 i18n 문자열과 컴포넌트에 "(F5)", "Ctrl+H" 처럼 박아 둬서, 키를 바꾼
 * 사용자에게 UI 가 옛 키를 가르쳤다(팔레트·치트시트만 정확했다).
 */
export function useKeyHint(commandId: string): string {
  const bindings = useKeymap((s) => s.bindings);
  const builtins = useCommands((s) => s.builtins);
  const dynamic = useCommands((s) => s.dynamic);
  const cmd =
    builtins.find((c) => c.id === commandId) ??
    dynamic.find((c) => c.id === commandId);
  const key = effectiveKey(commandId, bindings, cmd?.defaultKey);
  return key ? displayKey(key) : "";
}
