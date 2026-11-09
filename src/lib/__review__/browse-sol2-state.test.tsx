import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { usePanes, activeTab, computeDisplayed } from "@/stores/panes";
import { resolveActiveTargets, clipCopy, clipPaste } from "@/lib/fileActions";
import { useClipboard } from "@/stores/clipboard";
import { useEntryDrag } from "@/hooks/useEntryDrag";
import { useDragState } from "@/stores/dragState";
import { patternToMatcher } from "@/lib/glob";
import { sameLocation, sameLocationDir } from "@/lib/entryDnd";
import { rememberSelfDrag, selfDropKind } from "@/lib/selfDrag";
import { buildEntryMenu } from "@/lib/entryMenu";
import { StatusBar } from "@/components/StatusBar";
import { useAppSettings } from "@/stores/settings";
import i18n from "@/i18n";
import type { Entry, Location } from "@/types/bindings";

const mocks = vi.hoisted(() => ({
  copyPlan: vi.fn(async () => ({
    status: "ok",
    data: { items: [], conflicts: [], total_bytes: 0 },
  })),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));
vi.mock("@/lib/dropTarget", () => ({
  resolveDropAt: () => null,
  resolveSidebarDropAt: () => null,
  BOOKMARK_ADD_ZONE: "bookmark-add",
}));
vi.mock("@/lib/dragOut", () => ({
  resolveDragPaths: async () => [],
  startDragWithPaths: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({
  commands: new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "fsCopyPlan"
          ? mocks.copyPlan
          : async () => ({ status: "ok", data: [] }),
    },
  ),
  events: {},
}));

const local = (path: string): Location => ({ source: { kind: "local" }, path });
const remote: Location = {
  source: {
    kind: "ssh",
    connection_id: "r2-server:one",
    host_ip: "10.0.0.8",
    user: "review",
  },
  path: "/r2-source",
};
const file = (name: string, kind: Entry["kind"] = "file"): Entry => ({
  name,
  kind,
  size: kind === "file" ? 1 : null,
  modified_ms: 1,
  permissions: null,
  hidden: false,
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.clearAllMocks();
  useClipboard.getState().clear();
  useAppSettings.getState().setConfirmTransfer("always");
  usePanes.getState().restoreLayout({
    activePane: "left",
    panes: {
      left: {
        activeTabIndex: 0,
        tabs: [
          {
            path: "/r2-source",
            sortKey: "name",
            sortOrder: "asc",
            showHidden: false,
            viewMode: "details",
          },
        ],
      },
      right: {
        activeTabIndex: 0,
        tabs: [
          {
            path: "/r2-destination",
            sortKey: "name",
            sortOrder: "asc",
            showHidden: false,
            viewMode: "details",
          },
        ],
      },
    },
  });
});
afterEach(() => {
  fireEvent.keyDown(window, { key: "Escape" });
  cleanup();
  useDragState.getState().end();
});

function filteredSelection() {
  usePanes
    .getState()
    .setEntries("left", remote, [file("visible.log"), file("private.db")]);
  usePanes.getState().selectAll("left");
  usePanes.getState().setFilter("left", ".log");
  expect(
    computeDisplayed(activeTab(usePanes.getState(), "left")).map((e) => e.name),
  ).toEqual(["visible.log"]);
}

it.fails(
  "browse-03: filtering excludes concealed selections from operations",
  () => {
    filteredSelection();
    expect(resolveActiveTargets().targets.map((e) => e.name)).toEqual([
      "visible.log",
    ]);
  },
);

it.fails("browse-03: clipboard copy excludes concealed selections", () => {
  filteredSelection();
  clipCopy(vi.fn());
  expect(useClipboard.getState().entry?.targets.map((e) => e.name)).toEqual([
    "visible.log",
  ]);
});

it.fails("browse-03: in-app drag excludes concealed selections", () => {
  filteredSelection();
  function DragButton() {
    const drag = useEntryDrag("left");
    return (
      <button onMouseDown={(e) => drag(e, file("visible.log"))}>drag</button>
    );
  }
  const view = render(<DragButton />);
  fireEvent.mouseDown(view.getByText("drag"), {
    button: 0,
    clientX: 10,
    clientY: 10,
  });
  fireEvent.mouseMove(window, { clientX: 40, clientY: 40 });
  expect(useDragState.getState().active).toBe(true);
  expect(useDragState.getState().targets.map((e) => e.name)).toEqual([
    "visible.log",
  ]);
});

it.fails("browse-03: context menu copy excludes concealed selections", () => {
  filteredSelection();
  const entries = buildEntryMenu({
    paneId: "left",
    entry: file("visible.log"),
    location: remote,
    selectedCount: 2,
    onActivate: vi.fn(),
    onOpenInOtherPane: vi.fn(),
  });
  const copy = entries.find((e) => "id" in e && e.id === "clip-copy");
  if (!copy || !("onSelect" in copy)) throw new Error("copy menu not found");
  copy.onSelect?.();
  expect(useClipboard.getState().entry?.targets.map((e) => e.name)).toEqual([
    "visible.log",
  ]);
});

it.fails(
  "browse-03: visible-only selection count is shown in status bar",
  () => {
    filteredSelection();
    const view = render(<StatusBar />);
    expect(view.container.textContent).toContain("1 selected");
  },
);

it("browse-14: a grandchild destination is rejected before copy planning", async () => {
  useClipboard
    .getState()
    .set([{ location: local("/sandbox"), name: "project" }], "copy");
  await clipPaste(vi.fn(), vi.fn(), local("/sandbox/project/cache/deep"));
  expect(mocks.copyPlan).not.toHaveBeenCalled();
});

it("browse-14: equivalent Windows spelling is rejected for direct self paste", async () => {
  useClipboard
    .getState()
    .set([{ location: local("C:\\sandbox"), name: "project" }], "copy");
  await clipPaste(vi.fn(), vi.fn(), local("C:/sandbox/project/"));
  expect(mocks.copyPlan).not.toHaveBeenCalled();
});

it("browse-14: OS self-drop already normalizes equivalent Windows spelling", () => {
  rememberSelfDrag(["C:\\sandbox\\project"], local("C:\\sandbox"), ["project"]);
  expect(
    selfDropKind(["C:\\sandbox\\project"], local("C:/sandbox/project/")),
  ).toBe("self");
  expect(sameLocation(local("C:\\sandbox"), local("C:/sandbox/"))).toBe(false);
  expect(sameLocationDir(local("C:\\sandbox"), local("C:/sandbox/"))).toBe(
    true,
  );
});

it("browse-14: OS self-drop blocks descendants as well as direct self", () => {
  rememberSelfDrag(["/sandbox/project"], local("/sandbox"), ["project"]);
  expect(
    selfDropKind(["/sandbox/project"], local("/sandbox/project/cache")),
  ).toBe("self");
});

it.fails(
  "browse-25: exclamation-negated class selects names outside its set",
  () => {
    expect(patternToMatcher("[!ab]*.log")("c.log")).toBe(true);
    expect(patternToMatcher("[!ab]*.log")("a.log")).toBe(false);
  },
);

it.fails(
  "browse-25: a backslash inside a glob class is not a regex digit operator",
  () => {
    const matches = patternToMatcher("[\\d]*");
    expect(matches("d-file")).toBe(true);
    expect(matches("7-file")).toBe(false);
  },
);

it.each([
  ["^*.txt", "^note.txt", true],
  ["^*.txt", "note.txt", false],
  ["a.b*", "a.b1", true],
  ["a.b*", "axb1", false],
  ["a\\b*", "a\\bbb", true],
  ["]", "]", true],
  ["]", "unrelated", false],
  ["[ab].txt", "a.txt", true],
  ["[^a]*", "b.txt", true],
  ["file[", "file[", true],
  ["a]b*", "a]bbb", true],
] as const)("glob literal/class %s versus %s", (pattern, name, expected) => {
  expect(patternToMatcher(pattern)(name)).toBe(expected);
});

it.fails(
  "browse-28: computed directory sizes determine ascending size order",
  () => {
    usePanes
      .getState()
      .setEntries("left", local("/"), [
        file("a-large", "dir"),
        file("z-small", "dir"),
      ]);
    const id = activeTab(usePanes.getState(), "left").id;
    usePanes.getState().setDirSize("left", id, "a-large", 1_000_000);
    usePanes.getState().setDirSize("left", id, "z-small", 2);
    usePanes.getState().setSort("left", "size", "asc");
    expect(
      computeDisplayed(activeTab(usePanes.getState(), "left")).map(
        (e) => e.name,
      ),
    ).toEqual(["z-small", "a-large"]);
  },
);
