import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import clsx from "clsx";
import { displayKey } from "@/lib/keyDisplay";
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
 * 보정은 **양축·자기치유**: 매 렌더마다 현재 transform 을 제거한 '자연 위치'에서 다시
 * 계산해 위/아래/좌/우 어디로 넘쳐도 화면 안으로 되돌린다. (과거엔 아래 넘침만 위로
 * 올렸고 되돌림이 없어, 순간적으로 잘못 측정된 rect 하나에 flyout 이 화면 구석에 박혀
 * 고정되는 버그가 있었다 — loadChildren 이 캐시로 즉시 resolve 되며 드러남.)
 */
function Flyout({
  flipLeft,
  children,
}: {
  flipLeft: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 자연 위치(부모 옆 기본) 측정을 위해 transform 초기화 후 rect 측정 → 누적/편류 방지.
    // (t 를 빼서 역산하지 않는다: 실측값이 transform 을 반영하지 않는 환경에서도 안전.)
    el.style.transform = "translate(0px, 0px)";
    const r = el.getBoundingClientRect();
    const m = FLYOUT_MARGIN;
    // 세로: 아래로 넘치면 올리고, 그래도 위로 넘치면 위를 우선(top 은 항상 ≥ m → 화면 안).
    let dy = 0;
    if (r.bottom > window.innerHeight - m)
      dy = window.innerHeight - m - r.bottom;
    if (r.top + dy < m) dy = m - r.top;
    // 가로: 부모 옆 기본 위치가 화면 밖이면 안으로(구석행 방지). left 는 항상 ≥ m.
    let dx = 0;
    if (r.right > window.innerWidth - m) dx = window.innerWidth - m - r.right;
    if (r.left + dx < m) dx = m - r.left;
    // 페인트 전 즉시 적용(깜빡임 없음) + React 상태 동기화(다음 렌더 style 일치).
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    setT((prev) => (prev.x === dx && prev.y === dy ? prev : { x: dx, y: dy }));
  }, [children]);
  return (
    <div
      ref={ref}
      className={clsx("absolute", flipLeft ? "right-full" : "left-full")}
      style={{
        top: 0,
        transform: `translate(${t.x}px, ${t.y}px)`,
        maxHeight: "calc(100vh - 8px)",
        overflowY: "auto",
      }}
    >
      {children}
    </div>
  );
}

export function ContextMenu() {
  const { open, x, y, items, close } = useContextMenu();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [path, setPath] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number[]>([0]);
  const [loaded, setLoaded] = useState<Loaded>({});

  useEffect(() => {
    if (open) {
      setPath([]);
      setCursor([0]);
      setLoaded({});
    }
  }, [open, x, y]);

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
      void item
        .loadChildren()
        .then((kids) =>
          setLoaded((m) => ({ ...m, [item.id]: kids.length ? kids : "empty" })),
        )
        .catch(() => setLoaded((m) => ({ ...m, [item.id]: "empty" })));
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
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursorAt(level, Math.min(list.length - 1, cur + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursorAt(level, Math.max(0, cur - 1));
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
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path, cursor, levels.length]);

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
        className="min-w-44 rounded-panel border border-border bg-base py-1 shadow-panel"
        style={
          level === 0
            ? { position: "fixed", left: pos.x, top: pos.y, zIndex: 61 }
            : undefined
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
  return (
    <div className="min-w-32 rounded-panel border border-border bg-base py-1 shadow-panel">
      <div className="px-3 py-1 text-meta text-fg-muted">
        {status === "loading" ? "Loading…" : "(none)"}
      </div>
    </div>
  );
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
  return (
    <div className="relative px-1" onMouseEnter={onMouseEnter}>
      <button
        type="button"
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
        {item.shortcut && (
          <span className="shrink-0 text-meta text-fg-muted">
            {displayKey(item.shortcut)}
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
