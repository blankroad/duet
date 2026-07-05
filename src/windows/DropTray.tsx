import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { Inbox, X, Trash2, GripVertical } from "lucide-react";
import clsx from "clsx";
import { commands } from "@/types/bindings";
import { applyTheme } from "@/lib/theme";
import { basename } from "@/lib/paths";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";
import { Toast } from "@/components/Toast";

/**
 * 플로팅 드롭 트레이 창 본체 (Yoink 벤치마킹, label="shelf").
 *
 * - OS 드롭(듀엣 포함 어디서든)으로 로컬 경로 수집 → 행/전체를 외부 앱으로
 *   네이티브 드래그-아웃 (crabnebula drag 플러그인, 항상 copy)
 * - Yoink 관례: 드롭 성공(Dropped) 시 트레이에서 자동 제거, Cancelled 는 유지
 * - 항목은 localStorage 영속(창 닫아도 유지) — 메인 창과 상태 비공유(독립 트레이)
 */
const STORE_KEY = "duet.droptray.v1";

// 드래그 프리뷰 — 1x1 투명 PNG (OS 기본 파일 프리뷰 사용). dragOut.ts 와 동일.
const DRAG_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function loadItems(): string[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v)
      ? v.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

function saveItems(items: string[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items));
  } catch {
    /* localStorage 불가 — 메모리 상태만 */
  }
}

export function DropTray() {
  const { t } = useTranslation();
  const [items, setItems] = useState<string[]>(loadItems);
  const [hover, setHover] = useState(false);

  // 테마 동기화 — 메인 창과 같은 settings.toml 을 읽어 data-theme 적용.
  useEffect(() => {
    void commands.settingsGet().then((r) => {
      applyTheme(r.status === "ok" ? (r.data.theme ?? "system") : "system");
    });
  }, []);

  const update = (next: string[]) => {
    setItems(next);
    saveItems(next);
  };

  // OS 파일 드롭 수신 — 중복 경로는 무시.
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    const unlistenP = win.onDragDropEvent((e) => {
      if (e.payload.type === "enter" || e.payload.type === "over")
        setHover(true);
      else if (e.payload.type === "leave") setHover(false);
      else if (e.payload.type === "drop") {
        setHover(false);
        const dropped = e.payload.paths;
        setItems((cur) => {
          const next = [...cur];
          for (const p of dropped) if (!next.includes(p)) next.push(p);
          saveItems(next);
          return next;
        });
      }
    });
    return () => {
      void unlistenP.then((fn) => fn());
    };
  }, []);

  /** mousedown 에서 동기 발사(제스처에 드래그가 붙게) — Dropped 면 트레이에서 제거. */
  const dragOut = (paths: string[]) => {
    if (paths.length === 0) return;
    void startDrag({ item: paths, icon: DRAG_ICON, mode: "copy" }, (ev) => {
      if (ev.result === "Dropped") {
        setItems((cur) => {
          const next = cur.filter((p) => !paths.includes(p));
          saveItems(next);
          return next;
        });
      }
    }).catch((e) => {
      useToast.getState().show(`Drag out failed: ${formatErr(e)}`, "error");
    });
  };

  const win = getCurrentWebviewWindow();

  return (
    <div
      className={clsx(
        "flex h-screen w-screen flex-col overflow-hidden rounded-panel border bg-base text-base text-fg",
        hover ? "border-accent ring-2 ring-inset ring-accent" : "border-border",
      )}
    >
      {/* 헤더 = 창 드래그 영역. 항목이 있으면 전체 드래그-아웃 핸들도 겸함. */}
      <header
        data-tauri-drag-region
        className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-subtle px-2"
      >
        <Inbox
          size={13}
          className="pointer-events-none shrink-0 text-fg-muted"
        />
        <span
          data-tauri-drag-region
          className="pointer-events-none flex-1 truncate text-meta text-fg-muted"
        >
          {t("droptray.title")}
          {items.length > 0 && ` · ${items.length}`}
        </span>
        {items.length > 0 && (
          <>
            <span
              onMouseDown={() => dragOut(items)}
              title={t("droptray.dragAll")}
              className="cursor-grab rounded p-1 text-fg-muted hover:bg-border hover:text-fg"
            >
              <GripVertical size={12} />
            </span>
            <button
              type="button"
              onClick={() => update([])}
              title={t("droptray.clear")}
              aria-label={t("droptray.clear")}
              className="rounded p-1 text-fg-muted hover:bg-border hover:text-danger"
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => void win.close()}
          title={t("common.close")}
          aria-label={t("common.close")}
          className="rounded p-1 text-fg-muted hover:bg-border"
        >
          <X size={12} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-meta text-fg-muted">
            <Inbox size={22} className="opacity-40" />
            <span>{t("droptray.emptyHint")}</span>
          </div>
        ) : (
          <ul className="py-1">
            {items.map((p) => (
              <li
                key={p}
                // 행 어디서든 mousedown = 그 항목 드래그-아웃 시작.
                onMouseDown={(e) => {
                  if ((e.target as HTMLElement).closest("button")) return;
                  dragOut([p]);
                }}
                title={p}
                className="group flex cursor-grab items-center gap-1.5 px-2 py-1 hover:bg-subtle"
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  {basename(p, p)}
                </span>
                <button
                  type="button"
                  onClick={() => update(items.filter((x) => x !== p))}
                  aria-label={t("droptray.remove")}
                  title={t("droptray.remove")}
                  className="shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-danger focus:opacity-100 group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Toast />
    </div>
  );
}
