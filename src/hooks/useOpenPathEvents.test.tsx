import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Location } from "@/types/bindings";

const m = vi.hoisted(() => ({
  listener: null as null | ((e: { payload: { path: string } }) => void),
}));
vi.mock("@/types/bindings", () => ({
  events: {
    openPathEvent: {
      listen: async (cb: (e: { payload: { path: string } }) => void) => {
        m.listener = cb;
        return () => {};
      },
    },
  },
}));

import { activeTab, usePanes } from "@/stores/panes";
import { openLocalPathInNewTab, useOpenPathEvents } from "./useOpenPathEvents";

const remote: Location = {
  source: {
    kind: "ssh",
    connection_id: "prod:u1",
    host_ip: "10.0.0.7",
    user: "deploy",
  },
  path: "/srv/app",
};

function startOnRemote() {
  const s = usePanes.getState();
  const base = s.panes.left.tabs[0]!;
  usePanes.setState({
    panes: {
      ...s.panes,
      left: {
        activeTabIndex: 0,
        tabs: [
          { ...base, location: remote, history: { stack: [remote], index: 0 } },
        ],
      },
    },
  });
}

describe("openLocalPathInNewTab (G-06)", () => {
  beforeEach(startOnRemote);

  it("opens a new local tab and navigates it with a local Location", async () => {
    const navigateTo = vi.fn(async () => true);
    await openLocalPathInNewTab("left", "/home/b", navigateTo);
    const p = usePanes.getState().panes.left;
    expect(p.tabs).toHaveLength(2);
    expect(p.tabs[0]!.location).toEqual(remote); // 원격 탭은 그대로
    expect(activeTab(usePanes.getState(), "left").location.source).toEqual({
      kind: "local",
    });
    expect(navigateTo).toHaveBeenCalledWith("left", {
      source: { kind: "local" },
      path: "/home/b",
    });
  });

  it("warm start event uses the same local new-tab path", async () => {
    const navigateTo = vi.fn(async () => true);
    usePanes.getState().setActivePane("left");
    renderHook(() => useOpenPathEvents(navigateTo));
    await vi.waitFor(() => expect(m.listener).not.toBeNull());
    m.listener!({ payload: { path: "C:\\Users\\me" } });
    expect(navigateTo).toHaveBeenCalledWith("left", {
      source: { kind: "local" },
      path: "C:\\Users\\me",
    });
    expect(activeTab(usePanes.getState(), "left").location.source.kind).toBe(
      "local",
    );
  });
});
