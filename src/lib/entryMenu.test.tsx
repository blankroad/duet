import { describe, it, expect, beforeEach } from "vitest";
import { buildEntryMenu, buildEmptyMenu } from "./entryMenu";
import {
  isSeparator,
  type MenuEntry,
  type MenuItem,
} from "@/stores/contextMenu";
import { useConnections } from "@/stores/connections";
import type { Entry, Location } from "@/types/bindings";

const localLoc: Location = { source: { kind: "local" }, path: "/home/u" };
const dir: Entry = {
  name: "proj",
  kind: "dir",
  size: null,
  modified_ms: null,
  permissions: null,
  hidden: false,
};
const file: Entry = {
  name: "a.txt",
  kind: "file",
  size: 10,
  modified_ms: null,
  permissions: null,
  hidden: false,
};

const ids = (items: MenuEntry[]) =>
  items.filter((e): e is MenuItem => !isSeparator(e)).map((e) => e.id);

const noop = () => {};

describe("buildEntryMenu", () => {
  beforeEach(() => {
    useConnections.setState({ active: {} });
  });

  it("includes Open / Open-in-other-pane for a single directory", () => {
    const menu = buildEntryMenu({
      paneId: "left",
      entry: dir,
      location: localLoc,
      selectedCount: 1,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    expect(ids(menu)).toContain("open");
    expect(ids(menu)).toContain("open-other");
  });

  it("includes Open (external) but not Open-in-other-pane for a file", () => {
    const menu = buildEntryMenu({
      paneId: "left",
      entry: file,
      location: localLoc,
      selectedCount: 1,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    expect(ids(menu)).toContain("open");
    expect(ids(menu)).not.toContain("open-other");
    // 일반 파일은 압축 해제 항목 없음.
    expect(ids(menu)).not.toContain("extract");
  });

  it("offers both New folder and New file", () => {
    const menu = buildEntryMenu({
      paneId: "left",
      entry: file,
      location: localLoc,
      selectedCount: 1,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    expect(ids(menu)).toContain("mkdir");
    expect(ids(menu)).toContain("new-file");
    // 빈 공간 우클릭에도 동일하게 노출.
    const empty = buildEmptyMenu({
      paneId: "left",
      location: localLoc,
      onRefresh: noop,
    });
    expect(ids(empty)).toContain("new-file");
  });

  it("adds Extract only for an archive file", () => {
    const zip: Entry = {
      name: "data.zip",
      kind: "file",
      size: 10,
      modified_ms: null,
      permissions: null,
      hidden: false,
    };
    const menu = buildEntryMenu({
      paneId: "left",
      entry: zip,
      location: localLoc,
      selectedCount: 1,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    expect(ids(menu)).toContain("extract");
  });

  it("shows 'Show in file manager' only for local entries", () => {
    const localMenu = buildEntryMenu({
      paneId: "left",
      entry: file,
      location: localLoc,
      selectedCount: 1,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    expect(ids(localMenu)).toContain("reveal");

    const sshLoc: Location = {
      source: {
        kind: "ssh",
        connection_id: "c1",
        host_ip: "10.0.0.1",
        user: "u",
      },
      path: "/var",
    };
    const sshMenu = buildEntryMenu({
      paneId: "left",
      entry: file,
      location: sshLoc,
      selectedCount: 1,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    expect(ids(sshMenu)).not.toContain("reveal");
  });

  it("offers batch rename instead of a dead Rename and hides Open for multi-selection", () => {
    const menu = buildEntryMenu({
      paneId: "left",
      entry: dir,
      location: localLoc,
      selectedCount: 3,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    expect(ids(menu)).not.toContain("open");
    expect(ids(menu)).not.toContain("rename");
    expect(ids(menu)).toContain("batch-rename");
  });

  it("puts open, clipboard, then rename/delete first (DESIGN.md order)", () => {
    const menu = buildEntryMenu({
      paneId: "left",
      entry: file,
      location: localLoc,
      selectedCount: 1,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    const order = ids(menu);
    const at = (id: string) => order.indexOf(id);
    expect(at("open")).toBe(0);
    expect(at("quick-look")).toBeGreaterThan(at("open"));
    expect(at("clip-copy")).toBeLessThan(at("rename"));
    expect(at("rename")).toBeLessThan(at("copy"));
    expect(at("delete")).toBe(at("rename") + 1);
  });

  it("pastes into the right-clicked folder, or the current folder for files", () => {
    const pasteOf = (entry: Entry) =>
      buildEntryMenu({
        paneId: "left",
        entry,
        location: localLoc,
        selectedCount: 1,
        onActivate: noop,
        onOpenInOtherPane: noop,
      }).find((e): e is MenuItem => !isSeparator(e) && e.id === "clip-paste");
    // 폴더: "이 폴더에 붙여넣기" — Ctrl+V(현재 폴더)와 대상이 달라 키 힌트 없음.
    expect(pasteOf(dir)?.commandId).toBeUndefined();
    // 파일: 현재 폴더에 붙여넣기 = Ctrl+V 와 같은 동작.
    expect(pasteOf(file)?.commandId).toBe("file.clipPaste");
  });

  it("shows the current shortcut for open-other / copy path / copy name", () => {
    const menu = buildEntryMenu({
      paneId: "left",
      entry: dir,
      location: localLoc,
      selectedCount: 1,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    const cmd = (id: string) =>
      menu.find((e): e is MenuItem => !isSeparator(e) && e.id === id)
        ?.commandId;
    expect(cmd("open-other")).toBe("pane.openInOther");
    expect(cmd("copy-path")).toBe("file.copyPath");
    expect(cmd("copy-name")).toBe("file.copyName");
  });

  it("adds 'Add to host favorites' only for an active SSH location", () => {
    const localMenu = buildEntryMenu({
      paneId: "left",
      entry: dir,
      location: localLoc,
      selectedCount: 1,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    expect(ids(localMenu)).not.toContain("host-fav");

    useConnections.setState({
      active: {
        c1: {
          id: "c1",
          alias: "srv",
          host_ip: "10.0.0.1",
          user: "u",
          state: { kind: "connected" },
        },
      },
    });
    const sshLoc: Location = {
      source: {
        kind: "ssh",
        connection_id: "c1",
        host_ip: "10.0.0.1",
        user: "u",
      },
      path: "/var",
    };
    const sshMenu = buildEntryMenu({
      paneId: "left",
      entry: dir,
      location: sshLoc,
      selectedCount: 1,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    expect(ids(sshMenu)).toContain("host-fav");
  });
});
