// fileops 점검(2026-11-08, opus) 재현 — 잘라내기(Ctrl+X) 후 붙여넣기(Ctrl+V).
//
// 예전 `clipPaste` 는 `planTransferTo` 가 끝나자마자(= 확인 다이얼로그를 **열기만** 한 시점)
// move 클립보드를 비웠다. 그래서 확인창에서 [취소] 하거나 plan 단계가 실패해도 잘라낸
// 항목이 클립보드에서 사라졌다(fileops-24). 이제는 이동 작업이 **접수된** 항목만 뺀다.
//
// mocked FE test — Tauri 명령은 가짜. 실제 전송은 하지 않는다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryRef, Location, MovePlan, SourceId } from "@/types/bindings";

const h = vi.hoisted(() => ({
  movePlan: null as unknown,
  movePlans: 0,
  moveExecuted: 0,
  moveExec: null as unknown,
  /** 설정하면 fsMoveExecute 응답이 이 promise 가 풀릴 때까지 늦게 온다. */
  gate: null as Promise<void> | null,
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
vi.mock("@/types/bindings", () => ({
  commands: {
    // 실제 IPC 처럼 호출마다 새 plan 객체를 돌려준다.
    fsMovePlan: () => {
      h.movePlans += 1;
      return Promise.resolve(structuredClone(h.movePlan));
    },
    fsCopyPlan: () => Promise.resolve(structuredClone(h.movePlan)),
    fsMoveExecute: async () => {
      h.moveExecuted += 1;
      if (h.gate) await h.gate;
      return h.moveExec ?? { status: "ok", data: "task-1" };
    },
    setOsFileClipboard: () => Promise.resolve({ status: "ok", data: null }),
  },
}));

import { clipPaste, executeTransfer } from "@/lib/fileActions";
import { useClipboard } from "@/stores/clipboard";
import { useAppSettings } from "@/stores/settings";
import { useUIDialogs, type DialogState } from "@/stores/ui-dialogs";

const ssh: SourceId = {
  kind: "ssh",
  connection_id: "c1",
  host_ip: "10.0.0.5",
  user: "u",
};
const src: Location = { source: { kind: "local" }, path: "C:\\work" };
const dst: Location = { source: { kind: "local" }, path: "D:\\backup" };
const cut: EntryRef[] = [{ location: src, name: "report.docx" }];

const plan = (conflicts: number, items: EntryRef[] = cut, to = dst) => ({
  status: "ok",
  data: {
    src_source: items[0]!.location.source,
    dst: to,
    items,
    conflicts: Array.from({ length: conflicts }, (_, i) => ({
      name: items[i]!.name,
    })),
    is_same_fs: true,
    total_size_bytes: 0,
    strategy: "local_to_local",
  },
});

/** Ctrl+V → 확인창이 열렸으면 그 상태를 돌려준다. */
async function pasteToDialog(
  to: Location = dst,
): Promise<Extract<DialogState, { kind: "move-confirm" }>> {
  const open = vi.fn();
  await clipPaste(open, vi.fn(), to);
  const d = open.mock.calls[0]?.[0] as DialogState | undefined;
  if (d?.kind !== "move-confirm") throw new Error("no move-confirm dialog");
  return d;
}

/** 확인창의 [이동] — App.onMoveConfirm 과 같은 호출. */
const confirm = (
  d: Extract<DialogState, { kind: "move-confirm" }>,
  policy: "skip" | "replace" | "keepboth" = "replace",
) => executeTransfer("move", d.plan, policy, vi.fn(), vi.fn(), vi.fn(), d.clip);

/** 다음 fsMoveExecute 응답을 붙잡는다 — 반환 함수로 풀어 준다. */
function holdExecute(): () => void {
  let release = () => {};
  h.gate = new Promise<void>((r) => {
    release = r;
  });
  return () => {
    h.gate = null;
    release();
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.movePlans = 0;
  h.moveExecuted = 0;
  h.moveExec = null;
  h.gate = null;
  useUIDialogs.getState().close();
  useClipboard.getState().set(cut, "move");
});

describe("fileops-opus: 잘라내기 붙여넣기", () => {
  it("fileops-24: 충돌로 확인창이 떴을 때(아직 이동 안 함) 잘라낸 항목이 클립보드에 남아 있다", async () => {
    h.movePlan = plan(1);
    const open = vi.fn();
    await clipPaste(open, vi.fn(), dst);
    // 확인창만 열렸다 — 아직 아무것도 이동하지 않았다.
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "move-confirm" }),
    );
    expect(h.moveExecuted).toBe(0);
    // 사용자가 [취소]/Esc 하면(확인창만 닫힘) 다시 Ctrl+V 할 수 있어야 한다.
    expect(useClipboard.getState().entry?.mode).toBe("move");
  });

  it("fileops-24: plan 단계가 실패해도(대상 폴더 권한 등) 잘라낸 항목이 사라지지 않는다", async () => {
    h.movePlan = {
      status: "error",
      error: { kind: "PermissionDenied", data: "D:\\backup" },
    };
    const toast = vi.fn();
    await clipPaste(vi.fn(), toast, dst);
    expect(toast).toHaveBeenCalled();
    expect(useClipboard.getState().entry?.mode).toBe("move");
  });

  it("(기준) 충돌이 없으면 기본 설정(conflicts_only)에서 확인 없이 바로 이동한다", async () => {
    expect(useAppSettings.getState().confirmTransfer).toBe("conflicts_only");
    h.movePlan = plan(0);
    const open = vi.fn();
    await clipPaste(open, vi.fn(), dst);
    expect(h.moveExecuted).toBe(1);
    expect(useClipboard.getState().entry).toBeNull();
  });

  it("확인창에서 [이동] 이 접수되면 그때 클립보드를 비운다", async () => {
    h.movePlan = plan(1);
    const d = await pasteToDialog();
    expect(await confirm(d)).toBe(true);
    expect(h.moveExecuted).toBe(1);
    expect(useClipboard.getState().entry).toBeNull();
  });

  it("바로 이동이 접수 단계에서 거부되면 클립보드를 남긴다", async () => {
    h.movePlan = plan(0);
    h.moveExec = {
      status: "error",
      error: { kind: "Io", message: "queue closed" },
    };
    await clipPaste(vi.fn(), vi.fn(), dst);
    expect(h.moveExecuted).toBe(1);
    expect(useClipboard.getState().entry?.targets).toEqual(cut);
  });

  it("확인창 [이동] 이 접수 단계에서 거부되면 클립보드를 남긴다", async () => {
    h.movePlan = plan(1);
    const d = await pasteToDialog();
    h.moveExec = {
      status: "error",
      error: { kind: "Io", message: "queue closed" },
    };
    expect(await confirm(d)).toBe(false);
    expect(useClipboard.getState().entry?.targets).toEqual(cut);
  });

  it("오래된 붙여넣기가 끝나도 그 사이 새로 담은 Ctrl+C/Ctrl+X 는 지우지 않는다", async () => {
    h.movePlan = plan(1);
    const d = await pasteToDialog();
    // 확인창이 떠 있는 사이 같은 항목을 다시 잘라냈다 — 새 내용이다.
    useClipboard.getState().set(cut, "move");
    const newer = useClipboard.getState().entry;
    await confirm(d);
    expect(useClipboard.getState().entry).toBe(newer);
    // 복사로 바꿔 담은 경우도 그대로.
    h.movePlan = plan(1);
    const d2 = await pasteToDialog();
    useClipboard.getState().set(cut, "copy");
    await confirm(d2);
    expect(useClipboard.getState().entry?.mode).toBe("copy");
  });

  it("일부 항목만 접수되면(파일별 그룹) 나머지는 클립보드에 남는다", async () => {
    const two: EntryRef[] = [...cut, { location: src, name: "notes.txt" }];
    useClipboard.getState().set(two, "move");
    h.movePlan = plan(2, two);
    const d = await pasteToDialog();
    // 파일별 실행이 한 그룹(report.docx)만 접수한 경우 — App.onTransferPerFile 과 같은 소비.
    const group = { ...d.plan, items: [two[0]!] } as MovePlan;
    expect(
      await executeTransfer(
        "move",
        group,
        "replace",
        vi.fn(),
        vi.fn(),
        vi.fn(),
        d.clip,
      ),
    ).toBe(true);
    expect(useClipboard.getState().entry?.targets).toEqual([two[1]]);
  });

  it("[이동] 을 두 번 눌러도 이동 작업은 한 번만 들어간다", async () => {
    h.movePlan = plan(1);
    const d = await pasteToDialog();
    const [a, b] = await Promise.all([confirm(d), confirm(d)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(h.moveExecuted).toBe(1);
  });

  it("복사 클립보드는 붙여넣어도 남는다(여러 번 붙여넣기)", async () => {
    useClipboard.getState().set(cut, "copy");
    h.movePlan = plan(1);
    const open = vi.fn();
    await clipPaste(open, vi.fn(), dst);
    expect(open).toHaveBeenCalledWith(
      expect.not.objectContaining({ clip: expect.anything() }),
    );
    expect(open.mock.calls[0]?.[0]?.kind).toBe("copy-confirm");
    expect(useClipboard.getState().entry?.mode).toBe("copy");
  });

  it("A1-R1-01: 전체 건너뛰기면 충돌 항목은 남고 나머지만 비운다", async () => {
    const two: EntryRef[] = [...cut, { location: src, name: "notes.txt" }];
    useClipboard.getState().set(two, "move");
    h.movePlan = plan(1, two); // report.docx 만 충돌
    const d = await pasteToDialog();
    expect(await confirm(d, "skip")).toBe(true);
    // 건너뛴 report.docx 는 원래 폴더에 남아 있다 — 다시 붙여넣을 수 있어야 한다.
    expect(useClipboard.getState().entry?.targets).toEqual([two[0]]);
  });

  it("A1-R1-02: 접수 응답 전 두 번째 Ctrl+V 는 같은 잘라내기를 다시 보내지 않는다", async () => {
    h.movePlan = plan(0);
    const done = holdExecute();
    const first = clipPaste(vi.fn(), vi.fn(), dst);
    await flush(); // 첫 번째가 fsMoveExecute 응답을 기다리는 중
    const second = clipPaste(vi.fn(), vi.fn(), dst);
    await flush();
    done();
    await Promise.all([first, second]);
    expect(h.movePlans).toBe(1);
    expect(h.moveExecuted).toBe(1);
    expect(useClipboard.getState().entry).toBeNull();
  });

  it("A1-R1-02: plan 응답 전 두 번째 Ctrl+V 도 무시된다(서로 다른 plan 객체)", async () => {
    h.movePlan = plan(0);
    const a = clipPaste(vi.fn(), vi.fn(), dst);
    const b = clipPaste(vi.fn(), vi.fn(), dst);
    await Promise.all([a, b]);
    expect(h.movePlans).toBe(1);
    expect(h.moveExecuted).toBe(1);
  });

  it("A1-R1-02: 확인 창이 떠 있는 동안 같은 잘라내기는 다시 plan 하지 않고, 취소(Esc)하면 다시 된다", async () => {
    h.movePlan = plan(1);
    const open = useUIDialogs.getState().open;
    await clipPaste(open, vi.fn(), dst);
    expect(useUIDialogs.getState().dialog.kind).toBe("move-confirm");
    await clipPaste(open, vi.fn(), dst);
    expect(h.movePlans).toBe(1);
    // [취소]/Esc — App 은 closeDialog 만 부른다.
    useUIDialogs.getState().close();
    await clipPaste(open, vi.fn(), dst);
    expect(h.movePlans).toBe(2);
    expect(useClipboard.getState().entry?.targets).toEqual(cut);
  });

  it("A1-R1-02: 확인 창 [이동] 응답 대기 중에는 Ctrl+V 가 막히고, 접수 거부 후에는 다시 된다", async () => {
    h.movePlan = plan(1);
    const open = useUIDialogs.getState().open;
    await clipPaste(open, vi.fn(), dst);
    const d = useUIDialogs.getState().dialog;
    if (d.kind !== "move-confirm") throw new Error("no dialog");
    h.moveExec = {
      status: "error",
      error: { kind: "Io", message: "queue closed" },
    };
    const done = holdExecute();
    // App.onMoveConfirm — 닫기는 executeTransfer 안에서.
    const submit = executeTransfer(
      "move",
      d.plan,
      "replace",
      open,
      useUIDialogs.getState().close,
      vi.fn(),
      d.clip,
    );
    await flush();
    expect(useUIDialogs.getState().dialog.kind).toBe("none");
    await clipPaste(open, vi.fn(), dst); // 응답 대기 중 — 무시
    expect(h.movePlans).toBe(1);
    done();
    expect(await submit).toBe(false);
    await clipPaste(open, vi.fn(), dst); // 거부됐으니 다시 시도 가능
    expect(h.movePlans).toBe(2);
    expect(useClipboard.getState().entry?.targets).toEqual(cut);
  });

  it("A1-R1-02: plan 실패 후 다시 Ctrl+V 하면 다시 시도한다", async () => {
    h.movePlan = {
      status: "error",
      error: { kind: "PermissionDenied", data: "D:\\backup" },
    };
    await clipPaste(vi.fn(), vi.fn(), dst);
    h.movePlan = plan(0);
    await clipPaste(vi.fn(), vi.fn(), dst);
    expect(h.movePlans).toBe(2);
    expect(h.moveExecuted).toBe(1);
  });

  it("A1-R1-02: 복사 클립보드는 예약하지 않는다(동시 붙여넣기 둘 다 진행)", async () => {
    useClipboard.getState().set(cut, "copy");
    h.movePlan = plan(1);
    const open = vi.fn();
    await Promise.all([
      clipPaste(open, vi.fn(), dst),
      clipPaste(open, vi.fn(), dst),
    ]);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["local → ssh", src, { source: ssh, path: "/srv" }],
    ["ssh → local", { source: ssh, path: "/home/u" }, dst],
    [
      "ssh → ssh",
      { source: ssh, path: "/home/u" },
      { source: ssh, path: "/srv" },
    ],
  ] as Array<[string, Location, Location]>)(
    "%s: 확인 취소는 남기고 접수되면 비운다",
    async (_, from, to) => {
      const items: EntryRef[] = [{ location: from, name: "a.bin" }];
      useClipboard.getState().set(items, "move");
      h.movePlan = plan(1, items, to);
      const d = await pasteToDialog(to);
      expect(useClipboard.getState().entry?.targets).toEqual(items);
      await confirm(d);
      expect(useClipboard.getState().entry).toBeNull();
    },
  );
});
