import { createElement } from "react";
import i18n from "@/i18n";
import { commands } from "@/types/bindings";
import type { ShellMenuItem, ShellScope } from "@/types/bindings";
import type { MenuEntry } from "@/stores/contextMenu";
import { childLocation } from "@/lib/entryDnd";
import { showError } from "@/lib/errorToast";
import { isVirtualTrash } from "@/lib/trashView";
import { useToast } from "@/stores/toast";
import { computeDisplayed, type TabState } from "@/stores/panes";

/** 셸 항목 아이콘 PNG 바이트 → data URL (.ts 라 JSX 없이 createElement). */
function iconEl(it: ShellMenuItem) {
  const bytes = it.icon;
  if (!bytes || bytes.length === 0) return undefined;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return createElement("img", {
    src: `data:image/png;base64,${btoa(bin)}`,
    alt: "",
    draggable: false,
    className: "h-4 w-4 object-contain",
  });
}

/**
 * Tier 2 셸 컨텍스트 메뉴(IContextMenu) 프론트 통합 — 백엔드가 호스팅한 실제 셸 메뉴
 * 트리를 duet 컨텍스트 메뉴 항목으로 변환한다.
 *
 * 세션 수명은 **백엔드(경로 캐시)가 관리**한다 — FE 는 close 를 보내지 않는다.
 * - 우클릭 = shell_menu_open(paths) → 캐시 있으면 즉시, 없으면 빌드. {token, items} 반환.
 *   paths 는 한 폴더 안의 선택 전부(표시 순서) — Explorer 처럼 한 메뉴로 묶는다.
 * - 커서 멈춤/폴더 변경 = shell_menu_warm([path]) → 백그라운드로 캐시 채움(useShellWarm).
 * - 잎 항목 클릭 = shell_menu_invoke(token, id) → 백엔드가 그 선택의 IContextMenu 로 실행.
 *   실패는 토스트로 알린다(invokeShellItem).
 */

/**
 * 셸 메뉴 항목 실행. 실패를 숨기지 않는다:
 * - `NotFound` = 메뉴가 만료됨(백엔드가 다시 빌드했거나 밀어냄) — 아무것도 실행되지 않았으니
 *   다시 열어 달라고 안내. (셸 실행 경로에서 NotFound 는 이것뿐 — `shell_menu_core::stale_menu_error`.)
 * - `Cancelled` = 사용자가 명령의 대화상자(UAC 등)를 취소 — 조용히.
 * - 그 외 = 셸 명령 실패 토스트(원문은 알림 "자세히").
 */
export async function invokeShellItem(
  token: number,
  id: number,
): Promise<void> {
  let r: Awaited<ReturnType<typeof commands.shellMenuInvoke>>;
  try {
    r = await commands.shellMenuInvoke(token, id);
  } catch (e) {
    showError("toast.shellMenuFailed", e);
    return;
  }
  if (r.status === "ok" || r.error.kind === "Cancelled") return;
  if (r.error.kind === "NotFound") {
    useToast.getState().show(i18n.t("toast.shellMenuExpired"), "error", {
      detail: r.error.message,
    });
    return;
  }
  showError("toast.shellMenuFailed", r.error);
}

function toEntries(items: ShellMenuItem[], token: number): MenuEntry[] {
  return items.map((it, i): MenuEntry => {
    if (it.separator) return { kind: "separator" };
    if (it.children.length > 0) {
      return {
        id: `shx:${token}:${it.id}:${i}`,
        label: it.label,
        disabled: it.disabled,
        icon: iconEl(it),
        children: toEntries(it.children, token),
      };
    }
    return {
      id: `shi:${token}:${it.id}:${i}`,
      label: it.label,
      disabled: it.disabled,
      icon: iconEl(it),
      onSelect: () => invokeShellItem(token, it.id),
    };
  });
}

/**
 * 우클릭 — 셸 메뉴를 연다(캐시 있으면 즉시). 항목이 있으면 {token, entries}, 없으면 null.
 * `paths` 는 한 폴더 안의 선택(표시 순서). 같은 폴더인지는 백엔드가 검증한다.
 */
export async function openShellMenu(
  paths: string[],
  scope: ShellScope,
): Promise<{ token: number; entries: MenuEntry[] } | null> {
  const r = await commands.shellMenuOpen(paths, scope);
  if (r.status !== "ok" || r.data.items.length === 0) return null;
  return {
    token: r.data.token,
    entries: toEntries(r.data.items, r.data.token),
  };
}

/** 백그라운드 예열 — 그 경로 한 항목의 셸 메뉴를 미리 빌드해 캐시(fire-and-forget). */
export function warmShellMenu(path: string, scope: ShellScope): void {
  void commands.shellMenuWarm([path], scope);
}

/** 항목 우클릭의 "More options" 대상 — 선택된 실제 항목들(표시 순서)과 scope. */
export interface ShellMenuTarget {
  paths: string[];
  scope: ShellScope;
}

/**
 * 항목 우클릭에 셸 메뉴를 붙일 대상을 고른다. 대상이 없으면 null.
 * - Windows 로컬 폴더만(원격·가상 휴지통·macOS/Linux 는 셸 메뉴가 없다).
 * - 선택된 항목 **전부** — duet 자체 작업(`fileActions.resolveActiveTargets`)과 같은 집합.
 *   필터나 숨김 설정으로 지금 안 보이는 선택 항목도 포함한다(선택은 필터 뒤에도 유지된다).
 *   목록(`tab.entries`)에 없는 이름은 뺀다 — 종류를 모르고 셸이 찾지도 못한다.
 * - 순서는 패널의 현재 정렬 기준(필터·숨김과 무관). ".." 는 뺀다.
 * - scope 는 전부 폴더면 "directory", 하나라도 파일이면 "file" (백엔드 빌드는 scope 를
 *   안 쓰고 캐시 키로만 쓴다).
 */
export function shellMenuTarget(
  os: string,
  tab: TabState,
  selected: ReadonlySet<string>,
): ShellMenuTarget | null {
  const location = tab.location;
  if (os !== "windows") return null;
  if (location.source.kind !== "local" || isVirtualTrash(location)) return null;
  // 패널 정렬 그대로, 필터·숨김만 끈 전체 목록 — 표시 규칙과 같은 정렬 함수를 쓴다.
  const ordered = computeDisplayed({ ...tab, filter: "", showHidden: true });
  const items = ordered.filter((e) => e.name !== ".." && selected.has(e.name));
  if (items.length === 0) return null;
  return {
    paths: items.map((e) => String(childLocation(location, e.name).path)),
    scope: items.every((e) => e.kind === "dir") ? "directory" : "file",
  };
}

/**
 * 항목 우클릭 메뉴 끝에 붙일 "More options ▸" (구분선 포함). 대상이 없으면 빈 배열.
 * 셸 메뉴는 지금 요청해 두고(캐시 있으면 즉시), 하위 메뉴를 펼칠 때 결과를 쓴다 —
 * duet 메뉴는 셸 빌드를 기다리지 않고 바로 열린다(Win11 방식).
 */
export function entryMoreOptions(
  os: string,
  tab: TabState,
  selected: ReadonlySet<string>,
): MenuEntry[] {
  const target = shellMenuTarget(os, tab, selected);
  if (!target) return [];
  const shellPromise = openShellMenu(target.paths, target.scope);
  return [
    { kind: "separator" },
    {
      id: "win-more",
      label: i18n.t("menu.moreOptions"),
      loadChildren: async () => {
        const shell = await shellPromise;
        return shell ? shell.entries : [];
      },
    },
  ];
}
