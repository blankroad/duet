import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";
import { useSidebarFilter, matchRange } from "@/stores/sidebarFilter";

/**
 * 사이드바 상단 이름 필터 — 항목이 쌓이면 눈으로 훑는 수밖에 없던 문제.
 * 패널 필터바와 같은 어휘("필터…"). Esc 로 지우고 포커스를 뺀다.
 *
 * 단축키는 아직 붙이지 않았다: `Ctrl+F` 는 패널 빠른 필터가 이미 쓰고 있고,
 * 키는 전부 keymap 에서 설정 가능해야 하므로(CLAUDE.md) 하드코딩하지 않는다.
 * 필요하면 command 로 등록해 사용자가 원하는 키에 매는 게 맞다.
 */
export function SidebarFilter() {
  const { t } = useTranslation();
  const q = useSidebarFilter((s) => s.q);
  const set = useSidebarFilter((s) => s.set);
  const clear = useSidebarFilter((s) => s.clear);
  const ref = useRef<HTMLInputElement>(null);

  return (
    <div className="sticky top-0 z-20 shrink-0 border-b border-border bg-subtle px-2 py-1.5">
      {/* 입력칸은 bg-base — 사이드바(bg-subtle) 위에서 라이트 모드에서도 칸으로 읽힌다. */}
      <div className="flex h-[26px] items-center gap-1.5 rounded border border-border bg-base px-2 focus-within:border-accent">
        <Search size={13} className="shrink-0 text-fg-muted" />
        <input
          ref={ref}
          type="text"
          value={q}
          spellCheck={false}
          placeholder={t("filter.placeholder")}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              clear();
              ref.current?.blur();
            }
          }}
          aria-label={t("sidebar.filterLabel")}
          className="min-w-0 flex-1 bg-transparent text-meta text-fg placeholder:text-fg-muted focus:outline-none"
        />
        {q && (
          <button
            type="button"
            onClick={clear}
            className="shrink-0 rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
            aria-label={t("filter.clear")}
            title={t("filter.clear")}
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 행 라벨 — 필터에 걸린 글자만 강조. 왜 이 행이 남았는지 바로 보이게 한다.
 * 강조는 accent 배경이라 글자색을 건드리지 않고도 라이트/다크 양쪽에서 드러난다.
 */
export function RowLabel({ text }: { text: string }) {
  const q = useSidebarFilter((s) => s.q);
  const r = matchRange(text, q);
  if (!r) return <span className="min-w-0 flex-1 truncate">{text}</span>;
  return (
    <span className="min-w-0 flex-1 truncate">
      {text.slice(0, r.start)}
      <mark className="rounded-[2px] bg-accent/25 px-px text-fg">
        {text.slice(r.start, r.end)}
      </mark>
      {text.slice(r.end)}
    </span>
  );
}
