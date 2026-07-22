import { useEffect } from "react";
import { platform } from "@tauri-apps/plugin-os";
import { usePanes, activeTab, selectDisplayedEntries } from "@/stores/panes";
import { useContextMenu } from "@/stores/contextMenu";
import { childLocation } from "@/lib/entryDnd";
import { warmShellMenu } from "@/lib/shellMenu";
import type { ShellScope } from "@/types/bindings";

/** 커서-멈춤 후 예열까지의 지연 — 빠른 목록 탐색 중 매 항목 예열 폭주 방지. */
const SETTLE_MS = 250;

/**
 * Windows 전용 — 활성 패널 커서가 로컬 파일/폴더에 "멈추면"(디바운스) 그 항목의 셸
 * 컨텍스트 메뉴("More options")를 백엔드 캐시에 미리 채운다(shell_menu_warm). 우클릭
 * 시점엔 백엔드가 캐시에서 즉시 서빙 → QueryContextMenu(제3자 셸 확장, cold 수 초)가
 * 임계경로에서 사라진다. 폴더 이동도 커서 변화로 이어져 자동 재예열된다.
 *
 * 렌더 안전성은 **백엔드가 보장**한다(Open 은 Warm 에 절대 밀리지 않음). 이 훅의 메뉴-
 * 열림 가드는 오직 STA 스레드 점유를 줄이기 위한 것 — 메뉴가 열려 있는 동안 예열을
 * 멈춰, 진행 중인 예열이 우클릭 Open 을 스레드에서 막지 않게 한다.
 *
 * Windows 아니면 완전 no-op(구독조차 안 함). App 에서 1회 마운트.
 */
export function useShellWarm(): void {
  useEffect(() => {
    if (platform() !== "windows") return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastKey = "";

    const settle = () => {
      // 메뉴가 열려 있으면 예열 보류 — 진행 중 예열이 우클릭 Open 을 STA 에서 막지 않게.
      if (useContextMenu.getState().open) return;
      const s = usePanes.getState();
      const tab = activeTab(s, s.activePane);
      // 로컬 패널의 단일 커서 항목만 대상 — 원격/부모(..)는 제외.
      if (tab.location.source.kind !== "local") return;
      const entry = selectDisplayedEntries(s.activePane, s)[tab.cursorIndex];
      if (!entry || entry.name === "..") return;

      const path = String(childLocation(tab.location, entry.name).path);
      const scope: ShellScope = entry.kind === "dir" ? "directory" : "file";
      warmShellMenu(path, scope);
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

    // 메뉴가 열리는 순간 대기 중 예열 예약 취소(STA 점유 최소화).
    const unsubMenu = useContextMenu.subscribe((m) => {
      if (m.open) clearTimeout(timer);
    });

    return () => {
      clearTimeout(timer);
      unsub();
      unsubMenu();
    };
  }, []);
}
