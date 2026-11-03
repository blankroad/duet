import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { displayKey } from "@/lib/keyDisplay";
import { useKeymap, effectiveKey } from "@/stores/keymap";
import { useCommands } from "@/stores/commands";
import {
  useContextMenu,
  isSeparator,
  type MenuEntry,
  type MenuItem,
} from "@/stores/contextMenu";

/**
 * 우클릭 컨텍스트 메뉴 — App 루트에 1개만 마운트.
 * 다단계(재귀) 서브메뉴 + 지연 로딩(loadChildren) 지원. 키보드 ↑/↓/→/←/Enter/Esc,
 * 뷰포트 밖이면 위치 보정, 바깥 클릭/스크롤/blur 로 닫힘.
 *
 * 상태 모델: `path` = 펼쳐진 서브메뉴 id 스택(루트→깊이), `cursor` = 레벨별 커서 인덱스.
 * 활성(키보드) 레벨 = path.length. loadChildren 항목은 펼칠 때 1회 조회해 `loaded` 캐시.
 */

type Loaded = Record<string, MenuEntry[] | "loading" | "empty">;

/** 보이는(선택가능) 항목만 — separator/disabled 제외. */
function selectable(entries: MenuEntry[]): MenuItem[] {
  return entries.filter((e): e is MenuItem => !isSeparator(e) && !e.disabled);
}

function hasSubmenu(item: MenuItem): boolean {
  return (!!item.children && item.children.length > 0) || !!item.loadChildren;
}

/** 항목의 자식 — 정적이면 배열, 지연이면 캐시 상태("loading"/"empty"/배열), 없으면 null. */
function childrenOf(
  item: MenuItem,
  loaded: Loaded,
): MenuEntry[] | "loading" | "empty" | null {
  if (item.children && item.children.length > 0) return item.children;
  if (item.loadChildren) return loaded[item.id] ?? "loading";
  return null;
}

/** 플라이아웃을 뷰포트 안으로 되돌리는 여백(px). */
const FLYOUT_MARGIN = 4;

/**
 * 서브메뉴 플라이아웃 — 부모 항목 옆(좌/우)으로 펼치되, 뷰포트 밖으로 넘치면 그만큼 안으로
 * 끌어당겨(clamp) 항상 보이게. 화면보다 긴 메뉴(셸 More Actions 등)는 스크롤.
 *
 * `position: fixed` 로 부모 행의 화면 좌표에서 매 렌더 다시 계산한다(자기치유). 루트 메뉴가
 * 화면보다 길어 스크롤 컨테이너가 되면 absolute 자식은 잘리므로 fixed 로 띄운다.
 * (과거 transform 누적 방식은 순간적으로 잘못 측정된 rect 하나에 flyout 이 화면 구석에
 * 박혀 고정되는 버그가 있었다 — 매번 앵커에서 새로 계산해 그 문제를 피한다.)
 */
function Flyout({
  flipLeft,
  children,
}: {
  flipLeft: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = el?.parentElement;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const m = FLYOUT_MARGIN;
    // 세로: 부모 행 높이에서 시작, 아래로 넘치면 올리되 top 은 항상 ≥ m.
    let top = a.top;
    if (top + r.height > window.innerHeight - m)
      top = window.innerHeight - m - r.height;
    if (top < m) top = m;
    // 가로: 부모 옆(오른쪽 기본, 공간 없으면 왼쪽). 화면 밖이면 안으로, left ≥ m.
    let left = flipLeft ? a.left - r.width : a.right;
    if (left + r.width > window.innerWidth - m)
      left = window.innerWidth - m - r.width;
    if (left < m) left = m;
    setPos((prev) =>
      prev && prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [children, flipLeft]);
  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        // 첫 측정 전엔 숨겨 둔다(엉뚱한 자리 깜빡임 방지).
        visibility: pos ? "visible" : "hidden",
        zIndex: 62,
        maxHeight: "calc(100vh - 8px)",
        overflowY: "auto",
      }}
    >
      {children}
    </div>
  );
}

