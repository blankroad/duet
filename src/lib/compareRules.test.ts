import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type ComparePlan, type Location } from "@/types/bindings";
import { triggerCompare } from "@/lib/fileActions";
import {
  hasRemoteSide,
  initialTolerance,
  REMOTE_MIN_TOLERANCE_MS,
} from "@/lib/compareRules";
import { usePanes } from "@/stores/panes";
import "@/i18n";

vi.mock("@/types/bindings", () => ({
  commands: {
    settingsGet: vi.fn(),
    fsCompareDirs: vi.fn(),
  },
}));

const local = (path: string): Location => ({ source: { kind: "local" }, path });
const remote = (path: string): Location => ({
  source: { kind: "ssh", connection_id: "c1", host_ip: "10.0.0.2", user: "u" },
  path,
});

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

function settings(tol: number) {
  vi.mocked(commands.settingsGet).mockResolvedValue({
    status: "ok",
    data: { compare_ignore_globs: [], compare_mtime_tolerance_ms: tol },
  } as unknown as Awaited<ReturnType<typeof commands.settingsGet>>);
}

async function sentTolerance(left: Location, right: Location) {
  setPanes(left, right);
  await triggerCompare(vi.fn(), vi.fn());
  return vi.mocked(commands.fsCompareDirs).mock.calls.at(-1)?.[2]
    .mtime_tolerance_ms;
}

describe("compareRules helpers", () => {
  it("detects a remote side on either pane", () => {
    expect(hasRemoteSide(local("/a"), local("/b"))).toBe(false);
    expect(hasRemoteSide(local("/a"), remote("/b"))).toBe(true);
    expect(hasRemoteSide(remote("/a"), local("/b"))).toBe(true);
  });

  it("raises tolerance to 2s only when remote, keeping larger saved values", () => {
    expect(initialTolerance(0, false)).toBe(0);
    expect(initialTolerance(0, true)).toBe(REMOTE_MIN_TOLERANCE_MS);
    expect(initialTolerance(60_000, true)).toBe(60_000);
    expect(initialTolerance(60_000, false)).toBe(60_000);
  });
});

describe("SC-11 triggerCompare initial tolerance", () => {
  beforeEach(() => {
    vi.mocked(commands.fsCompareDirs)
      .mockReset()
      .mockResolvedValue({
        status: "ok",
        data: {} as ComparePlan,
      });
  });

  it("local ↔ remote with saved 0 compares with ±2s", async () => {
    settings(0);
    expect(await sentTolerance(local("/fixture/l"), remote("/srv/r"))).toBe(
      2000,
    );
  });

  it("remote ↔ local (remote active) also uses ±2s", async () => {
    settings(0);
    expect(await sentTolerance(remote("/srv/r"), local("/fixture/l"))).toBe(
      2000,
    );
  });

  it("local ↔ local keeps the saved exact (0) tolerance", async () => {
    settings(0);
    expect(await sentTolerance(local("/fixture/l"), local("/fixture/r"))).toBe(
      0,
    );
  });

  it("settings read failure still uses ±2s for remote", async () => {
    vi.mocked(commands.settingsGet).mockResolvedValue({
      status: "error",
      error: { kind: "Io", message: "fixture" },
    } as unknown as Awaited<ReturnType<typeof commands.settingsGet>>);
    expect(await sentTolerance(local("/fixture/l"), remote("/srv/r"))).toBe(
      2000,
    );
  });
});
