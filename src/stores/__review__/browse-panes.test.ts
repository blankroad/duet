import { beforeEach, describe, expect, it } from "vitest";
import {
  usePanes,
  activeTab,
  computeDisplayed,
  type TabState,
} from "@/stores/panes";
import { clearClosedTabs } from "@/stores/closedTabs";
import { resolveActiveTargets } from "@/lib/fileActions";
import { patternToMatcher } from "@/lib/glob";
import type { Entry, Location } from "@/types/bindings";

/**
 * browse 점검 R1 (opus) — 탭·목록 표시·선택 store 수준 재현/회귀 테스트.
 * 결함 재현은 it.fails 로 표시 (수정 라운드에서 떼면 회귀 테스트가 된다).
 */

const mk = (
  name: string,
  kind: "dir" | "file" = "file",
  extra: Partial<Entry> = {},
): Entry =>
  ({
    name,
    kind,
    size: kind === "dir" ? null : 10,
    modified_ms: 1,
    permissions: null,
    hidden: false,
    ...extra,
  }) as Entry;

const local = (path: string): Location => ({ source: { kind: "local" }, path });

function seed(tabs: Array<Partial<TabState> & { path: string }>, active = 0) {
  const base = usePanes.getState().panes.left.tabs[0]!;
  const mkTab = (
    t: Partial<TabState> & { path: string },
    i: number,
  ): TabState => {
    const { path, ...rest } = t;
    return {
      ...base,
      id: `L${i}`,
      location: local(path),
      entries: [],
      cursorIndex: -1,
      selected: new Set(),
      sortKey: "name",
      sortOrder: "asc",
      showHidden: false,
      viewMode: "details",
      filter: "",
      filterFocused: false,
      dirSizes: {},
      history: { stack: [local(path)], index: 0 },
      archive: undefined,
      trashRoot: undefined,
      pinned: false,
      ...rest,
    };
  };
  usePanes.setState({
    activePane: "left",
    panes: {
      left: { tabs: tabs.map(mkTab), activeTabIndex: active },
      right: {
        tabs: [{ ...mkTab({ path: "/r" }, 0), id: "R0" }],
        activeTabIndex: 0,
      },
    },
  });
}

const L = () => usePanes.getState().panes.left;
const names = (es: Entry[]) => es.map((e) => e.name);

beforeEach(() => clearClosedTabs());

describe("C-12 빠른 필터 × 선택 — 보이지 않는 파일이 작업 대상이 되는가", () => {
  it("browse-03 (F-opus-01): 전체 선택 후 필터를 입력하면 가려진 항목이 작업 대상에 남는다", () => {
    seed([
      {
        path: "/w",
        entries: [mk("keep.txt"), mk("secret.db"), mk("notes.txt")],
      },
    ]);
    const st = usePanes.getState();
    st.selectAll("left");
    st.setFilter("left", ".txt"); // secret.db 는 화면에서 사라진다
    const shown = names(
      computeDisplayed(activeTab(usePanes.getState(), "left")),
    );
    expect(shown).not.toContain("secret.db");
    // 사용자가 보는 것: keep.txt, notes.txt 두 개. Delete/F5/F6 대상은?
    const targets = resolveActiveTargets().targets.map((t) => t.name);
    expect(targets.sort()).toEqual(["keep.txt", "notes.txt"]);
  });

  it("대조: 숨김 토글은 가려진 선택을 정리한다 (같은 문제를 이미 막아 둠)", () => {
    seed([
      {
        path: "/w",
        showHidden: true,
        entries: [mk("a.txt"), mk(".env", "file", { hidden: true })],
      },
    ]);
    const st = usePanes.getState();
    st.selectAll("left");
    st.toggleShowHidden("left");
    expect([...activeTab(usePanes.getState(), "left").selected]).toEqual([
      "a.txt",
    ]);
  });
});

