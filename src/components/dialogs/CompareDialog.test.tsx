import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CompareEntry, ComparePlan } from "@/types/bindings";
import { commands } from "@/types/bindings";
import "@/i18n";
import { CompareDialog } from "./CompareDialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@/types/bindings", () => ({
  commands: {
    fsCompareDirs: vi.fn(),
    fsCompareVerify: vi.fn(),
    settingsGet: vi.fn().mockResolvedValue({ status: "error", error: {} }),
    settingsSet: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

const entry = (status: CompareEntry["status"]): CompareEntry => ({
  rel: "x.txt",
  kind: "file",
  status,
  left_size: 1,
  right_size: 1,
  left_mtime_ms: 2000,
  right_mtime_ms: 1000,
});
const plan = (status: CompareEntry["status"]): ComparePlan => ({
  left: { source: { kind: "local" }, path: "/fixture/l" },
  right: { source: { kind: "local" }, path: "/fixture/r" },
  entries: [entry(status)],
  left_only: 0,
  right_only: 0,
  differ: status === "same" ? 0 : 1,
  same: status === "same" ? 1 : 0,
  truncated: false,
  strategy: { kind: "local_to_local" },
});

Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);

describe("CompareDialog 다시 비교", () => {
  it("다시 비교로 '같음' 이 된 행은 옛 기본 방향으로 덮어쓰지 않는다", async () => {
    vi.mocked(commands.fsCompareDirs).mockResolvedValue({
      status: "ok",
      data: plan("same"),
    });
    const onApply = vi.fn();
    render(
      <CompareDialog
        plan={plan("newer_left")}
        onClose={() => {}}
        onMerge={() => {}}
        onApply={onApply}
      />,
    );
    const applyBtn = () =>
      screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement;
    expect(applyBtn().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Re-compare/ }));
      await Promise.resolve();
    });
    expect(applyBtn().disabled).toBe(true);
  });

  it("검증하는 사이 다시 비교했으면 늦게 온 검증이 옛 목록을 되살리지 않는다", async () => {
    const two = (): ComparePlan => ({
      ...plan("same"),
      entries: [
        { ...entry("same"), rel: "old.txt" },
        { ...entry("newer_left"), rel: "excluded.txt" },
      ],
    });
    type VerifyResult = Awaited<ReturnType<typeof commands.fsCompareVerify>>;
    let resolveVerify: (v: VerifyResult) => void = () => {};
    vi.mocked(commands.fsCompareVerify).mockReturnValue(
      new Promise<VerifyResult>((r) => {
        resolveVerify = r;
      }),
    );
    vi.mocked(commands.fsCompareDirs).mockResolvedValue({
      status: "ok",
      data: {
        ...plan("same"),
        entries: [{ ...entry("same"), rel: "new.txt" }],
      },
    });
    const onApply = vi.fn();
    render(
      <CompareDialog
        plan={two()}
        onClose={() => {}}
        onMerge={() => {}}
        onApply={onApply}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Verify/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Re-compare/ }));
      await Promise.resolve();
    });
    await act(async () => {
      resolveVerify({
        status: "ok",
        data: [{ rel: "old.txt", equal: false }],
      } as VerifyResult);
      await Promise.resolve();
    });
    expect(screen.queryByText(/excluded\.txt/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("CompareDialog 머지 규칙 (SC-07)", () => {
  const leftOnly: ComparePlan = {
    ...plan("left_only"),
    entries: [
      { ...entry("left_only"), right_size: null, right_mtime_ms: null },
    ],
    left_only: 1,
    differ: 0,
  };

  it("머지는 지금 목록을 만든 규칙을 함께 보낸다", () => {
    const onMerge = vi.fn();
    const rules = { ignore_globs: ["node_modules"], mtime_tolerance_ms: 0 };
    render(
      <CompareDialog
        plan={leftOnly}
        rules={rules}
        onClose={() => {}}
        onMerge={onMerge}
        onApply={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Merge/ }));
    expect(onMerge).toHaveBeenCalledWith(false, rules);
  });

  it("다시 비교 뒤의 머지는 새 규칙을 보낸다", async () => {
    vi.mocked(commands.fsCompareDirs).mockResolvedValue({
      status: "ok",
      data: leftOnly,
    });
    const onMerge = vi.fn();
    render(
      <CompareDialog
        plan={leftOnly}
        rules={{ ignore_globs: [], mtime_tolerance_ms: 0 }}
        onClose={() => {}}
        onMerge={onMerge}
        onApply={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/ignore/i), {
      target: { value: "*.log  dist" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Re-compare/ }));
    });
    fireEvent.click(screen.getByRole("button", { name: /^Merge/ }));
    expect(onMerge).toHaveBeenCalledWith(false, {
      ignore_globs: ["*.log", "dist"],
      mtime_tolerance_ms: 0,
    });
  });
});

