import { useEffect } from "react";
import { platform } from "@tauri-apps/plugin-os";
import {
  usePanes,
  activeTab,
  selectDisplayedEntries,
  type PaneId,
} from "@/stores/panes";
import { useContextMenu } from "@/stores/contextMenu";
import { childLocation } from "@/lib/entryDnd";
import { onHoverEntry } from "@/lib/hoverSignal";
import { warmShellMenu } from "@/lib/shellMenu";
import type { Entry, ShellScope } from "@/types/bindings";

/** 커서-멈춤 후 예열까지의 지연 — 빠른 목록 탐색 중 매 항목 예열 폭주 방지. */
const CURSOR_SETTLE_MS = 250;
/** 호버-멈춤 후 예열까지의 지연 — 마우스가 지나가기만 한 행은 예열하지 않게. */
const HOVER_SETTLE_MS = 150;

/** 예열 신호 종류 — 서로 타이머를 뺏지 않게 슬롯별로 독립 디바운스. */
type Slot = "cursor" | "hover" | "background";

/**
 * Windows 전용 — 곧 우클릭될 법한 대상의 셸 컨텍스트 메뉴("More options")를 백엔드
 * 캐시에 미리 채운다(shell_menu_warm). 우클릭 시점엔 백엔드가 스냅샷에서 즉시 서빙 →
 * QueryContextMenu(제3자 보안/클라우드 셸 확장, cold 300~5000ms)가 임계경로에서 빠진다.
 *
 * 예열 신호 3종:
 * - **호버**: 마우스 경로의 유일한 lead time. 우클릭 자체는 예열 기회가 없다 —
 *   우클릭 핸들러의 `setCursor` 로 예약된 커서 예열이 같은 tick 의 `openAt`(메뉴 열림)에
 *   곧바로 취소돼, 마우스 사용자에겐 예열이 **한 번도** 안 걸렸다.
 * - **커서**: 키보드 이동 → Shift+F10 경로.
 * - **배경**: 폴더의 빈 영역 메뉴(scope=background). 예열 대상이 아예 아니라 늘 cold 였다.
 *
 * 렌더 안전성은 백엔드가 보장한다(Open 은 Warm 에 절대 밀리지 않고, 캐시 히트는 STA 큐를
 * 거치지 않는다). 이 훅의 메뉴-열림 가드는 두 가지 목적: STA 점유를 줄이고, 지금 열려 있는
 * 메뉴의 COM 세션이 재빌드로 파기돼 클릭이 무시되는 걸 막는다.
 *
 * Windows 아니면 완전 no-op(구독조차 안 함). App 에서 1회 마운트.
 */
export function useShellWarm(): void {
  useEffect(() => {
    if (platform() !== "windows") return;

    const timers = new Map<Slot, ReturnType<typeof setTimeout>>();
    const lastKey = new Map<Slot, string>();

    /** 같은 대상 반복 예열은 키로 걷어내고, settle 후 1회만 실행. */
    const schedule = (
      slot: Slot,
      key: string,
      delay: number,
      run: () => void,
    ) => {
      if (lastKey.get(slot) === key) return;
      lastKey.set(slot, key);
      clearTimeout(timers.get(slot));
      timers.set(
        slot,
        setTimeout(() => {
          if (useContextMenu.getState().open) return; // 메뉴 열림 중엔 보류(위 §).
          run();
        }, delay),
      );
    };

    /** 항목 예열 — 로컬 패널의 실제 항목만(".."/원격 제외). */
    const warmEntry = (paneId: PaneId, entry: Entry | undefined) => {
      if (!entry || entry.name === "..") return;
      const tab = activeTab(usePanes.getState(), paneId);
      if (tab.location.source.kind !== "local") return;
      const scope: ShellScope = entry.kind === "dir" ? "directory" : "file";
      warmShellMenu(
        String(childLocation(tab.location, entry.name).path),
        scope,
      );
    };

    // 커서 항목 + 폴더 배경 — 활성 패널 기준. 무관한 store 변경은 키 비교로 걸러낸다.
    // 실행 시점엔 상태를 다시 읽는다(예약 후 커서가 또 움직였을 수 있음).
    const unsubPanes = usePanes.subscribe((s) => {
      const tab = activeTab(s, s.activePane);
      const entry = selectDisplayedEntries(s.activePane, s)[tab.cursorIndex];
      const folder = String(tab.location.path);
      schedule(
        "cursor",
        `${s.activePane}|${folder}|${entry?.name ?? ""}`,
        CURSOR_SETTLE_MS,
        () => {
          const cur = usePanes.getState();
          const t = activeTab(cur, cur.activePane);
          warmEntry(
            cur.activePane,
            selectDisplayedEntries(cur.activePane, cur)[t.cursorIndex],
          );
        },
      );
      schedule(
        "background",
        `${s.activePane}|${folder}`,
        CURSOR_SETTLE_MS,
        () => {
          const cur = usePanes.getState();
          const t = activeTab(cur, cur.activePane);
          if (t.location.source.kind !== "local") return;
          warmShellMenu(String(t.location.path), "background");
        },
      );
    });

    // 호버 — 마우스가 그 행에 머무는 시간이 곧 예열 lead time.
    const unsubHover = onHoverEntry((paneId, entry) => {
      if (entry.name === "..") return;
      const tab = activeTab(usePanes.getState(), paneId);
      if (tab.location.source.kind !== "local") return;
      const path = String(childLocation(tab.location, entry.name).path);
      const scope: ShellScope = entry.kind === "dir" ? "directory" : "file";
      schedule("hover", path, HOVER_SETTLE_MS, () =>
        warmShellMenu(path, scope),
      );
    });

    // 메뉴가 열리는 순간 대기 중 예약 취소. 키도 비운다 — 안 그러면 메뉴를 닫고 같은
    // 항목에 다시 호버해도 "같은 키"라 영영 예열이 안 걸린다.
    const unsubMenu = useContextMenu.subscribe((m) => {
      if (!m.open) return;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      lastKey.clear();
    });

    return () => {
      for (const t of timers.values()) clearTimeout(t);
      unsubPanes();
      unsubHover();
      unsubMenu();
    };
  }, []);
}
