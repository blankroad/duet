import { useEffect } from "react";
import { useKeymap } from "@/stores/keymap";
import { useAllCommands } from "@/stores/commands";
import { formatKeyEvent } from "@/lib/keyEvent";
import { useContextMenu } from "@/stores/contextMenu";

/**
 * WebView2/브라우저 기본 단축키 중 앱을 막거나(프린트 다이얼로그) 상태를 날리는
 * (하드 리로드) 것들 — 앱에 바인딩이 없어도 preventDefault 로 삼켜 네이티브 동작을 막는다.
 * (프린트 다이얼로그가 웹뷰를 blocking 해 "먹통" 되던 버그.)
 */
const SWALLOW_WEBVIEW_DEFAULTS = new Set([
  "Ctrl+P",
  "Ctrl+Shift+P", // 프린트
  "Ctrl+Shift+R", // 하드 리로드(웹뷰 새로고침 — 상태 소실)
  "Ctrl+U", // 소스 보기
  "Ctrl+J", // 다운로드
  "Ctrl+O", // 파일 열기
  "Ctrl+S", // 페이지 저장
  "Ctrl+G",
  "Ctrl+Shift+G", // 찾기 다음/이전
  "F7", // 캐럿 브라우징
]);

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
        const cmd = commands.find(
          (c) => c.defaultKey === keystr || c.altKeys?.includes(keystr),
        );
        commandId = cmd?.id;
      }

      // 앱 커맨드가 없으면: WebView2 기본 동작(프린트 등)이면 삼키고, 아니면 통과.
      if (!commandId) {
        if (SWALLOW_WEBVIEW_DEFAULTS.has(keystr)) e.preventDefault();
        return;
      }

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