export function ContextMenu() {
  const { open, x, y, items, seq, close } = useContextMenu();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [path, setPath] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number[]>([0]);
  const [loaded, setLoaded] = useState<Loaded>({});

  // 메뉴를 새로 열 때마다(seq) 펼친 경로·커서·지연 캐시를 초기화 — 같은 자리에서
  // 다른 항목 메뉴를 다시 열어도 이전 메뉴 상태가 남지 않게.
  useEffect(() => {
    if (open) {
      setPath([]);
      setCursor([0]);
      setLoaded({});
    }
  }, [open, seq]);

  // 포커스: 열면 메뉴가 받고(뒤 화면으로 Tab 이 새지 않게), 닫히면 열기 전 자리로 돌려준다.
  // 닫으면서 다른 곳(이름 바꾸기 입력·다이얼로그)이 포커스를 가져갔으면 건드리지 않는다.
  useEffect(() => {
    if (!open) return;
    const prev =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      if (prev && prev.isConnected && (now === null || now === document.body))
        prev.focus({ preventScroll: true });
    };
  }, [open, seq]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const ny = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    setPos({ x: nx, y: ny });
  }, [open, x, y, items]);

  // 우측 공간 부족하면 서브메뉴를 왼쪽으로.
  const flipLeft = pos.x > window.innerWidth / 2;

  // 펼쳐진 경로를 따라 각 레벨의 항목 배열을 해석. 지연 미완료면 거기서 멈추고 상태 기록.
  const levels: MenuEntry[][] = [items];
  let pendingStatus: "loading" | "empty" | null = null;
  for (let k = 0; k < path.length; k++) {
    const parent = levels[k]!.find(
      (e): e is MenuItem => !isSeparator(e) && e.id === path[k],
    );
    if (!parent) break;
    const kids = childrenOf(parent, loaded);
    if (kids === "loading" || kids === "empty" || kids === null) {
      pendingStatus = kids === null ? "empty" : kids;
      break;
    }
    levels.push(kids);
  }

  const setCursorAt = (level: number, idx: number) =>
    setCursor((c) => {
      const n = c.slice(0, level + 1);
      n[level] = idx;
      return n;
    });

  /** level 의 item 을 펼친다(자식 있을 때만) + 지연 로딩 트리거. */
  const openItem = (level: number, item: MenuItem) => {
    if (!hasSubmenu(item)) return;
    setPath((p) => [...p.slice(0, level), item.id]);
    setCursor((c) => {
      const n = c.slice(0, level + 1);
      n[level + 1] = 0;
      return n;
    });
    if (item.loadChildren && loaded[item.id] === undefined) {
      setLoaded((m) => ({ ...m, [item.id]: "loading" }));
      // 응답이 늦게 오는 사이 메뉴를 닫고 다른 항목에서 다시 열었으면(같은 id 의
      // "More options" 등) 이전 항목의 결과를 버린다 — 다른 파일의 셸 메뉴가 끼어들지 않게.
      const mine = seq;
      const current = () => {
        const st = useContextMenu.getState();
        return st.open && st.seq === mine;
      };
      void item
        .loadChildren()
        .then((kids) => {
          if (current())
            setLoaded((m) => ({
              ...m,
              [item.id]: kids.length ? kids : "empty",
            }));
        })
        .catch(() => {
          if (current()) setLoaded((m) => ({ ...m, [item.id]: "empty" }));
        });
    }
  };

  const run = (level: number, item: MenuItem) => {
    if (item.disabled) return;
    if (hasSubmenu(item)) {
      openItem(level, item);
      return;
    }
    close();
    item.onSelect?.();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const level = path.length;
      const list = selectable(levels[level] ?? []);
      const cur = cursor[level] ?? 0;
      // ↑↓ 는 끝에서 반대쪽으로 순환, Home/End 는 처음·끝 (OS 메뉴 관례).
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (list.length > 0) setCursorAt(level, (cur + 1) % list.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (list.length > 0)
          setCursorAt(level, (cur - 1 + list.length) % list.length);
      } else if (e.key === "Home") {
        e.preventDefault();
        setCursorAt(level, 0);
      } else if (e.key === "End") {
        e.preventDefault();
        setCursorAt(level, Math.max(0, list.length - 1));
      } else if (e.key === "ArrowRight") {
        const item = list[cur];
        if (item && hasSubmenu(item)) {
          e.preventDefault();
          openItem(level, item);
        }
      } else if (e.key === "ArrowLeft") {
        if (level > 0) {
          e.preventDefault();
          setPath((p) => p.slice(0, -1));
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = list[cur];
        if (item) run(level, item);
      } else if (e.key === "Escape") {
        e.preventDefault();
        // 서브메뉴가 펼쳐져 있으면 한 단계만 접는다. 루트에서 누르면 닫기.
        if (level > 0) setPath((p) => p.slice(0, -1));
        else close();
      } else if (e.key === "Tab") {
        // 메뉴가 열려 있는 동안 Tab 으로 뒤 화면에 포커스가 가지 않게.
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seq, path, cursor, levels.length]);

  if (!open) return null;

  const renderPanel = (
    level: number,
    entries: MenuEntry[],
  ): React.ReactNode => {
    const sel = selectable(entries);
    const activeId = sel[cursor[level] ?? 0]?.id;
    return (
      <div
        ref={level === 0 ? panelRef : undefined}
        role="menu"
        tabIndex={-1}
        className="min-w-44 rounded-panel border border-border bg-base py-1 shadow-panel focus:outline-none"
        style={
          level === 0
            ? {
                position: "fixed",
                left: pos.x,
                top: pos.y,
                zIndex: 61,
                // 창보다 긴 메뉴(낮은 창·항목 많은 폴더 메뉴)는 안에서 스크롤.
                maxHeight: "calc(100vh - 8px)",
                overflowY: "auto",
              }
            : undefined
        }
        onScroll={
          // 루트를 스크롤하면 펼쳐 둔 서브메뉴는 부모 행과 어긋나므로 접는다.
          level === 0 ? () => setPath([]) : undefined
        }
        onContextMenu={(e) => e.preventDefault()}
      >
        {entries.map((entry, i) =>
          isSeparator(entry) ? (
            <div key={`sep-${level}-${i}`} className="my-1 h-px bg-border" />
          ) : (
            <Row
              key={entry.id}
              item={entry}
              active={
                path[level] === entry.id ||
                (path.length === level && activeId === entry.id)
              }
              onMouseEnter={() => {
                const idx = sel.findIndex((s) => s.id === entry.id);
                if (idx >= 0) setCursorAt(level, idx);
                if (hasSubmenu(entry)) openItem(level, entry);
                else setPath((p) => p.slice(0, level));
              }}
              onClick={() => run(level, entry)}
            >
              {path[level] === entry.id && (
                <Flyout flipLeft={flipLeft}>
                  {level + 1 < levels.length ? (
                    renderPanel(level + 1, levels[level + 1]!)
                  ) : pendingStatus ? (
                    <StatusPanel status={pendingStatus} />
                  ) : null}
                </Flyout>
              )}
            </Row>
          ),
        )}
      </div>
    );
  };

  return (
    <>
      <div
        className="fixed inset-0 z-[60]"
        onMouseDown={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
        onWheel={close}
      />
      {renderPanel(0, items)}
    </>
  );
}

function StatusPanel({ status }: { status: "loading" | "empty" }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-32 rounded-panel border border-border bg-base py-1 shadow-panel">
      <div className="px-3 py-1 text-meta text-fg-muted">
        {status === "loading"
          ? t("menu.submenuLoading")
          : t("menu.submenuEmpty")}
      </div>
    </div>
  );
}

