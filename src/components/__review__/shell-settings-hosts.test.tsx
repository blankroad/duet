/**
 * shell-settings R2 (opus) — C-04 즐겨찾기 호스트·호스트 그룹·별명(nickname) 실행 확인.
 * 정상 동작 확인(it)과 결함 재현(it.fails)을 함께 둔다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const cmd = vi.hoisted(() => ({
  hostGroupsSet: vi.fn(),
  hostNicknameSet: vi.fn(),
}));
vi.mock("@/types/bindings", () => {
  const ok = () => Promise.resolve({ status: "ok", data: [] });
  return {
    commands: new Proxy(
      {},
      {
        get: (_t, k: string) =>
          (cmd as Record<string, unknown>)[k] ?? vi.fn(ok),
      },
    ),
    events: new Proxy(
      {},
      { get: () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }) },
    ),
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { Sidebar } from "@/components/Sidebar";
import { useUI } from "@/stores/ui";
import { useConnections } from "@/stores/connections";
import { useSavedHosts } from "@/stores/savedHosts";
import {
  useHostGroups,
  assignToGroup,
  deleteGroup,
} from "@/stores/sidebarGroups";
import { useHostNicknames, setHostNickname } from "@/stores/hostNicknames";
import { useSidebarFilter } from "@/stores/sidebarFilter";
import { useToast } from "@/stores/toast";
import { useNotices } from "@/stores/notices";

const props = {
  onHostActivate: vi.fn(),
  onAdHocOpen: vi.fn(),
  onSavedActivate: vi.fn(),
  onOpenLocation: vi.fn(),
  onOpenHostPath: vi.fn(),
  onAddBookmark: vi.fn(),
  onTrashActivate: vi.fn(),
  onEject: vi.fn(),
};
const host = (alias: string) => ({
  alias,
  host: `${alias}.example`,
  port: 22,
  user: "u",
  key_path: null,
});

/** 필터가 맞은 글자를 <mark> 로 쪼개므로 행 라벨은 textContent 로 찾는다. */
const hasLabel = (text: string) =>
  [...document.querySelectorAll("span")].some((el) => el.textContent === text);

async function renderSidebar() {
  await act(async () => {
    render(<Sidebar {...props} />);
  });
}

beforeEach(() => {
  cmd.hostGroupsSet.mockReset();
  cmd.hostNicknameSet.mockReset();
  // 백엔드 정규화 흉내: 받은 그대로 돌려준다.
  cmd.hostGroupsSet.mockImplementation((g: unknown) =>
    Promise.resolve({ status: "ok", data: g }),
  );
  useUI.setState({ sidebarOpen: true, collapsed: {} });
  useConnections.setState({ active: {}, hosts: [] });
  useSavedHosts.setState({ hosts: [host("alpha"), host("beta")] });
  useHostGroups.setState({
    groups: [
      { id: "g1", name: "Web", members: ["beta"] },
      { id: "g2", name: "DB", members: [] },
    ],
  });
  useHostNicknames.setState({ byAlias: {} });
  useSidebarFilter.setState({ q: "", focusNonce: 0 });
});
afterEach(() => {
  cleanup();
  useToast.getState().clear();
  useNotices.getState().clear();
});

describe("C-04 host groups", () => {
  it("그룹 사이 이동: 한 그룹에서 빠지고 다른 그룹 끝에 들어간다(중복 배정 없음)", async () => {
    await assignToGroup("beta", "g2");
    const sent = cmd.hostGroupsSet.mock.calls[0]![0];
    expect(sent).toEqual([
      { id: "g1", name: "Web", members: [] },
      { id: "g2", name: "DB", members: ["beta"] },
    ]);
    expect(useHostGroups.getState().groups[1]!.members).toEqual(["beta"]);
  });

  it("그룹 삭제: 그룹만 사라지고 멤버 호스트는 그룹 밖 목록에 남는다", async () => {
    await renderSidebar();
    expect(screen.getByText("Web")).toBeTruthy();
    await act(async () => deleteGroup("g1"));
    expect(screen.queryByText("Web")).toBeNull();
    expect(screen.getByText("beta")).toBeTruthy();
    expect(useSavedHosts.getState().hosts.map((h) => h.alias)).toContain(
      "beta",
    );
  });

  it("그룹 저장 실패: 화면을 이전 그룹 구성으로 되돌리고 오류 토스트", async () => {
    cmd.hostGroupsSet.mockResolvedValueOnce({
      status: "error",
      error: { kind: "Io", message: "disk full (os error 28)" },
    });
    const before = useHostGroups.getState().groups;
    await assignToGroup("alpha", "g2");
    expect(useHostGroups.getState().groups).toEqual(before);
    expect(useToast.getState().toasts.at(-1)?.kind).toBe("error");
  });
});

describe("C-04 nicknames", () => {
  it("별명 설정·해제(빈 문자열): 백엔드가 돌려준 맵으로 화면이 바뀐다", async () => {
    await renderSidebar();
    cmd.hostNicknameSet.mockResolvedValueOnce({
      status: "ok",
      data: { alpha: "결제 서버" },
    });
    await act(async () => setHostNickname("alpha", "결제 서버"));
    expect(screen.getByText("결제 서버")).toBeTruthy();
    cmd.hostNicknameSet.mockResolvedValueOnce({ status: "ok", data: {} });
    await act(async () => setHostNickname("alpha", ""));
    expect(cmd.hostNicknameSet).toHaveBeenLastCalledWith("alpha", "");
    expect(screen.queryByText("결제 서버")).toBeNull();
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("필터는 별명으로 찾는다(대조군)", async () => {
    useHostNicknames.setState({ byAlias: { alpha: "결제 서버" } });
    await renderSidebar();
    act(() => useSidebarFilter.getState().set("결제"));
    expect(hasLabel("결제 서버")).toBe(true);
  });

  it.fails(
    "shell-settings-30: 별명을 붙인 호스트도 행에 보이는 원래 이름(alias)으로 필터에 걸린다",
    async () => {
      useHostNicknames.setState({ byAlias: { alpha: "결제 서버" } });
      await renderSidebar();
      // 행에는 별명 옆에 alias "alpha" 가 작게 보인다(AliasHint) — 그걸 보고 친 검색어.
      expect(screen.getAllByText("alpha").length).toBeGreaterThan(0);
      act(() => useSidebarFilter.getState().set("alpha"));
      // 현재: matchesQuery(nicks[alias] ?? alias) — 별명만 보므로 행이 사라진다.
      expect(hasLabel("결제 서버")).toBe(true);
    },
  );
});