describe("CompareRulesBar 늦은 설정 프리필 (SC-11 R2)", () => {
  it("사용자가 먼저 고른 허용오차·무시 패턴을 늦게 온 설정이 덮지 않는다", async () => {
    type SettingsResult = Awaited<ReturnType<typeof commands.settingsGet>>;
    let resolveSettings!: (v: SettingsResult) => void;
    vi.mocked(commands.settingsGet).mockReturnValueOnce(
      new Promise<SettingsResult>((done) => {
        resolveSettings = done;
      }),
    );
    vi.mocked(commands.fsCompareDirs).mockResolvedValue({
      status: "ok",
      data: plan("same"),
    });
    const remotePlan: ComparePlan = {
      ...plan("same"),
      right: {
        source: {
          kind: "ssh",
          connection_id: "c1",
          host_ip: "10.0.0.2",
          user: "u",
        },
        path: "/srv/r",
      },
    };
    render(
      <CompareDialog
        plan={remotePlan}
        onClose={() => {}}
        onMerge={() => {}}
        onApply={() => {}}
      />,
    );
    const tol = screen.getByTitle(/mtime tolerance/) as HTMLSelectElement;
    const ignore = screen.getByPlaceholderText(/ignore/i) as HTMLInputElement;
    expect(tol.value).toBe("2000"); // 원격 기본값
    fireEvent.change(tol, { target: { value: "0" } });
    fireEvent.change(ignore, { target: { value: "dist" } });
    await act(async () => {
      resolveSettings({
        status: "ok",
        data: {
          compare_ignore_globs: ["saved"],
          compare_mtime_tolerance_ms: 0,
        },
      } as unknown as SettingsResult);
    });
    expect(tol.value).toBe("0");
    expect(ignore.value).toBe("dist");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Re-compare/ }));
    });
    expect(vi.mocked(commands.fsCompareDirs).mock.calls.at(-1)?.[2]).toEqual({
      ignore_globs: ["dist"],
      mtime_tolerance_ms: 0,
    });
    expect(
      vi.mocked(commands.settingsSet).mock.calls.at(-1)?.[0]
        .compare_mtime_tolerance_ms,
    ).toBe(0);
  });
});

// 리뷰어(sol) 독립 R1 리뷰의 회귀 테스트를 손으로 옮김(원 패치는 a3a271c 기준이라 충돌).
describe("independent round-1 SC-11 adversarial review", () => {
  type SettingsResult = Awaited<ReturnType<typeof commands.settingsGet>>;
  const remotePlan: ComparePlan = {
    ...plan("left_only"),
    right: {
      source: {
        kind: "ssh",
        connection_id: "fixture",
        host_ip: "10.0.0.2",
        user: "u",
      },
      path: "/fixture/remote",
    },
  };
  function deferSettings() {
    let finish: (value: SettingsResult) => void = () => {};
    vi.mocked(commands.settingsGet).mockReturnValueOnce(
      new Promise<SettingsResult>((resolve) => {
        finish = resolve;
      }),
    );
    return (globs: string[], tol: number) =>
      finish({
        status: "ok",
        data: { compare_ignore_globs: globs, compare_mtime_tolerance_ms: tol },
      } as unknown as SettingsResult);
  }
  const renderRemote = () =>
    render(
      <CompareDialog
        plan={remotePlan}
        rules={{ ignore_globs: [], mtime_tolerance_ms: 2000 }}
        onClose={() => {}}
        onMerge={() => {}}
        onApply={() => {}}
      />,
    );

  it("late settings must preserve the user's explicitly selected exact tolerance", async () => {
    const finishSettings = deferSettings();
    renderRemote();
    const control = screen.getByTitle(/mtime tolerance/) as HTMLSelectElement;
    expect(control.value).toBe("2000");
    fireEvent.change(control, { target: { value: "0" } });
    expect(control.value).toBe("0");
    await act(async () => {
      finishSettings([], 0);
    });
    expect(control.value).toBe("0");
  });

  it("late settings must preserve edited ignore text but still prefill the untouched tolerance", async () => {
    const finishSettings = deferSettings();
    renderRemote();
    const ignore = screen.getByPlaceholderText(/ignore/i) as HTMLInputElement;
    const control = screen.getByTitle(/mtime tolerance/) as HTMLSelectElement;
    fireEvent.change(ignore, { target: { value: "build" } });
    await act(async () => {
      finishSettings(["saved-glob"], 60_000);
    });
    expect(ignore.value).toBe("build");
    expect(control.value).toBe("60000");
  });
});