/**
 * 항목의 단축키 힌트 — `commandId` 가 있으면 **현재 키맵**에서 계산한다.
 * 예전에는 메뉴마다 "Ctrl+C" 처럼 박아 둬서, 키를 바꾼 사용자에게 메뉴가 거짓말을 했다.
 */
function shortcutOf(item: MenuItem): string | undefined {
  if (item.commandId) {
    const { builtins, dynamic } = useCommands.getState();
    const cmd = [...builtins, ...dynamic].find((c) => c.id === item.commandId);
    const key = effectiveKey(
      item.commandId,
      useKeymap.getState().bindings,
      cmd?.defaultKey,
    );
    if (key) return key;
  }
  return item.shortcut;
}
function Row({
  item,
  active,
  onMouseEnter,
  onClick,
  children,
}: {
  item: MenuItem;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  const hasKids =
    (!!item.children && item.children.length > 0) || !!item.loadChildren;
  const btnRef = useRef<HTMLButtonElement>(null);
  // 키보드로 화면 밖 항목에 가면 스크롤해 보이게(긴 메뉴).
  useEffect(() => {
    if (active) btnRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <div className="relative px-1" onMouseEnter={onMouseEnter}>
      <button
        ref={btnRef}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-haspopup={hasKids ? "menu" : undefined}
        disabled={item.disabled}
        onClick={onClick}
        className={clsx(
          "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-base",
          item.disabled && "cursor-default text-fg-muted",
          !item.disabled && active && "bg-active",
          !item.disabled && !active && "hover:bg-subtle",
          item.danger && !item.disabled && "text-danger",
        )}
      >
        {item.icon && (
          <span className="shrink-0 text-fg-muted">{item.icon}</span>
        )}
        <span className="flex-1 truncate">{item.label}</span>
        {shortcutOf(item) && (
          <span className="shrink-0 text-meta text-fg-muted">
            {displayKey(shortcutOf(item)!)}
          </span>
        )}
        {hasKids && (
          <ChevronRight size={12} className="shrink-0 text-fg-muted" />
        )}
      </button>
      {children}
    </div>
  );
}