describe("C-09 탭 — 복제·핀·닫기·복원", () => {
  it("복제 탭은 히스토리·선택·정렬·필터를 원본과 공유하지 않는다", () => {
    seed([
      {
        path: "/a",
        entries: [mk("x"), mk("y")],
        history: { stack: [local("/"), local("/a")], index: 1 },
      },
    ]);
    const st = usePanes.getState();
    st.toggleSelected("left", "x");
    st.setFilter("left", "x");
    st.duplicateTab("left", 0);
    expect(L().activeTabIndex).toBe(1);
    const copyId = L().tabs[1]!.id;
    // 복제 탭에서 이동·정렬·선택·필터를 바꾼다
    usePanes
      .getState()
      .setEntries("left", local("/b"), [mk("z")], { tabId: copyId });
    usePanes.getState().toggleSortKey("left", "size");
    usePanes.getState().toggleSelected("left", "z");
    usePanes.getState().setFilter("left", "zz");
    const orig = L().tabs[0]!;
    expect(orig.location.path).toBe("/a");
    expect(orig.history.stack.map((l) => l.path)).toEqual(["/", "/a"]);
    expect(orig.history.index).toBe(1);
    expect([...orig.selected]).toEqual(["x"]);
    expect(orig.filter).toBe("x");
    expect(orig.sortKey).toBe("name");
    // 복제본은 선택·필터가 비어서 시작
    const copy = L().tabs[1]!;
    expect(copy.history.stack.map((l) => l.path)).toEqual(["/", "/a", "/b"]);
  });

  it("핀 탭은 다른 탭 닫기 / 오른쪽 닫기 / 모두 닫기에서 살아남는다", () => {
    seed(
      [
        { path: "/p1", pinned: true },
        { path: "/p2", pinned: true },
        { path: "/n1" },
        { path: "/n2" },
      ],
      3,
    );
    usePanes.getState().closeOtherTabs("left", 2);
    expect(L().tabs.map((t) => t.location.path)).toEqual(["/p1", "/p2", "/n1"]);
    expect(L().activeTabIndex).toBe(2);
    usePanes.getState().closeTabsToRight("left", 0);
    expect(L().tabs.map((t) => t.location.path)).toEqual(["/p1", "/p2"]);
    // 활성이던 /n1 이 닫혀 기준 탭(/p1)으로
    expect(L().tabs[L().activeTabIndex]!.location.path).toBe("/p1");
    usePanes.getState().closeAllTabs("left");
    expect(L().tabs.map((t) => t.location.path)).toEqual(["/p1", "/p2"]);
  });

  it("마지막 탭·핀 탭은 closeTab 이 거부한다", () => {
    seed([{ path: "/only" }]);
    expect(usePanes.getState().closeTab("left", 0)).toBe(false);
    seed([{ path: "/p", pinned: true }, { path: "/n" }]);
    expect(usePanes.getState().closeTab("left", 0)).toBe(false);
    expect(L().tabs).toHaveLength(2);
  });

  it("일반 탭을 핀 구간 안으로 드래그하면 핀 구간 바로 뒤로 간다", () => {
    seed([
      { path: "/p1", pinned: true },
      { path: "/p2", pinned: true },
      { path: "/n" },
    ]);
    usePanes.getState().reorderTabs("left", ["L2", "L0", "L1"]);
    expect(L().tabs.map((t) => t.id)).toEqual(["L0", "L1", "L2"]);
    // 키보드 이동도 경계를 넘지 않는다
    usePanes.getState().moveTab("left", 2, -1);
    expect(L().tabs.map((t) => t.id)).toEqual(["L0", "L1", "L2"]);
  });

  it("닫은 탭 복원: 원래 패널·자리·히스토리·정렬로 돌아온다 (반대 패널에서 눌러도)", () => {
    seed([
      { path: "/a" },
      {
        path: "/b",
        sortKey: "size",
        sortOrder: "desc",
        viewMode: "grid",
        history: { stack: [local("/"), local("/b")], index: 1 },
      },
      { path: "/c" },
    ]);
    usePanes.getState().closeTab("left", 1);
    usePanes.getState().setActivePane("right");
    expect(usePanes.getState().reopenClosedTab()).toBe(true);
    const s = usePanes.getState();
    expect(s.activePane).toBe("left");
    const t = L().tabs[1]!;
    expect(t.location.path).toBe("/b");
    expect(L().activeTabIndex).toBe(1);
    expect(t.sortKey).toBe("size");
    expect(t.viewMode).toBe("grid");
    expect(t.history.stack.map((l) => l.path)).toEqual(["/", "/b"]);
  });

  it("닫은 원격 탭(연결 종료 후)을 복원하면 죽은 connection_id 그대로 돌아온다 — 복원 자리표시자(RESTORED_CONN) 아님", () => {
    const ssh: Location = {
      source: {
        kind: "ssh",
        connection_id: "prod:u1",
        host_ip: "1.2.3.4",
        user: "d",
      },
      path: "/srv",
    };
    seed([{ path: "/a" }, { path: "/srv" }]);
    usePanes.setState((s) => {
      const tabs = s.panes.left.tabs.slice();
      tabs[1] = {
        ...tabs[1]!,
        location: ssh,
        history: { stack: [ssh], index: 0 },
      };
      return { panes: { ...s.panes, left: { ...s.panes.left, tabs } } };
    });
    usePanes.getState().closeTab("left", 1);
    usePanes.getState().reopenClosedTab();
    const loc = L().tabs[1]!.location;
    // 기록용: 연결이 닫혔으면 이 탭은 onRefresh 에서 listDirectory("prod:u1") 를 시도한다
    expect(loc.source.kind === "ssh" && loc.source.connection_id).toBe(
      "prod:u1",
    );
  });
});

