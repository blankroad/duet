import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCreateEntry } from "./useCreateEntry";
import { commands, type Entry } from "@/types/bindings";
import { useUIDialogs, type DialogState } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
vi.mock("@/types/bindings", () => ({
  commands: {
    fsMkdir: vi.fn(),
    fsCreateFile: vi.fn(),
    sshEditOpen: vi.fn(),
    openPath: vi.fn(),
  },
}));
const parent = { source: { kind: "local" as const }, path: "/tmp/create" };
const dialog: DialogState = { kind: "new-file", parent };
beforeEach(() => {
  vi.resetAllMocks();
  useUIDialogs.getState().open(dialog);
  useToast.setState({ show: vi.fn() });
});
afterEach(cleanup);
it("keeps the creation dialog open when the command fails", async () => {
  vi.mocked(commands.fsCreateFile).mockResolvedValue({
    status: "error",
    error: { kind: "Io", message: "already exists" },
  });
  const list = vi.fn();
  const { result } = renderHook(() => useCreateEntry(dialog, list, vi.fn()));
  await act(async () => {
    await expect(result.current("x")).rejects.toMatchObject({ kind: "Io" });
  });
  expect(useUIDialogs.getState().dialog).toBe(dialog);
  expect(list).not.toHaveBeenCalled();
});
it("does not report refresh failure as creation failure or close a newer dialog", async () => {
  let finish!: (r: Awaited<ReturnType<typeof commands.fsCreateFile>>) => void;
  vi.mocked(commands.fsCreateFile).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const list = vi.fn().mockRejectedValue(new Error("offline"));
  const { result } = renderHook(() => useCreateEntry(dialog, list, vi.fn()));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current("x");
  });
  const newer: DialogState = { kind: "settings" };
  useUIDialogs.getState().open(newer);
  await act(async () => {
    finish({ status: "ok", data: "id" });
    await pending;
  });
  expect(useUIDialogs.getState().dialog).toBe(newer);
  expect(commands.fsCreateFile).toHaveBeenCalledTimes(1);
  expect(useToast.getState().show).toHaveBeenCalledWith(
    expect.stringContaining("offline"),
    "error",
  );
});
it("opens the newly created remote file using the captured destination", async () => {
  const remote = {
    ...parent,
    source: {
      kind: "ssh" as const,
      connection_id: "c",
      user: "test",
      host_ip: "127.0.0.1",
    },
  };
  const request: DialogState = { kind: "new-file", parent: remote };
  useUIDialogs.getState().open(request);
  vi.mocked(commands.fsCreateFile).mockResolvedValue({
    status: "ok",
    data: "id",
  });
  vi.mocked(commands.sshEditOpen).mockResolvedValue({
    status: "ok",
    data: null,
  });
  const { result } = renderHook(() =>
    useCreateEntry(request, async () => [] as Entry[], vi.fn()),
  );
  await act(async () => result.current("note.txt", true));
  expect(commands.sshEditOpen).toHaveBeenCalledWith({
    ...remote,
    path: "/tmp/create/note.txt",
  });
  expect(commands.openPath).not.toHaveBeenCalled();
  expect(useUIDialogs.getState().dialog.kind).toBe("none");
});
