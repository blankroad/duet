import { useEffect } from "react";
import { commands } from "@/types/bindings";
import { useConnections, type Host } from "@/stores/connections";

/**
 * `~/.ssh/config` 호스트 목록을 한 번 로드해 connections store 에 저장.
 *
 * 마운트 1회만 — App 부트스트랩에서 호출. ssh config 파일 변경 자동 반영은
 * 후속 (file watcher 또는 명시 refresh 버튼).
 */
export function useSshHosts() {
  const setHosts = useConnections((s) => s.setHosts);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await commands.sshConfigHosts();
      if (cancelled) return;
      if (result.status === "ok") {
        // DTO 모양이 store Host 와 동일 — 직접 대입.
        setHosts(result.data as Host[]);
      }
      // status === "error" 면 빈 hosts 유지 (Sidebar 가 "(no hosts)" 표시).
    })();
    return () => {
      cancelled = true;
    };
  }, [setHosts]);
}
