import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { commands } from "@/types/bindings";
import type { EntryRef } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { useUI } from "@/stores/ui";
import { formatErr } from "@/lib/error";
import { validateEntryName } from "@/lib/newEntry";
import { isWindows } from "@/lib/fileIcon";
import i18n from "@/i18n";

/** 확장자 앞까지 선택 (파일). 폴더·점파일(.bashrc)은 전체. */
function selectStem(el: HTMLInputElement, name: string, isDir: boolean) {
  const dot = isDir ? -1 : name.lastIndexOf(".");
  el.setSelectionRange(0, dot > 0 ? dot : name.length);
}

/**
 * 리스트/그리드 행 안에서 이름을 직접 편집하는 인라인 입력 (F2).
 *
 * - 마운트 시 포커스 + 확장자 제외 basename 선택 (파일; 폴더는 전체)
 * - Enter/blur = 커밋 (Finder/Explorer 관례), Esc = 취소
 * - 한글 등 IME 조합 중의 Enter/Esc 는 조합 확정용이라 커밋/취소하지 않는다
 * - 커밋 요청 중에는 입력을 잠그고 두 번째 커밋(Enter 뒤 blur 등)을 막는다
 * - Enter 로 커밋했는데 실패(검증·백엔드 오류)하면 입력한 이름을 그대로 두고 편집을
 *   이어 간다. 다른 곳을 눌러(blur) 실패하면 편집을 닫는다 — 포커스를 빼앗지 않게
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
  /** renamed=true 면 호출부가 커서를 새 이름으로 옮기고 목록을 새로고침. */
  onDone: (renamed: boolean, newName?: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState(target.name);
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  const pendingRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    selectStem(el, target.name, isDir);
  }, [target.name, isDir]);

  // 언마운트가 blur 없이 일어나는 경로(가상 스크롤 이탈 등) 커버.
  useEffect(
    () => () => {
      if (!doneRef.current) useUI.getState().clearInlineRename();
    },
    [],
  );

  const finish = (renamed: boolean, newName?: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(renamed, newName);
  };

  /**
   * 실패 처리 — Enter 면 편집 유지(재시도), blur 면 닫기. Enter 뒤 응답을 기다리는
   * 사이 다른 곳을 눌렀다면(포커스가 떠났으면) 포커스를 되찾지 않고 닫는다.
   */
  const fail = (message: string, keepEditing: boolean) => {
    useToast.getState().show(message, "error");
    if (!keepEditing || document.activeElement !== ref.current) {
      finish(false);
      return;
    }
    setInvalid(true);
    const el = ref.current;
    if (el) {
      el.focus();
      selectStem(el, el.value, isDir);
    }
  };

  const commit = async (keepEditingOnError: boolean) => {
    if (doneRef.current || pendingRef.current) return;
    const newName = value.trim();
    if (!newName || newName === target.name) {
      finish(false);
      return;
    }
    const bad = validateEntryName(
      newName,
      target.location.source.kind === "local" && isWindows(),
    );
    if (bad) {
      fail(i18n.t(`dialog.newEntry.${bad}`), keepEditingOnError);
      return;
    }
    pendingRef.current = true;
    setPending(true);
    // IPC 자체가 reject 해도(채널·직렬화 오류) 잠금을 풀어야 Esc·재시도가 된다.
    let err: string | null = null;
    try {
      const r = await commands.fsRename(target, newName);
      if (r.status === "error") err = formatErr(r.error);
    } catch (e) {
      err = formatErr(e);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
    if (err === null) finish(true, newName);
    else fail(i18n.t("toast.renameFailed", { err }), keepEditingOnError);
  };

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      readOnly={pending}
      aria-busy={pending}
      aria-invalid={invalid}
      spellCheck={false}
      onChange={(e) => {
        setValue(e.target.value);
        setInvalid(false);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        // IME 조합 중(한글 등)의 Enter/Esc 는 조합 확정·취소 — 커밋하지 않는다.
        // WebKit 은 조합을 끝내는 Enter 에 keyCode 229 를 싣는다.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") {
          e.preventDefault();
          void commit(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (!pendingRef.current) finish(false);
        }
      }}
      onBlur={() => void commit(false)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className={clsx(
        "min-w-0 rounded border bg-base px-1 py-0 font-mono focus:outline-none",
        invalid ? "border-danger" : "border-accent",
        pending && "opacity-60",
        className,
      )}
    />
  );
}
