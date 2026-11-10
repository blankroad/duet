import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type Location, type ThreeWayPlan } from "@/types/bindings";
import { triggerThreeWay } from "@/lib/fileActions";
import { promptText } from "@/stores/promptDialog";
import { usePanes } from "@/stores/panes";
import i18n from "@/i18n";

vi.mock("@/types/bindings", () => ({
  commands: { fsCompareThreeWay: vi.fn() },
}));
vi.mock("@/stores/promptDialog", () => ({ promptText: vi.fn() }));

const local = (path: string): Location => ({ source: { kind: "local" }, path });
const L = local("/fixture/work/left");
const R = local("/fixture/work/right");

function setPanes(left: Location, right: Location) {
  usePanes.setState((s) => ({
    activePane: "left",
    panes: {
      left: {
        ...s.panes.left,
        activeTabIndex: 0,
        tabs: [{ ...s.panes.left.tabs[0]!, location: left }],
      },
      right: {
        ...s.panes.right,
        activeTabIndex: 0,
        tabs: [{ ...s.panes.right.tabs[0]!, location: right }],
      },
    },
  }));
}

async function runWithBase(base: string | null) {
  vi.mocked(promptText).mockResolvedValue(base);
  const open = vi.fn();
  const toast = vi.fn();
  await triggerThreeWay(open, toast);
  return { open, toast };
}

describe("SC-16 3-way base prompt", () => {
  beforeEach(() => {
    vi.mocked(promptText).mockReset();
    vi.mocked(commands.fsCompareThreeWay)
      .mockReset()
      .mockResolvedValue({ status: "ok", data: {} as ThreeWayPlan });
    setPanes(L, R);
  });

  it("starts with an empty base input (not the left path)", async () => {
    await runWithBase(null);
    expect(vi.mocked(promptText).mock.calls[0]?.[0].initial).toBe("");
    expect(commands.fsCompareThreeWay).not.toHaveBeenCalled();
  });

  it.each([
    ["equal to left", "/fixture/work/left"],
    ["equal to left with trailing slash", "/fixture/work/left/"],
    ["inside right", "/fixture/work/right/.snapshot"],
    ["parent of both", "/fixture/work"],
  ])("rejects a base %s before scanning", async (_label, base) => {
    const { toast, open } = await runWithBase(base);
    expect(commands.fsCompareThreeWay).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(i18n.t("toast.threeWayBaseOverlaps"));
  });

  it("scans with a separate base folder", async () => {
    const { toast, open } = await runWithBase("/fixture/snapshots/base");
    expect(toast).not.toHaveBeenCalled();
    expect(commands.fsCompareThreeWay).toHaveBeenCalledWith(
      local("/fixture/snapshots/base"),
      L,
      R,
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "three-way" }),
    );
  });

  it("does not compare a remote right side's path against a local base", async () => {
    const remoteR: Location = {
      source: {
        kind: "ssh",
        connection_id: "c1",
        host_ip: "10.0.0.2",
        user: "u",
      },
      path: "/fixture/snapshots/base",
    };
    setPanes(L, remoteR);
    const { toast } = await runWithBase("/fixture/snapshots/base");
    expect(toast).not.toHaveBeenCalled();
    expect(commands.fsCompareThreeWay).toHaveBeenCalled();
  });
});
