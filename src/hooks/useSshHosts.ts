import { useEffect } from "react";
import { commands } from "@/types/bindings";
import { useConnections, type Host } from "@/stores/connections";

/**
 * `~/.ssh/config` 호스트 목록을 connections store 로 로드.
 *
 * 파일을 편집해도 앱을 다시 켜야 반영되던 것 — 이제 창에 포커스가 돌아올 때와
 * 사이드바 ⟳ 로 다시 읽는다(파일 watcher 는 후속).
 */
export async function reloadSshHosts(): Promise<void> {
  const result = await commands.sshConfigHosts();
  // DTO 모양이 store Host 와 동일 — 직접 대입. 실패면 기존 목록 유지.
  if (result.status === "ok")
    useConnections.getState().setHosts(result.data as Host[]);
}

export function useSshHosts() {
  useEffect(() => {
    void reloadSshHosts();
    // 다른 앱에서 config 를 고치고 돌아오는 흐름이 가장 흔하다.
    const onFocus = () => void reloadSshHosts();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}
