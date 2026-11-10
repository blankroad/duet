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
  moveExecuted: 0,
  moveExec: null as unknown,
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
vi.mock("@/types/bindings", () => ({
  commands: {
    fsMovePlan: () => Promise.resolve(h.movePlan),
    fsCopyPlan: () => Promise.resolve(h.movePlan),
    fsMoveExecute: () => {
      h.moveExecuted += 1;
      return Promise.resolve(h.moveExec ?? { status: "ok", data: "task-1" });
    },
    setOsFileClipboard: () => Promise.resolve({ status: "ok", data: null }),
  },
}));

import { clipPaste, executeTransfer } from "@/lib/fileActions";
import { useClipboard } from "@/stores/clipboard";
import { useAppSettings } from "@/stores/settings";
import type { DialogState } from "@/stores/ui-dialogs";

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
const confirm = (d: Extract<DialogState, { kind: "move-confirm" }>) =>
  executeTransfer("move", d.plan, "skip", vi.fn(), vi.fn(), vi.fn(), d.clip);

beforeEach(() => {
  h.moveExecuted = 0;
  h.moveExec = null;
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
