// 압축 해제(여기에 / 각각 폴더로) — 메뉴 노출, 선택 분류, IPC 호출, 충돌·부분 실패,
// 암호 대기열(FIFO), 일괄 알림. 백엔드 command 는 모킹.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Entry,
  EntryRef,
  ExtractHereSummary,
  ExtractPlan,
  ExtractPlanItem,
  Location,
  SourceId,
} from "@/types/bindings";

const h = vi.hoisted(() => ({
  planBatch: vi.fn(),
  execute: vi.fn(),
  here: vi.fn(),
  hereRetry: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/types/bindings", () => ({
  commands: new Proxy(
    {
      fsExtractPlanBatch: h.planBatch,
      fsExtractExecute: h.execute,
      fsExtractHere: h.here,
      fsExtractHereRetry: h.hereRetry,
    } as Record<string, unknown>,
    {
      get: (target, key) =>
        target[String(key)] ??
        (() => Promise.resolve({ status: "ok", data: null })),
    },
  ),
}));

import i18n from "@/i18n";
import { buildEntryMenu } from "@/lib/entryMenu";
import {
  resolveExtractConflict,
  retryExtract,
  runExtractHere,
  triggerExtractHere,
  triggerExtractToFolders,
} from "@/lib/extractActions";
import {
  requestExtractPassword,
  resetExtractPendingForTest,
  takeExtract,
  type ExtractRetry,
} from "@/lib/extractPending";
import {
  noteHereSummary,
  resetExtractNoticesForTest,
  settleHereTask,
  trackHereBatch,
} from "@/lib/extractNotices";
import { activeTab, computeDisplayed, usePanes } from "@/stores/panes";
import { useToast } from "@/stores/toast";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { isSeparator, type MenuItem } from "@/stores/contextMenu";

const LOCAL: SourceId = { kind: "local" };
const SSH: SourceId = {
  kind: "ssh",
  connection_id: "c1",
  host_ip: "10.0.0.1",
  user: "u",
};
const DIR = "/work";

function entry(name: string): Entry {
  return {
    name,
    kind: name.endsWith("/") ? "dir" : "file",
    size: 1,
    modified_ms: 0,
    permissions: null,
    hidden: false,
  };
}

/** 지금 화면 순서대로 이 이름들. (정렬은 탭 설정을 따른다.) */
function listed(names: string[]): string[] {
  return computeDisplayed(activeTab(usePanes.getState(), "left"))
    .map((e) => e.name)
    .filter((n) => names.includes(n));
}

/** 왼쪽 패널에 항목을 놓고 `selected` 를 선택한다. 반환 = 위치. */
function setPane(
  names: string[],
  selected: string[],
  source: SourceId = LOCAL,
): Location {
  const location: Location = { source, path: DIR };
  const entries = names.map((n) => ({
    ...entry(n),
    name: n.replace(/\/$/, ""),
  }));
  const s = usePanes.getState();
  const base = activeTab(s, "left");
  usePanes.setState({
    activePane: "left",
    panes: {
      ...s.panes,
      left: {
        tabs: [
          {
            ...base,
            location,
            entries,
            selected: new Set(selected),
            cursorIndex: 0,
            filter: "",
            showHidden: false,
          },
        ],
        activeTabIndex: 0,
      },
    },
  });
  return location;
}

function ref(name: string, source: SourceId = LOCAL): EntryRef {
  return { location: { source, path: DIR }, name };
}

function plan(name: string, conflict = false): ExtractPlan {
  return {
    source: LOCAL,
    archive_dir: { source: LOCAL, path: DIR },
    archive_name: name,
    format: "zip",
    dest_dir: `${DIR}/${name.replace(/\..*$/, "")}`,
    conflict,
    keep_both: !conflict,
  };
}

function planned(name: string, conflict = false): ExtractPlanItem {
  return { archive: ref(name), plan: plan(name, conflict), error: null };
}

