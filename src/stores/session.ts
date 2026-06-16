import { usePanes, type PaneId, type RestoredLayout } from "./panes";

/**
 * 세션(탭 레이아웃) 영속 — 재시작 시 좌/우 패널의 탭 구성·경로·정렬/뷰 복원.
 *
 * localStorage 에 저장(자격증명 아닌 경로/뷰 메타라 §5 무관, recents 와 동일 패턴).
 * **로컬 탭만** 저장/복원 — SSH 탭은 재시작 시 연결이 사라져 connection_id 가 무효라
 * 복원해도 동작하지 않으므로 제외(후속: alias 기반 재접속 복원).
 */

const KEY = "duet.session.v1";

/** 현재 panes 상태에서 로컬 탭만 추려 슬림 레이아웃으로 직렬화. */
function snapshot(): RestoredLayout {
  const s = usePanes.getState();
  const slimPane = (id: PaneId): RestoredLayout["panes"][PaneId] => {
    const p = s.panes[id];
    const activeId = p.tabs[p.activeTabIndex]?.id;
    const localTabs = p.tabs.filter((t) => t.location.source.kind === "local");
    const idx = localTabs.findIndex((t) => t.id === activeId);
    return {
      activeTabIndex: idx >= 0 ? idx : 0,
      tabs: localTabs.map((t) => ({
        path: String(t.location.path),
        sortKey: t.sortKey,
        sortOrder: t.sortOrder,
        showHidden: t.showHidden,
        viewMode: t.viewMode,
      })),
    };
  };
  return {
    activePane: s.activePane,
    panes: { left: slimPane("left"), right: slimPane("right") },
  };
}

function saveSession(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot()));
  } catch {
    /* localStorage 불가 환경 — 메모리만 */
  }
}

/** 부팅 시 저장된 레이아웃 로드 (없거나 손상 시 null). */
export function loadSession(): RestoredLayout | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as RestoredLayout;
    // 최소 형태 검증 — 손상 시 무시하고 기본 부팅.
    if (!v || !v.panes || !v.panes.left || !v.panes.right) return null;
    return v;
  } catch {
    return null;
  }
}

let subscribed = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * panes 변경을 구독해 debounce(500ms) 저장. 부팅 복원이 끝난 뒤 1회 호출 —
 * 복원 중 navigate 들이 저장을 유발하지 않도록.
 */
export function initSessionPersist(): void {
  if (subscribed) return;
  subscribed = true;
  usePanes.subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(saveSession, 500);
  });
}
