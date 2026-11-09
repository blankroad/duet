/**
 * shell-settings 점검 (C-03 북마크 · C-06 선반 · C-07 태그) 재현 테스트.
 * 결함을 재현하는 것은 `it.fails` 로 표시한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Bookmark, EntryRef, Location } from "@/types/bindings";

const cmd = vi.hoisted(() => ({
  bookmarksList: vi.fn(),
  bookmarksRemove: vi.fn(),
  hostFavoritesAdd: vi.fn(),
  tagSet: vi.fn(),
  fsCopyPlan: vi.fn(),
  fsMovePlan: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({ commands: cmd }));

import i18n from "@/i18n";
import { useToast } from "@/stores/toast";
import { useNotices } from "@/stores/notices";
import {
  useBookmarks,
  bootstrapBookmarks,
  removeBookmark,
} from "@/stores/bookmarks";
import { useHostFavorites } from "@/stores/hostFavorites";
import { useTags, bmTagKey } from "@/stores/tags";
import { TagBar } from "@/components/TagBar";
import { StateDot } from "@/components/Sidebar";
import { useShelf } from "@/stores/shelf";
import { usePanes } from "@/stores/panes";
import { applyShelfTo } from "@/lib/fileActions";
import { VIRTUAL_TRASH_PATH } from "@/lib/trashView";

const local = (path: string): Location => ({ source: { kind: "local" }, path });
const sshLoc = (path: string): Location => ({
  source: {
    kind: "ssh",
    connection_id: "prod:1111",
    host_ip: "10.0.0.1",
    user: "u",
  },
  path,
});
const ref = (location: Location, name: string): EntryRef => ({
  location,
  name,
});

function resetShelf() {
  const st = useShelf.getState;
  while (st().sections.length > 1)
    st().deleteSection(st().sections[st().sections.length - 1]!.id);
  st().clear();
  st().setTarget(st().sections[0]!.id);
}

beforeEach(() => {
  for (const f of Object.values(cmd)) f.mockReset();
  useBookmarks.getState().setAll([]);
  useHostFavorites.getState().setAll([]);
  useTags.getState().setAll({});
  resetShelf();
});
afterEach(() => {
  cleanup();
  useToast.getState().clear();
  useNotices.getState().clear();
});

describe("C-03 bookmarks", () => {
  it.fails(
    "shell-settings-13: 사이드바로 끌어 북마크하면 토스트에 이름이 들어간다({{name}} 그대로 아님)",
    () => {
      // useEntryDrag.ts:175 가 count 만 넘기는 그대로 재현 — 키는 {{name}} 을 기대한다.
      const shown = i18n.t("toast.bookmarkAdded", { count: 2 });
      expect(shown).not.toContain("{{name}}");
    },
  );

  it("shell-settings-03: 레거시 SSH 북마크 이전은 즐겨찾기 추가가 실패하면 원본 북마크를 지우지 않는다", async () => {
    const legacy: Bookmark = {
      id: "b1",
      name: "logs",
      location: sshLoc("/var/log"),
    };
    cmd.bookmarksList.mockResolvedValue({ status: "ok", data: [legacy] });
    cmd.hostFavoritesAdd.mockResolvedValue({
      status: "error",
      error: { kind: "Io", message: "disk full (os error 28)" },
    });
    cmd.bookmarksRemove.mockResolvedValue({ status: "ok", data: [] });
    await bootstrapBookmarks();
    // 현재: 추가 실패를 무시하고 remove → 북마크가 어디에도 남지 않는다.
    expect(cmd.bookmarksRemove).not.toHaveBeenCalled();
  });
});

describe("C-07 tags", () => {
  it.fails(
    "shell-settings-19: 북마크를 지우면 그 북마크의 태그도 지워진다(유령 태그 칩 없음)",
    async () => {
      useBookmarks
        .getState()
        .setAll([{ id: "b1", name: "proj", location: local("/p") }]);
      useTags.getState().setAll({ [bmTagKey("b1")]: ["work"] });
      cmd.bookmarksRemove.mockResolvedValue({ status: "ok", data: [] });
      cmd.tagSet.mockResolvedValue({ status: "ok", data: {} });
      await removeBookmark("b1");
      render(<TagBar />);
      // 현재: 태그 칩 #work 가 남고, 누르면 사이드바가 "일치 없음" 만 보인다.
      expect(screen.queryByRole("button", { name: "#work" })).toBeNull();
    },
  );
});

describe("C-06 shelf apply", () => {
  it.fails(
    "shell-settings-06: 소스가 둘인 선반을 '다시 적용'하면 남은(두 번째) 그룹이 처리된다",
    async () => {
      useShelf
        .getState()
        .add([ref(local("/a"), "a.txt"), ref(sshLoc("/srv"), "b.txt")]);
      cmd.fsCopyPlan.mockResolvedValue({
        status: "error",
        error: { kind: "Cancelled", message: "stop here" },
      });
      const open = vi.fn();
      const toast = vi.fn();
      await applyShelfTo("copy", open, toast);
      expect(toast).toHaveBeenCalledWith(
        i18n.t("toast.shelfGroupsLeft", { count: 1 }),
      );
      // 안내대로 다시 적용.
      await applyShelfTo("copy", open, toast);
      const second = cmd.fsCopyPlan.mock.calls[1]![0] as EntryRef[];
      // 현재: 적용한 항목이 선반에 그대로라 또 첫 그룹(로컬 a.txt)만 간다 — ssh 그룹엔 영영 도달 못 함.
      expect(second[0]!.location.source.kind).toBe("ssh");
    },
  );

  it.fails(
    "shell-settings-31: 활성 패널이 가상 휴지통이면 선반 적용을 막는다(F5 와 같게)",
    async () => {
      usePanes.getState().setEntries("left", local(VIRTUAL_TRASH_PATH), []);
      usePanes.getState().setActivePane("left");
      useShelf.getState().add([ref(local("/a"), "a.txt")]);
      cmd.fsCopyPlan.mockResolvedValue({
        status: "error",
        error: { kind: "Io", message: "x" },
      });
      await applyShelfTo("copy", vi.fn(), vi.fn());
      expect(cmd.fsCopyPlan).not.toHaveBeenCalled();
    },
  );
});

describe("C-08 state dot", () => {
  it.fails(
    "shell-settings-22: 연결 오류 점에 마우스를 올리면 이유가 보인다(title)",
    () => {
      const { container } = render(
        <StateDot
          state={{ kind: "error", message: "authentication failed" }}
        />,
      );
      // 현재: aria-label 만 있고 title 이 없어 마우스 사용자는 이유를 볼 곳이 없다
      // (호스트 행 title 은 user@host:port 만).
      expect(container.querySelector("[title]")).not.toBeNull();
    },
  );

  it.fails(
    "shell-settings-22: 연결됨/끊김 점이 화면 읽기 프로그램에 상태로 읽힌다(role 있음)",
    () => {
      render(<StateDot state={{ kind: "connected" }} />);
      // 현재: role 없는 <span aria-label> — 일반 span 의 aria-label 은 무시된다.
      expect(screen.getByRole("img")).toBeTruthy();
    },
  );
});