function menuFor(clicked: string, selectedCount: number, source = LOCAL) {
  const items = buildEntryMenu({
    paneId: "left",
    entry: entry(clicked),
    location: { source, path: DIR },
    selectedCount,
    onActivate: vi.fn(),
    onOpenInOtherPane: vi.fn(),
  }).filter((e): e is MenuItem => !isSeparator(e));
  const byId = (id: string) => items.find((i) => i.id === id);
  return { here: byId("extract-here"), folder: byId("extract") };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  for (const f of Object.values(h)) f.mockReset();
  h.execute.mockImplementation(() =>
    Promise.resolve({
      status: "ok",
      data: `task-${h.execute.mock.calls.length}`,
    }),
  );
  resetExtractPendingForTest();
  resetExtractNoticesForTest();
  useUIDialogs.setState({
    dialog: { kind: "none" },
    queue: [],
    fromQueue: false,
  });
});
afterEach(() => vi.restoreAllMocks());

// ---------- 메뉴 ----------

describe("extract menu items", () => {
  it("single archive: Extract here + Extract to folder", () => {
    setPane(["a.zip"], ["a.zip"]);
    const m = menuFor("a.zip", 1);
    expect(m.here?.label).toBe("Extract here");
    expect(m.folder?.label).toBe("Extract to folder");
  });

  it("several archives: counted labels", () => {
    const all = ["a.zip", "b.7z", "c.tar.gz"];
    setPane(all, all);
    const m = menuFor("b.7z", 3);
    expect(m.here?.label).toBe("Extract 3 archives here");
    expect(m.folder?.label).toBe("Extract each to its own folder (3)");
    expect(m.here?.disabled).not.toBe(true);
  });

  it("mixed selection counts only archives, even when a plain file was right-clicked", () => {
    const all = ["a.zip", "b.7z", "c.tar.gz", "readme.txt"];
    setPane(all, all);
    const m = menuFor("readme.txt", 4);
    expect(m.folder?.label).toBe("Extract each to its own folder (3)");
    expect(m.here?.label).toBe("Extract 3 archives here");
  });

  it("no archives: both items hidden", () => {
    setPane(["readme.txt", "docs/"], ["readme.txt", "docs"]);
    expect(menuFor("readme.txt", 2)).toEqual({
      here: undefined,
      folder: undefined,
    });
    setPane(["readme.txt"], ["readme.txt"]);
    expect(menuFor("readme.txt", 1)).toEqual({
      here: undefined,
      folder: undefined,
    });
  });

  it("remote: no Extract here; 7z does not count", () => {
    setPane(["a.zip", "b.7z"], ["a.zip", "b.7z"], SSH);
    const m = menuFor("b.7z", 2, SSH);
    expect(m.here).toBeUndefined();
    expect(m.folder?.label).toBe("Extract to folder");
    setPane(["b.7z"], ["b.7z"], SSH);
    expect(menuFor("b.7z", 1, SSH).folder).toBeUndefined();
  });
});

// ---------- 각각 폴더로 ----------

