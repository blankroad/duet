// fileops 점검(2026-11-08, opus) 재현 — 잘라내기(Ctrl+X) 후 붙여넣기(Ctrl+V).
//
// `clipPaste` 는 `planTransferTo` 가 끝나자마자(= 확인 다이얼로그를 **열기만** 한 시점)
// move 클립보드를 비운다 (src/lib/fileActions.ts clipPaste 끝). 그래서 확인창에서 [취소]
// 하거나 plan 단계가 실패해도 잘라낸 항목이 클립보드에서 사라진다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryRef, Location } from "@/types/bindings";

const h = vi.hoisted(() => ({
  movePlan: null as unknown,
  moveExecuted: 0,
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
vi.mock("@/types/bindings", () => ({
  commands: {
    fsMovePlan: () => Promise.resolve(h.movePlan),
    fsMoveExecute: () => {
      h.moveExecuted += 1;
      return Promise.resolve({ status: "ok", data: "task-1" });
    },
    setOsFileClipboard: () => Promise.resolve({ status: "ok", data: null }),
  },
}));

import { clipPaste } from "@/lib/fileActions";
import { useClipboard } from "@/stores/clipboard";
import { useAppSettings } from "@/stores/settings";

const src: Location = { source: { kind: "local" }, path: "C:\\work" };
const dst: Location = { source: { kind: "local" }, path: "D:\\backup" };
const cut: EntryRef[] = [{ location: src, name: "report.docx" }];

const plan = (conflicts: number) => ({
  status: "ok",
  data: {
    src_source: { kind: "local" },
    dst,
    items: cut,
    conflicts: Array.from({ length: conflicts }, () => ({
      name: "report.docx",
    })),
    is_same_fs: true,
    total_size_bytes: 0,
    strategy: "local_to_local",
  },
});

beforeEach(() => {
  h.moveExecuted = 0;
  useClipboard.getState().set(cut, "move");
});

describe("fileops-opus: 잘라내기 붙여넣기", () => {
  it.fails("fileops-24: 충돌로 확인창이 떴을 때(아직 이동 안 함) 잘라낸 항목이 클립보드에 남아 있다", async () => {
    h.movePlan = plan(1);
    const open = vi.fn();
    await clipPaste(open, vi.fn(), dst);
    // 확인창만 열렸다 — 아직 아무것도 이동하지 않았다.
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "move-confirm" }),
    );
    expect(h.moveExecuted).toBe(0);
    // 사용자가 [취소] 하면 다시 Ctrl+V 할 수 있어야 한다.
    expect(useClipboard.getState().entry?.mode).toBe("move");
  });

  it.fails("fileops-24: plan 단계가 실패해도(대상 폴더 권한 등) 잘라낸 항목이 사라지지 않는다", async () => {
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
});
