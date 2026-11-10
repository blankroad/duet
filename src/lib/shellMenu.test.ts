import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry, Location } from "@/types/bindings";

const shellMenuOpen = vi.fn(async (..._a: unknown[]) => ({
  status: "ok" as const,
  data: {
    token: 7,
    items: [
      {
        id: 3,
        label: "Extract each archive to separate folder",
        separator: false,
        disabled: false,
        children: [],
        icon: null,
      },
    ],
  },
}));
const shellMenuWarm = vi.fn(async (..._a: unknown[]) => ({
  status: "ok" as const,
  data: null,
}));

const shellMenuInvoke = vi.fn(
  async (..._a: unknown[]): Promise<unknown> => ({ status: "ok", data: null }),
);

vi.mock("@/types/bindings", () => ({
  commands: {
    shellMenuOpen: (...a: unknown[]) => shellMenuOpen(...a),
    shellMenuWarm: (...a: unknown[]) => shellMenuWarm(...a),
    shellMenuInvoke: (...a: unknown[]) => shellMenuInvoke(...a),
  },
}));

import {
  entryMoreOptions,
  invokeShellItem,
  shellMenuTarget,
  warmShellMenu,
} from "./shellMenu";
import { VIRTUAL_TRASH_PATH } from "./trashView";
import { useToast } from "@/stores/toast";
import {
  usePanes,
  activeTab,
  computeDisplayed,
  type TabState,
} from "@/stores/panes";
import { resolveActiveTargets } from "@/lib/fileActions";
import i18n from "@/i18n";

const loc: Location = { source: { kind: "local" }, path: "C:\\work" };

function e(name: string, kind: Entry["kind"] = "file"): Entry {
  return {
    name,
    kind,
    size: kind === "dir" ? null : 1,
    modified_ms: null,
    permissions: null,
    hidden: false,
  };
}

// 목록(원본 순서는 일부러 뒤섞음) — 정렬은 패널 기준(이름 오름차순)으로 맞춘다.
const listing = [
  e("notes.txt"),
  e("c.zip"),
  e("sub", "dir"),
  e("a.zip"),
  e("b.zip"),
];

/** 활성(left) 패널을 이 목록·정렬·필터로 맞추고 그 탭을 돌려준다(실제 store, IPC 없음). */
function paneTab(
  location: Location = loc,
  opts: { filter?: string } = {},
): TabState {
  const s = usePanes.getState();
  s.setActivePane("left");
  s.setEntries("left", location, listing);
  s.setSort("left", "name", "asc");
  s.setFilter("left", opts.filter ?? "");
  return activeTab(usePanes.getState(), "left");
}

/** 반환된 메뉴에서 "More options" 항목을 찾는다. */
function winMore(entries: ReturnType<typeof entryMoreOptions>) {
  return entries.find((x) => "id" in x && x.id === "win-more");
}

describe("entryMoreOptions — 다중 선택 셸 메뉴 (mocked IPC, live 아님)", () => {
  beforeEach(() => {
    shellMenuOpen.mockClear();
    shellMenuWarm.mockClear();
  });

  it("Windows 로컬에서 압축 3개를 선택하면 More options 가 있고 3개 경로를 패널 정렬 순서로 넘긴다", async () => {
    const selected = new Set(["c.zip", "a.zip", "b.zip"]);
    const out = entryMoreOptions("windows", paneTab(), selected);
    const more = winMore(out);
    expect(more).toBeDefined();
    expect(shellMenuOpen).toHaveBeenCalledTimes(1);
    expect(shellMenuOpen).toHaveBeenCalledWith(
      ["C:\\work\\a.zip", "C:\\work\\b.zip", "C:\\work\\c.zip"],
      "file",
    );
    // 펼치면 셸 항목이 하위 메뉴로 온다.
    const children =
      more && "loadChildren" in more ? await more.loadChildren?.() : [];
    expect(children?.map((c) => ("label" in c ? c.label : ""))).toEqual([
      "Extract each archive to separate folder",
    ]);
  });

  it("단일 선택도 그대로 한 항목 배열로 연다", () => {
    const out = entryMoreOptions("windows", paneTab(), new Set(["b.zip"]));
    expect(winMore(out)).toBeDefined();
    expect(shellMenuOpen).toHaveBeenCalledWith(["C:\\work\\b.zip"], "file");
  });

  it("파일+폴더 혼합이면 scope=file, 폴더만이면 scope=directory", () => {
    const tab = paneTab();
    const mixed = shellMenuTarget(
      "windows",
      tab,
      new Set(["sub", "notes.txt"]),
    );
    expect(mixed?.scope).toBe("file");
    expect([...(mixed?.paths ?? [])].sort()).toEqual([
      "C:\\work\\notes.txt",
      "C:\\work\\sub",
    ]);
    expect(shellMenuTarget("windows", tab, new Set(["sub"]))).toEqual({
      paths: ["C:\\work\\sub"],
      scope: "directory",
    });
  });

  it('".." 는 대상에서 빠지고, 그것만이면 메뉴 항목이 없다', () => {
    const tab = paneTab();
    expect(shellMenuTarget("windows", tab, new Set(["..", "a.zip"]))).toEqual({
      paths: ["C:\\work\\a.zip"],
      scope: "file",
    });
    expect(entryMoreOptions("windows", tab, new Set([".."]))).toEqual([]);
    expect(shellMenuOpen).not.toHaveBeenCalled();
  });

  it("필터로 가려진 선택 항목도 패널 정렬 순서로 전부 넘긴다", () => {
    const tab = paneTab(loc, { filter: "a.zip" });
    expect(computeDisplayed(tab).map((x) => x.name)).toEqual(["a.zip"]);
    entryMoreOptions("windows", tab, new Set(["c.zip", "a.zip", "b.zip"]));
    expect(shellMenuOpen).toHaveBeenCalledWith(
      ["C:\\work\\a.zip", "C:\\work\\b.zip", "C:\\work\\c.zip"],
      "file",
    );
  });

  it("Windows 가 아니거나 원격/가상 휴지통이면 More options 가 없다", () => {
    const sel = new Set(["a.zip", "b.zip"]);
    expect(entryMoreOptions("macos", paneTab(), sel)).toEqual([]);
    expect(entryMoreOptions("linux", paneTab(), sel)).toEqual([]);
    const remote: Location = {
      source: {
        kind: "ssh",
        connection_id: "c1",
        host_ip: "10.0.0.1",
        user: "u",
      },
      path: "/srv",
    };
    expect(entryMoreOptions("windows", paneTab(remote), sel)).toEqual([]);
    const trash: Location = {
      source: { kind: "local" },
      path: VIRTUAL_TRASH_PATH,
    };
    expect(entryMoreOptions("windows", paneTab(trash), sel)).toEqual([]);
    expect(shellMenuOpen).not.toHaveBeenCalled();
  });

  it("예열은 한 항목을 배열로 보낸다", () => {
    warmShellMenu("C:\\work\\a.zip", "file");
    expect(shellMenuWarm).toHaveBeenCalledWith(["C:\\work\\a.zip"], "file");
  });
});

