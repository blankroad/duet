import { useEffect } from "react";
import { platform } from "@tauri-apps/plugin-os";
import { usePanes, activeTab, selectDisplayedEntries } from "@/stores/panes";
import { childLocation } from "@/lib/entryDnd";
import { prewarmShellMenu, resetShellPrewarm } from "@/lib/shellPrewarm";
import type { ShellScope } from "@/types/bindings";

/** 커서-멈춤 후 예열까지의 지연 — 빠른 목록 탐색 중 매 항목 빌드 폭주 방지. */
const SETTLE_MS = 250;

/**
 * Windows 전용 — 활성 패널 커서가 로컬 파일/폴더에 "멈추면"(디바운스) 그 항목의 셸
 * 컨텍스트 메뉴("More options")를 백그라운드로 미리 빌드해 둔다. 우클릭 시점엔 이미
 * 완성돼 있어 cold ~800ms(측정치) 지연이 사라진다. 비용 근거·수명 관리는 shellPrewarm.
 *
 * Windows 아니면 완전 no-op(구독조차 안 함). App 에서 1회 마운트.
 */
export function useShellPrewarm(): void {
  useEffect(() => {
    if (platform() !== "windows") return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastKey = "";

    const settle = () => {
      const s = usePanes.getState();
      const tab = activeTab(s, s.activePane);
      // 로컬 패널의 단일 커서 항목만 대상 — 원격/다중선택/부모(..)는 제외.
      if (tab.location.source.kind !== "local") return resetShellPrewarm();
      const entry = selectDisplayedEntries(s.activePane, s)[tab.cursorIndex];
      if (!entry || entry.name === "..") return resetShellPrewarm();

      const path = String(childLocation(tab.location, entry.name).path);
      const scope: ShellScope = entry.kind === "dir" ? "directory" : "file";
      prewarmShellMenu(path, scope);
    };

    // 커서/폴더가 바뀔 때만 디바운스 재예열 — 무관한 store 변경은 키 비교로 걸러낸다.
    const unsub = usePanes.subscribe((s) => {
      const tab = activeTab(s, s.activePane);
      const entry = selectDisplayedEntries(s.activePane, s)[tab.cursorIndex];
      const key = `${s.activePane}|${String(tab.location.path)}|${entry?.name ?? ""}`;
      if (key === lastKey) return;
      lastKey = key;
      clearTimeout(timer);
      timer = setTimeout(settle, SETTLE_MS);
    });

    return () => {
      clearTimeout(timer);
      unsub();
      resetShellPrewarm();
    };
  }, []);
}