describe("extract each to its own folder", () => {
  it("skips non-archives with one toast and sends only archives, in listed order", async () => {
    setPane(
      ["a.zip", "b.7z", "c.tar.gz", "readme.txt"],
      ["c.tar.gz", "readme.txt", "a.zip", "b.7z"],
    );
    h.planBatch.mockResolvedValue({
      status: "ok",
      data: [planned("a.zip"), planned("b.7z"), planned("c.tar.gz")],
    });
    const toast = vi.fn();
    await triggerExtractToFolders(vi.fn(), toast);
    expect(h.planBatch).toHaveBeenCalledTimes(1);
    const [archives, keepBoth] = h.planBatch.mock.calls[0]!;
    // 선택한 순서(c, readme, a, b)가 아니라 화면에 보이는 순서.
    expect((archives as EntryRef[]).map((a) => a.name)).toEqual(
      listed(["a.zip", "b.7z", "c.tar.gz"]),
    );
    expect(keepBoth).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]![0]).toBe(
      i18n.t("toast.extractSkippedNonArchive", { count: 1 }),
    );
    expect(toast.mock.calls[0]![2].detail).toContain("readme.txt");
    expect(h.execute).toHaveBeenCalledTimes(3);
  });

  it("remote 7z is skipped with the remote reason", async () => {
    setPane(["a.zip", "b.7z"], ["a.zip", "b.7z"], SSH);
    h.planBatch.mockResolvedValue({ status: "ok", data: [planned("a.zip")] });
    const toast = vi.fn();
    await triggerExtractToFolders(vi.fn(), toast);
    expect(toast.mock.calls[0]![0]).toBe(
      i18n.t("toast.extractSkipped", { count: 1 }),
    );
    expect(toast.mock.calls[0]![2].detail).toContain(
      i18n.t("toast.extractSkipRemote"),
    );
  });

  it("an existing destination opens the conflict dialog and runs nothing yet (Cancel = nothing)", async () => {
    setPane(["a.zip", "b.zip"], ["a.zip", "b.zip"]);
    const data = [planned("a.zip", true), planned("b.zip")];
    h.planBatch.mockResolvedValue({ status: "ok", data });
    const open = vi.fn();
    await triggerExtractToFolders(open, vi.fn());
    expect(open).toHaveBeenCalledWith({
      kind: "extract-conflict",
      items: data,
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("Keep both re-plans with keep_both=true and runs the new plans", async () => {
    const first = [planned("a.zip", true)];
    h.planBatch.mockResolvedValue({
      status: "ok",
      data: [
        {
          ...planned("a.zip"),
          plan: { ...plan("a.zip"), dest_dir: `${DIR}/a (2)` },
        },
      ],
    });
    await resolveExtractConflict("keepBoth", first, vi.fn());
    expect(h.planBatch).toHaveBeenCalledWith([ref("a.zip")], true);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect((h.execute.mock.calls[0]![0] as ExtractPlan).dest_dir).toBe(
      `${DIR}/a (2)`,
    );
  });

  it("Replace runs the plans as given", async () => {
    await resolveExtractConflict("replace", [planned("a.zip", true)], vi.fn());
    expect(h.planBatch).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledWith(plan("a.zip", true), null);
  });

  it("one plan error: the others still run, one summary toast names the failure", async () => {
    setPane(["a.zip", "bad.zip", "c.zip"], ["a.zip", "bad.zip", "c.zip"]);
    h.planBatch.mockResolvedValue({
      status: "ok",
      data: [
        planned("a.zip"),
        {
          archive: ref("bad.zip"),
          plan: null,
          error: { kind: "NotFound", message: "gone" },
        },
        planned("c.zip"),
      ],
    });
    const toast = vi.fn();
    await triggerExtractToFolders(vi.fn(), toast);
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledTimes(1);
    const [msg, kind, opts] = toast.mock.calls[0]!;
    expect(kind).toBe("error");
    expect(msg).toBe(
      i18n.t("toast.extractBatchFailed", { count: 1, names: "bad.zip" }),
    );
    expect(opts.detail).toContain("bad.zip");
  });

  it("each started task is remembered for a password retry with its plan", async () => {
    setPane(["a.zip"], ["a.zip"]);
    h.planBatch.mockResolvedValue({ status: "ok", data: [planned("a.zip")] });
    await triggerExtractToFolders(vi.fn(), vi.fn());
    expect(takeExtract("task-1")).toEqual({
      retry: { kind: "folder", plan: plan("a.zip") },
      attempted: false,
    });
  });
});

// ---------- 여기에 ----------

describe("extract here", () => {
  it("opens the policy dialog with only the archives; no IPC yet", () => {
    setPane(["a.zip", "x.txt", "c.tar.gz"], ["a.zip", "x.txt", "c.tar.gz"]);
    const open = vi.fn();
    triggerExtractHere(open, vi.fn());
    expect(open).toHaveBeenCalledWith({
      kind: "extract-here",
      archives: listed(["a.zip", "c.tar.gz"]).map((n) => ref(n)),
    });
    expect(h.here).not.toHaveBeenCalled();
  });

  it("refuses on a server without opening the dialog", () => {
    setPane(["a.zip"], ["a.zip"], SSH);
    const open = vi.fn();
    const toast = vi.fn();
    triggerExtractHere(open, toast);
    expect(open).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      i18n.t("toast.extractHereLocalOnly"),
      "info",
    );
  });

  it("passes the chosen policy, remembers retries with the batch, summarises rejects", async () => {
    const archives = [ref("a.zip"), ref("bad.zip")];
    h.here.mockResolvedValue({
      status: "ok",
      data: [
        { archive: archives[0], task_id: "t-a", error: null },
        {
          archive: archives[1],
          task_id: null,
          error: { kind: "NotSupported", message: "nope" },
        },
      ],
    });
    const toast = vi.fn();
    await runExtractHere(archives, "replace", toast);
    expect(h.here).toHaveBeenCalledWith(archives, "replace");
    expect(takeExtract("t-a")).toEqual({
      retry: {
        kind: "here",
        archive: archives[0],
        policy: "replace",
        batch: archives,
      },
      attempted: false,
    });
    expect(toast.mock.calls[0]![0]).toBe(
      i18n.t("toast.extractBatchFailed", { count: 1, names: "bad.zip" }),
    );
  });

  it("password retry calls the matching command with the same policy and batch", async () => {
    h.hereRetry.mockResolvedValue({ status: "ok", data: "t-r" });
    const retry: ExtractRetry = {
      kind: "here",
      archive: ref("a.zip"),
      policy: "skip",
      batch: [ref("a.zip"), ref("b.zip")],
    };
    expect(await retryExtract(retry, "pw")).toEqual({
      ok: true,
      taskId: "t-r",
    });
    expect(h.hereRetry).toHaveBeenCalledWith(
      ref("a.zip"),
      "skip",
      "pw",
      retry.batch,
    );
    expect(takeExtract("t-r")?.attempted).toBe(true);

    h.execute.mockResolvedValue({ status: "ok", data: "t-f" });
    await retryExtract({ kind: "folder", plan: plan("a.zip") }, "pw2");
    expect(h.execute).toHaveBeenCalledWith(plan("a.zip"), "pw2");
  });
});

// ---------- 암호 대기열 ----------

describe("password prompt queue", () => {
  const retryFor = (name: string): ExtractRetry => ({
    kind: "folder",
    plan: plan(name),
  });
  const shown = () => {
    const d = useUIDialogs.getState().dialog;
    return d.kind === "extract-password" && d.retry.kind === "folder"
      ? d.retry.plan.archive_name
      : null;
  };

  it("one prompt at a time, in arrival order; closing (cancel) moves to the next", () => {
    for (const n of ["a.zip", "b.zip", "c.zip"])
      expect(requestExtractPassword({ retry: retryFor(n), wrong: false })).toBe(
        true,
      );
    expect(shown()).toBe("a.zip");
    useUIDialogs.getState().close(); // 취소 — a 만 건너뜀
    expect(shown()).toBe("b.zip");
    useUIDialogs.getState().close();
    expect(shown()).toBe("c.zip");
    useUIDialogs.getState().close();
    expect(useUIDialogs.getState().dialog.kind).toBe("none");
  });

  it("waits behind an unrelated dialog and says so", () => {
    useUIDialogs.getState().open({ kind: "settings" });
    expect(
      requestExtractPassword({ retry: retryFor("a.zip"), wrong: true }),
    ).toBe(false);
    expect(useUIDialogs.getState().dialog.kind).toBe("settings");
    useUIDialogs.getState().close();
    expect(shown()).toBe("a.zip");
  });
});

// ---------- 일괄 알림 ----------

describe("extract-here notices", () => {
  const summary = (name: string): ExtractHereSummary => ({
    archive_name: name,
    placed: 1,
    renamed: [{ dir: DIR, from: "readme.txt", to: "readme (2).txt" }],
    replaced: [],
    skipped: [],
    leftover_staging: null,
  });
  const dir: Location = { source: LOCAL, path: DIR };

  it("collects a batch into one toast when its last task settles", () => {
    const show = vi.spyOn(useToast.getState(), "show");
    trackHereBatch([
      { taskId: "t1", archive: ref("a.zip") },
      { taskId: "t2", archive: ref("b.zip") },
    ]);
    noteHereSummary(dir, summary("a.zip"));
    settleHereTask("t1");
    noteHereSummary(dir, summary("b.zip"));
    expect(show).not.toHaveBeenCalled();
    settleHereTask("t2");
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]![2]?.detail).toContain(
      "readme.txt → readme (2).txt",
    );
  });

  it("a result outside any batch (e.g. a password retry) shows right away", () => {
    const show = vi.spyOn(useToast.getState(), "show");
    noteHereSummary(dir, summary("solo.zip"));
    expect(show).toHaveBeenCalledTimes(1);
  });
});