describe("C-12 정렬", () => {
  const show = (entries: Entry[], extra: Partial<TabState> = {}) => {
    seed([{ path: "/", entries, ...extra }]);
    return names(computeDisplayed(activeTab(usePanes.getState(), "left")));
  };

  it("자연 정렬: file2 < file10, 폴더 우선", () => {
    expect(
      show([mk("file10"), mk("file2"), mk("zdir", "dir"), mk("File1")]),
    ).toEqual(["zdir", "File1", "file2", "file10"]);
  });

  it("대소문자만 다른 이름(리눅스 원격)은 둘 다 보이고, 목록 순서가 바뀌어도 순서가 같다", () => {
    const a = show([mk("a.txt"), mk("A.txt"), mk("b")]);
    const b = show([mk("A.txt"), mk("a.txt"), mk("b")]);
    expect(a).toContain("a.txt");
    expect(a).toContain("A.txt");
    // collator sensitivity:"base" → 두 이름이 '같음' 이라 입력(백엔드 목록) 순서를 따른다.
    // 기록: 백엔드 순서가 바뀌면 두 줄도 자리를 바꾼다 (이름 tie-break 없음).
    expect(a.slice(0, 2)).toEqual(["a.txt", "A.txt"]);
    expect(b.slice(0, 2)).toEqual(["A.txt", "a.txt"]);
  });

  it("확장자 정렬: 확장자 없는 파일 → 점파일 처리", () => {
    const out = show(
      [
        mk("b.txt"),
        mk("Makefile"),
        mk(".bashrc", "file", { hidden: false }),
        mk("a.md"),
      ],
      { sortKey: "ext" },
    );
    // 기록: .bashrc 의 '확장자' 가 "bashrc" 로 취급된다
    expect(out).toEqual(["Makefile", ".bashrc", "a.md", "b.txt"]);
  });

  it.fails(
    "browse-28 (F-opus-08): 크기 정렬이 '크기 계산' 결과(dirSizes)를 쓰지 않는다 — 폴더는 크기 0 취급",
    () => {
      const out = show([mk("big", "dir"), mk("small", "dir")], {
        sortKey: "size",
        sortOrder: "desc",
        dirSizes: { big: 9_000_000, small: 1 },
      });
      // 계산한 크기 기준이면 big, small 이어야 한다
      expect(out).toEqual(["big", "small"]);
    },
  );
});

describe("C-12 패턴 선택", () => {
  it("*.txt 는 대소문자 무시, 숨김 항목은 숨김 표시가 꺼져 있으면 안 잡힌다", () => {
    seed([
      {
        path: "/",
        entries: [
          mk("A.TXT"),
          mk("b.txt"),
          mk(".h.txt", "file", { hidden: true }),
          mk("c.md"),
        ],
      },
    ]);
    const n = usePanes.getState().selectByPattern("left", "*.txt", "add");
    expect(n).toBe(2);
    expect([...activeTab(usePanes.getState(), "left").selected].sort()).toEqual(
      ["A.TXT", "b.txt"],
    );
  });

  it.fails(
    "browse-25 (F-opus-07): glob 부정 클래스 [!a]* 가 부정으로 해석되지 않는다",
    () => {
      const m = patternToMatcher("[!a]*");
      expect(m("b.txt")).toBe(true);
      expect(m("a.txt")).toBe(false);
    },
  );

  it("중괄호 {a,b} 는 지원하지 않고 부분문자열로 처리된다 (기록)", () => {
    const m = patternToMatcher("*.{jpg,png}");
    expect(m("x.jpg")).toBe(false);
  });
});

describe("C-13 선택 — '..' 제외", () => {
  it("전체 선택·반전·범위 선택 모두 '..' 를 넣지 않는다", () => {
    seed([{ path: "/x", entries: [mk("a"), mk("b")] }]);
    const st = usePanes.getState();
    st.selectAll("left");
    expect([...activeTab(usePanes.getState(), "left").selected].sort()).toEqual(
      ["a", "b"],
    );
    st.clearSelection("left");
    st.invertSelection("left");
    expect(activeTab(usePanes.getState(), "left").selected.has("..")).toBe(
      false,
    );
    st.selectRange("left", 0, 2);
    expect([...activeTab(usePanes.getState(), "left").selected].sort()).toEqual(
      ["a", "b"],
    );
  });
});
