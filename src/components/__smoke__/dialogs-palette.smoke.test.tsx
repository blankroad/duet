import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { KeymapBinding } from "@/types/bindings";
import { commands as ipc } from "@/types/bindings";
import { useCommands } from "@/stores/commands";
import { useKeymap } from "@/stores/keymap";
import { usePalette } from "@/stores/palette";
import type { Command } from "@/lib/commands";
import { SettingsDialog } from "@/components/SettingsDialog";
import { CommandPalette } from "@/components/CommandPalette";
import { FrecencyJumper } from "@/components/FrecencyJumper";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useFrecency } from "@/stores/frecency";
import type { FrecencyEntry } from "@/types/bindings";

/**
 * dialogs-palette 사용자 시나리오 스모크 — 설정 › 키맵 편집, 명령 팔레트.
 * IPC 는 keymap 백엔드(같은 키 덮어쓰기)를 메모리로 흉내 낸다.
 */

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "command" in opts ? `${key}:${String(opts.command)}` : key,
  }),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@/components/settings/GeneralSection", () => ({
  GeneralSection: () => null,
}));

let store: KeymapBinding[] = [];
vi.mock("@/types/bindings", () => ({
  commands: {
    keymapSet: vi.fn((key: string, command_id: string) => {
      store = [...store.filter((b) => b.key !== key), { key, command_id }];
      return Promise.resolve({ status: "ok", data: store });
    }),
    keymapUnset: vi.fn((key: string) => {
      store = store.filter((b) => b.key !== key);
      return Promise.resolve({ status: "ok", data: store });
    }),
    frecencyQuery: vi.fn(),
    keymapReset: vi.fn(() => {
      store = [];
      return Promise.resolve({ status: "ok", data: store });
    }),
  },
}));

const hidden = vi.fn();
const sidebar = vi.fn();
const del = vi.fn();
const CMDS: Command[] = [
  {
    id: "view.toggleHidden",
    label: "Toggle hidden files",
    category: "View",
    defaultKey: "Ctrl+H",
    action: hidden,
  },
  {
    id: "view.toggleSidebar",
    label: "Toggle sidebar",
    category: "View",
    defaultKey: "Ctrl+B",
    action: sidebar,
  },
  {
    id: "file.delete",
    label: "Delete",
    category: "File",
    defaultKey: "Delete",
    action: del,
  },
];

function Shortcuts() {
  useGlobalShortcuts();
  return null;
}

function rowOf(label: string): HTMLElement {
  const cell = screen.getByText(label);
  return cell.closest("div[class*='grid']") as HTMLElement;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  store = [];
  useKeymap.getState().setAll([]);
  useCommands.getState().setBuiltins(CMDS);
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("설정 › 키맵 편집", () => {
  function openKeymap() {
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} />);
    fireEvent.click(screen.getByText("settings.nav.keymap"));
    return onClose;
  }

  it("키 캡처 중 Esc 는 캡처만 취소하고 설정 창은 그대로", () => {
    const onClose = openKeymap();
    fireEvent.click(
      rowOf("cmd.view.toggleSidebar").querySelector("button") as HTMLElement,
    );
    const input = screen.getByLabelText("settings.keymap.pressKey");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("settings.keymap.pressKey")).toBeNull();
    expect(screen.getByText("settings.title")).toBeTruthy();
  });

  it("다른 명령이 쓰는 키를 고르면 묻고, 바꾸면 원래 명령은 (없음) + 이유", async () => {
    openKeymap();
    fireEvent.click(
      rowOf("cmd.view.toggleSidebar").querySelector("button") as HTMLElement,
    );
    fireEvent.keyDown(screen.getByLabelText("settings.keymap.pressKey"), {
      key: "h",
      ctrlKey: true,
    });
    // 조용히 빼앗지 않는다 — 확인 먼저.
    expect(ipc.keymapSet).not.toHaveBeenCalled();
    const prompt = screen.getByRole("alert");
    expect(prompt.textContent).toContain(
      "settings.keymap.conflictPrompt:cmd.view.toggleHidden",
    );
    fireEvent.click(screen.getByText("settings.keymap.conflictReplace"));
    await flush();
    expect(ipc.keymapSet).toHaveBeenCalledWith("Ctrl+H", "view.toggleSidebar");
    expect(rowOf("cmd.view.toggleSidebar").textContent).toContain("Ctrl+H");
    const hiddenRow = rowOf("cmd.view.toggleHidden");
    expect(hiddenRow.textContent).toContain("settings.keymap.none");
    expect(
      hiddenRow.querySelector("[title^='settings.keymap.shadowed']"),
    ).not.toBeNull();
  });

  it("충돌 확인에서 Esc = 취소, 설정 창 유지, 아무것도 안 바뀜", () => {
    const onClose = openKeymap();
    fireEvent.click(
      rowOf("cmd.view.toggleSidebar").querySelector("button") as HTMLElement,
    );
    fireEvent.keyDown(screen.getByLabelText("settings.keymap.pressKey"), {
      key: "h",
      ctrlKey: true,
    });
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(ipc.keymapSet).not.toHaveBeenCalled();
  });

  it("같은 명령을 두 번 바꾸면 예전 키는 지워진다", async () => {
    openKeymap();
    const edit = () =>
      fireEvent.click(
        rowOf("cmd.view.toggleSidebar").querySelector("button") as HTMLElement,
      );
    edit();
    fireEvent.keyDown(screen.getByLabelText("settings.keymap.pressKey"), {
      key: "j",
      ctrlKey: true,
    });
    await flush();
    edit();
    fireEvent.keyDown(screen.getByLabelText("settings.keymap.pressKey"), {
      key: "k",
      ctrlKey: true,
    });
    await flush();
    expect(store).toEqual([
      { key: "Ctrl+K", command_id: "view.toggleSidebar" },
    ]);
  });
});

