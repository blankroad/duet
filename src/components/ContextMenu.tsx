import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import clsx from "clsx";
import { useContextMenu, isSeparator, type MenuItem } from "@/stores/contextMenu";

/**
 * 우클릭 컨텍스트 메뉴 — App 루트에 1개만 마운트 (Toast/DragGhost 와 동일).
 * 커스텀 구현(의존성 추가 없음). 키보드 ↑/↓/Enter/Esc, 1-레벨 서브메뉴(hover/→),
 * 뷰포트 밖이면 위치 보정, 바깥 클릭/스크롤/blur 로 닫힘.
 */
export function ContextMenu() {
  const { open, x, y, items, close } = useContextMenu();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  // 키보드 포커스 대상: 루트 리스트 또는 열린 서브메뉴
  const [cursor, setCursor] = useState(0);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [inSub, setInSub] = useState(false);
  const [subCursor, setSubCursor] = useState(0);

  // 열릴 때 상태 초기화
  useEffect(() => {
    if (open) {
      setCursor(0);
      setOpenSub(null);
      setInSub(false);
      setSubCursor(0);
    }
  }, [open, x, y]);

  // 마운트 후 크기 측정 → 뷰포트 밖이면 좌/상으로 클램프
  useLayoutEffect(() => {
    if (!open) return;
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const ny = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    setPos({ x: nx, y: ny });
  }, [open, x, y, items]);

  const selectable = items.filter((e): e is MenuItem => !isSeparator(e) && !e.disabled);
  const subItems = (() => {
    const parent = items.find((e): e is MenuItem => !isSeparator(e) && e.id === openSub);
    return (parent?.children ?? []).filter((e): e is MenuItem => !isSeparator(e) && !e.disabled);
  })();
  // 우측 공간 부족하면 서브메뉴를 왼쪽으로 펼침
  const flipLeft = pos.x > window.innerWidth / 2;

  const run = (item: MenuItem) => {
    if (item.disabled) return;
    if (item.children) {
      setOpenSub(item.id);
      setInSub(true);
      setSubCursor(0);
      return;
    }
    close();
    item.onSelect?.();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const list = inSub ? subItems : selectable;
      const cur = inSub ? subCursor : cursor;
      const set = inSub ? setSubCursor : setCursor;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        set(Math.min(list.length - 1, cur + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        set(Math.max(0, cur - 1));
      } else if (e.key === "ArrowRight") {
        const item = list[cur];
        if (!inSub && item?.children) {
          e.preventDefault();
          setOpenSub(item.id);
          setInSub(true);
          setSubCursor(0);
        }
      } else if (e.key === "ArrowLeft") {
        if (inSub) {
          e.preventDefault();
          setInSub(false);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = list[cur];
        if (item) run(item);
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
  }, [open, inSub, cursor, subCursor, selectable.length, subItems.length]);

  if (!open) return null;

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
      <div
        ref={panelRef}
        className="fixed z-[61] min-w-44 rounded-panel border border-border bg-base py-1 shadow-panel"
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((entry, i) =>
          isSeparator(entry) ? (
            <div key={`sep-${i}`} className="my-1 h-px bg-border" />
          ) : (
            <Row
              key={entry.id}
              item={entry}
              active={!inSub && selectable[cursor]?.id === entry.id}
              onMouseEnter={() => {
                const idx = selectable.findIndex((s) => s.id === entry.id);
                if (idx >= 0) {
                  setCursor(idx);
                  setInSub(false);
                }
                setOpenSub(entry.children ? entry.id : null);
              }}
              onClick={() => run(entry)}
            >
              {openSub === entry.id && entry.children && (
                <div className={clsx("absolute top-0", flipLeft ? "right-full" : "left-full")}>
                  <div className="min-w-44 rounded-panel border border-border bg-base py-1 shadow-panel">
                    {entry.children.map((c, ci) =>
                      isSeparator(c) ? (
                        <div key={`subsep-${ci}`} className="my-1 h-px bg-border" />
                      ) : (
                        <Row
                          key={c.id}
                          item={c}
                          active={inSub && subItems[subCursor]?.id === c.id}
                          onMouseEnter={() => {
                            const idx = subItems.findIndex((s) => s.id === c.id);
                            if (idx >= 0) {
                              setSubCursor(idx);
                              setInSub(true);
                            }
                          }}
                          onClick={() => run(c)}
                        />
                      ),
                    )}
                  </div>
                </div>
              )}
            </Row>
          ),
        )}
      </div>
    </>
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
        {item.icon && <span className="shrink-0 text-fg-muted">{item.icon}</span>}
        <span className="flex-1 truncate">{item.label}</span>
        {item.shortcut && (
          <span className="shrink-0 text-meta text-fg-muted">{item.shortcut}</span>
        )}
        {item.children && <ChevronRight size={12} className="shrink-0 text-fg-muted" />}
      </button>
      {children}
    </div>
  );
}
