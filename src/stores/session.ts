import {
  usePanes,
  defaultOrderFor,
  type PaneId,
  type RestoredLayout,
  type SortKey,
  type ViewMode,
} from "./panes";
import { useConnections } from "./connections";
import { aliasFromConnectionId } from "@/lib/hostAlias";

/**
 * 세션(탭 레이아웃) 영속 — 재시작 시 좌/우 패널의 탭 구성·경로·정렬/뷰 복원.
 *
 * localStorage 에 저장(자격증명 아닌 경로/뷰 메타라 §5 무관, recents 와 동일 패턴).
 * 원격 탭은 **alias + 경로**로 저장한다 — connection_id 는 재시작하면 무효지만
 * alias 만 있으면 패널 배너의 "다시 연결"이 그 경로로 되돌아간다. 비밀번호 같은
 * 자격증명은 저장하지 않는다(§5).
 */

const KEY = "duet.session.v1";

/** 현재 panes 상태에서 로컬 탭만 추려 슬림 레이아웃으로 직렬화. */
export function snapshot(): RestoredLayout {
  const s = usePanes.getState();
  const slimPane = (id: PaneId): RestoredLayout["panes"][PaneId] => {
    const p = s.panes[id];
    const activeId = p.tabs[p.activeTabIndex]?.id;
    // 휴지통 루트는 재시작 후 의미가 없어 제외. 아카이브 탭은 임시 추출 경로가
    // 사라지므로 **원래 폴더(exitTo)** 로 저장한다 — 예전엔 통째로 버려서 아카이브를
    // 보던 핀 탭이 재시작마다 사라졌다.
    const keep = p.tabs.filter((t) => t.trashRoot === undefined);
    const idx = keep.findIndex((t) => t.id === activeId);
    return {
      activeTabIndex: idx >= 0 ? idx : 0,
      tabs: keep.map((t) => {
        const location = t.archive ? t.archive.exitTo : t.location;
        const src = location.source;
        const host =
          src.kind === "ssh"
            ? (useConnections.getState().active[src.connection_id]?.alias ??
              aliasFromConnectionId(src.connection_id))
            : undefined;
        return {
          path: String(location.path),
          ...(host ? { host } : {}),
          sortKey: t.sortKey,
          sortOrder: t.sortOrder,
          showHidden: t.showHidden,
          viewMode: t.viewMode,
          // 핀일 때만 기록 — 필드 추가만이라 KEY(v1) 유지, 구버전 앱은 무시한다.
          ...(t.pinned ? { pinned: true } : {}),
        };
      }),
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

const SORT_KEYS: readonly SortKey[] = ["name", "size", "mtime", "kind", "ext"];
const VIEW_MODES: readonly ViewMode[] = ["details", "grid", "tiles"];

type SlimTab = RestoredLayout["panes"][PaneId]["tabs"][number];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** 저장된 탭 하나를 검증·정규화. 경로가 없으면 버린다(null). */
function parseTab(v: unknown): SlimTab | null {
  if (!isObj(v) || typeof v.path !== "string" || v.path === "") return null;
  const sortKey = SORT_KEYS.find((k) => k === v.sortKey) ?? "mtime";
  return {
    path: v.path,
    ...(typeof v.host === "string" && v.host !== "" ? { host: v.host } : {}),
    sortKey,
    sortOrder:
      v.sortOrder === "asc" || v.sortOrder === "desc"
        ? v.sortOrder
        : defaultOrderFor(sortKey),
    showHidden: v.showHidden === true,
    viewMode: VIEW_MODES.find((m) => m === v.viewMode) ?? "details",
    ...(v.pinned === true ? { pinned: true } : {}),
  };
}

function parsePane(v: unknown): RestoredLayout["panes"][PaneId] | null {
  if (!isObj(v) || !Array.isArray(v.tabs)) return null;
  const tabs = v.tabs.map(parseTab).filter((t): t is SlimTab => t !== null);
  const idx = v.activeTabIndex;
  return {
    tabs,
    activeTabIndex: typeof idx === "number" && Number.isInteger(idx) ? idx : 0,
  };
}

/**
 * 부팅 시 저장된 레이아웃 로드 (없거나 손상 시 null).
 *
 * 저장 데이터는 신뢰하지 않는다 — 손으로 고쳤거나 구버전/다른 버전이 쓴 값일 수
 * 있다. 예전엔 패널 존재만 보고 통과시켜 `tabs` 가 배열이 아니면 복원이 throw 해
 * 부팅이 중간에 멈췄고(세션 저장도 시작되지 않아 손상 데이터가 영원히 남음),
 * 활성 인덱스가 빠지면 NaN 이 됐다. 탭 단위로 검증해 잘못된 탭만 버린다.
 */
export function loadSession(): RestoredLayout | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!isObj(v) || !isObj(v.panes)) return null;
    const left = parsePane(v.panes.left);
    const right = parsePane(v.panes.right);
    if (!left || !right) return null;
    if (left.tabs.length === 0 && right.tabs.length === 0) return null;
    return {
      activePane: v.activePane === "right" ? "right" : "left",
      panes: { left, right },
    };
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