describe("명령 팔레트", () => {
  it("가려진 기본 키는 힌트로 보이지 않는다", () => {
    useKeymap
      .getState()
      .setAll([{ key: "Ctrl+H", command_id: "view.toggleSidebar" }]);
    usePalette.getState().open();
    render(<CommandPalette />);
    const hiddenItem = screen.getByText("cmd.view.toggleHidden")
      .parentElement as HTMLElement;
    expect(hiddenItem.textContent).not.toContain("Ctrl+H");
    const sidebarItem = screen.getByText("cmd.view.toggleSidebar")
      .parentElement as HTMLElement;
    expect(sidebarItem.textContent).toContain("Ctrl+H");
    act(() => usePalette.getState().close());
  });

  it("한글 조합 중 Enter 는 실행하지 않고, 조합이 끝난 Enter 는 실행", () => {
    usePalette.getState().open();
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText("palette.placeholder");
    fireEvent.change(input, { target: { value: "sidebar" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(sidebar).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    expect(sidebar).toHaveBeenCalledTimes(1);
  });

  it("↓ 로 움직인 항목이 보이도록 스크롤", () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    usePalette.getState().open();
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText("palette.placeholder");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(spy).toHaveBeenLastCalledWith({ block: "nearest" });
    act(() => usePalette.getState().close());
  });
});

describe("모달이 떠 있을 때 뒤 패널 단축키", () => {
  it("팔레트 결과 버튼에서 Delete 는 뒤 패널 삭제를 실행하지 않는다", () => {
    usePalette.getState().open();
    render(
      <>
        <Shortcuts />
        <CommandPalette />
      </>,
    );
    const btn = screen.getByText("cmd.file.delete").closest("button")!;
    btn.focus();
    fireEvent.keyDown(btn, { key: "Delete" });
    expect(del).not.toHaveBeenCalled();
    act(() => usePalette.getState().close());
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(del).toHaveBeenCalledTimes(1);
  });
});

describe("팔레트 커서", () => {
  it("검색어가 바뀌면 맨 위 결과로 돌아간다", () => {
    usePalette.getState().open();
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText("palette.placeholder");
    fireEvent.change(input, { target: { value: "toggle" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.change(input, { target: { value: "toggl" } });
    const items = screen.getAllByRole("button");
    expect(items[0]!.className).toContain("bg-active");
    act(() => usePalette.getState().close());
  });
});

describe("점프(Ctrl+J)", () => {
  const entry = (path: string): FrecencyEntry =>
    ({
      location: { source: { kind: "local" }, path },
      host_alias: null,
    }) as unknown as FrecencyEntry;

  it("늦게 온 옛 검색어 응답이 새 결과를 덮어쓰지 않는다", async () => {
    vi.useFakeTimers();
    type JumpResult = Awaited<ReturnType<typeof ipc.frecencyQuery>>;
    let resolveOld: (v: JumpResult) => void = () => {};
    vi.mocked(ipc.frecencyQuery)
      .mockReturnValueOnce(
        new Promise<JumpResult>((r) => {
          resolveOld = r;
        }),
      )
      .mockResolvedValueOnce({ status: "ok", data: [entry("/new")] });
    act(() => useFrecency.getState().open());
    render(
      <FrecencyJumper onOpenLocation={vi.fn()} onOpenHostPath={vi.fn()} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.change(screen.getByPlaceholderText("jumper.placeholder"), {
      target: { value: "new" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText("/new")).toBeTruthy();
    await act(async () => {
      resolveOld({ status: "ok", data: [entry("/old")] });
      await Promise.resolve();
    });
    expect(screen.queryByText("/old")).toBeNull();
    expect(screen.getByText("/new")).toBeTruthy();
    act(() => useFrecency.getState().close());
    vi.useRealTimers();
  });
});