// Sol L2 repro (shell-sol src/lib/shellMenu.test.ts:149), it.fails → it.
// Adapted for the R2 API: shellMenuTarget now takes the tab, not a displayed list.
it("UX-SHL-01 L2: native More keeps filtered-out selected items like duet actions", () => {
  const state = usePanes.getState();
  state.setActivePane("left");
  state.setEntries("left", loc, [e("a.zip"), e("b.zip"), e("c.zip")]);
  state.setSelected("left", ["c.zip", "a.zip", "b.zip"]);
  state.setFilter("left", "a.zip");
  const tab = activeTab(usePanes.getState(), "left");
  const ownNames = resolveActiveTargets()
    .targets.map((t) => t.name)
    .sort();
  expect(ownNames).toEqual(["a.zip", "b.zip", "c.zip"]);
  const target = shellMenuTarget("windows", tab, tab.selected);
  const nativeNames = target?.paths
    .map((p) => p.replaceAll("\\", "/").split("/").pop())
    .sort();
  expect(nativeNames).toEqual(ownNames);
});

describe("invokeShellItem — 실행 실패 피드백 (UX-SHL-03, mocked IPC)", () => {
  beforeEach(() => {
    shellMenuInvoke.mockReset();
  });

  it("성공이면 토스트 없음", async () => {
    shellMenuInvoke.mockResolvedValueOnce({ status: "ok", data: null });
    const show = vi.spyOn(useToast.getState(), "show");
    await invokeShellItem(7, 3);
    expect(shellMenuInvoke).toHaveBeenCalledWith(7, 3);
    expect(show).not.toHaveBeenCalled();
    show.mockRestore();
  });

  it("만료된 메뉴(NotFound)면 다시 열라는 오류 토스트", async () => {
    shellMenuInvoke.mockResolvedValueOnce({
      status: "error",
      error: { kind: "NotFound", message: "shell menu expired; open it again" },
    });
    const show = vi.spyOn(useToast.getState(), "show");
    await invokeShellItem(7, 3);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[0]).toBe(i18n.t("toast.shellMenuExpired"));
    expect(show.mock.calls[0]?.[1]).toBe("error");
    show.mockRestore();
  });

  it("사용자 취소(Cancelled)면 조용히", async () => {
    shellMenuInvoke.mockResolvedValueOnce({
      status: "error",
      error: { kind: "Cancelled" },
    });
    const show = vi.spyOn(useToast.getState(), "show");
    await invokeShellItem(7, 3);
    expect(show).not.toHaveBeenCalled();
    show.mockRestore();
  });

  it("셸 명령 실패(Io)면 실패 토스트", async () => {
    shellMenuInvoke.mockResolvedValueOnce({
      status: "error",
      error: { kind: "Io", message: "shell command failed: x (0x80004005)" },
    });
    const show = vi.spyOn(useToast.getState(), "show");
    await invokeShellItem(7, 3);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[1]).toBe("error");
    show.mockRestore();
  });
});
