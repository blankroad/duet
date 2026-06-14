import { describe, it, expect, beforeEach } from "vitest";
import { buildEntryMenu } from "./entryMenu";
import { isSeparator, type MenuEntry, type MenuItem } from "@/stores/contextMenu";
import { useConnections } from "@/stores/connections";
import type { Entry, Location } from "@/types/bindings";

const localLoc: Location = { source: { kind: "local" }, path: "/home/u" };
const dir: Entry = { name: "proj", kind: "dir", size: null, modified_ms: null, permissions: null, hidden: false };
const file: Entry = { name: "a.txt", kind: "file", size: 10, modified_ms: null, permissions: null, hidden: false };

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

  it("omits Open entries for a file", () => {
    const menu = buildEntryMenu({
      paneId: "left",
      entry: file,
      location: localLoc,
      selectedCount: 1,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    expect(ids(menu)).not.toContain("open");
    expect(ids(menu)).not.toContain("open-other");
  });

  it("disables Rename and hides Open for multi-selection", () => {
    const menu = buildEntryMenu({
      paneId: "left",
      entry: dir,
      location: localLoc,
      selectedCount: 3,
      onActivate: noop,
      onOpenInOtherPane: noop,
    });
    expect(ids(menu)).not.toContain("open");
    const rename = menu.find((e): e is MenuItem => !isSeparator(e) && e.id === "rename");
    expect(rename?.disabled).toBe(true);
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
        c1: { id: "c1", alias: "srv", host_ip: "10.0.0.1", user: "u", state: { kind: "connected" } },
      },
    });
    const sshLoc: Location = {
      source: { kind: "ssh", connection_id: "c1", host_ip: "10.0.0.1", user: "u" },
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
