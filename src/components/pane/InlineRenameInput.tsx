import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { commands } from "@/types/bindings";
import type { EntryRef } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { useUI } from "@/stores/ui";
import { formatErr } from "@/lib/error";

/**
 * 리스트/그리드 행 안에서 이름을 직접 편집하는 인라인 입력 (F2).
 *
 * - 마운트 시 포커스 + 확장자 제외 basename 선택 (파일; 폴더는 전체)
 * - Enter/blur = 커밋 (Finder/Explorer 관례), Esc = 취소
 * - 커밋: 이름이 그대로면 no-op, 실패는 error 토스트
 * - 키/마우스 이벤트는 전파 차단 — 전역 단축키/행 클릭/드래그와 충돌 방지
 * - 언마운트(내비게이션·가상 스크롤 이탈) 시 편집 상태 잔류 방지
 */
export function InlineRenameInput({
  target,
  isDir,
  onDone,
  className,
}: {
  target: EntryRef;
  isDir: boolean;
  /** renamed=true 면 호출부가 목록 새로고침. */
  onDone: (renamed: boolean) => void;
  className?: string;
}) {
  const [value, setValue] = useState(target.name);
  const ref = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = isDir ? -1 : target.name.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : target.name.length);
  }, [target.name, isDir]);

  // 언마운트가 blur 없이 일어나는 경로(가상 스크롤 이탈 등) 커버.
  useEffect(
    () => () => {
      if (!doneRef.current) useUI.getState().clearInlineRename();
    },
    [],
  );

  const finish = (renamed: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(renamed);
  };

  const commit = async () => {
    if (doneRef.current) return;
    const newName = value.trim();
    if (!newName || newName === target.name) {
      finish(false);
      return;
    }
    const r = await commands.fsRename(target, newName);
    if (r.status === "ok") {
      finish(true);
    } else {
      useToast.getState().show(`Rename failed: ${formatErr(r.error)}`, "error");
      finish(false);
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => void commit()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className={clsx(
        "min-w-0 rounded border border-accent bg-base px-1 py-0 font-mono focus:outline-none",
        className,
      )}
    />
  );
}
