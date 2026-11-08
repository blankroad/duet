/**
 * sync-compare 점검(opus-1, C-08/C-12) — 비교창 사용자 흐름.
 * `it.fails` = 기대 동작을 단언하고 현재 코드에서 실패(결함 재현).
 * 일반 `it` = 현재 동작 기록(보고서의 근거).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { CompareEntry, ComparePlan } from "@/types/bindings";
import { commands } from "@/types/bindings";
import "@/i18n";
import { CompareDialog } from "../CompareDialog";
import { SyncDialog } from "../SyncDialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@/types/bindings", () => ({
  commands: {
    fsCompareDirs: vi.fn(),
    fsCompareVerify: vi.fn(),
    fsComparePairPreview: vi.fn(),
    fsSyncPreview: vi.fn(),
    fsTrashUsage: vi.fn(),
    settingsGet: vi.fn().mockResolvedValue({ status: "error", error: {} }),
    settingsSet: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);

const T = 1_762_600_000_000; // 고정 시각(ms)
const mk = (
  rel: string,
  status: CompareEntry["status"],
  over: Partial<CompareEntry> = {},
): CompareEntry => ({
  rel,
  kind: "file",
  status,
  left_size: 10,
  right_size: 10,
  left_mtime_ms: T,
  right_mtime_ms: T,
  ...over,
});
const planOf = (
  entries: CompareEntry[],
  extra: Partial<ComparePlan> = {},
): ComparePlan => ({
  left: { source: { kind: "local" }, path: "/fixture/l" },
  right: {
    source: {
      kind: "ssh",
      connection_id: "c1",
      host_ip: "10.0.0.2",
      user: "u",
    },
    path: "/srv/r",
  },
  entries,
  left_only: entries.filter((e) => e.status === "left_only").length,
  right_only: entries.filter((e) => e.status === "right_only").length,
  differ: 0,
  same: 0,
  truncated: false,
  strategy: { kind: "relay" },
  ...extra,
});

const applyBtn = () =>
  screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement;

describe("C-08 로컬↔원격 기본 허용오차 0", () => {
  // 로컬(ms 정밀도) ↔ SFTP(초 단위) — 크기 같고 1초 미만 차이. 백엔드는 tol 0 이면
  // NewerLeft 로 분류한다(compare.rs:267). 사용자에게 같은 크기·같은 시각으로 보인다.
  const subSecond = planOf([
    mk("a.txt", "newer_left", { left_mtime_ms: T + 517 }),
    mk("b.txt", "newer_left", { left_mtime_ms: T + 20 }),
    mk("c.txt", "newer_left", { left_mtime_ms: T + 999 }),
  ]);

  it("현재: 같아 보이는 3개가 기본으로 '덮어쓰기' 3 으로 잡힌다", () => {
    const onApply = vi.fn();
    render(
      <CompareDialog
        plan={subSecond}
        onClose={() => {}}
        onMerge={() => {}}
        onApply={onApply}
      />,
    );
    expect(applyBtn().textContent).toMatch(/Apply \(3\)/);
    // 행에 보이는 크기·시각이 양쪽 동일 — 무엇이 다른지 화면에서 알 수 없다.
    const rows = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.textContent).not.toMatch(/→ .*B/);
    fireEvent.click(applyBtn());
    expect(onApply.mock.calls[0]?.[0]).toEqual([
      { rel: "a.txt", direction: "to_right" },
      { rel: "b.txt", direction: "to_right" },
      { rel: "c.txt", direction: "to_right" },
    ]);
  });

  it.fails(
    "sync-compare: 1초 미만 차이뿐인 로컬↔원격 행을 기본으로 덮어쓰기에 넣지 않아야 한다",
    () => {
      const onApply = vi.fn();
      render(
        <CompareDialog
          plan={subSecond}
          onClose={() => {}}
          onMerge={() => {}}
          onApply={onApply}
        />,
      );
      expect(applyBtn().disabled).toBe(true);
    },
  );
});

describe("C-08 필터·검색으로 가린 행도 적용된다", () => {
  it("현재: 경로 검색으로 1개만 보이는데 Apply 는 3개를 보낸다", () => {
    const onApply = vi.fn();
    render(
      <CompareDialog
        plan={planOf(
          [
            mk("docs/readme.md", "left_only", {
              right_size: null,
              right_mtime_ms: null,
            }),
            mk("build/out.bin", "newer_left", { left_mtime_ms: T + 60_000 }),
            mk("build/cache.bin", "newer_right", {
              right_mtime_ms: T + 60_000,
            }),
          ],
          { strategy: { kind: "local_to_local" } },
        )}
        onClose={() => {}}
        onMerge={() => {}}
        onApply={onApply}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Search path/), {
      target: { value: "readme" },
    });
    expect(
      within(screen.getByRole("listbox")).getAllByRole("option"),
    ).toHaveLength(1);
    fireEvent.click(applyBtn());
    const sent = onApply.mock.calls[0]?.[0] as { rel: string }[];
    expect(sent.map((d) => d.rel)).toEqual([
      "docs/readme.md",
      "build/out.bin",
      "build/cache.bin",
    ]);
  });
});

describe("C-08 키보드", () => {
  it("현재: ←/→ 로 방향을 바꾼 뒤 키보드로는 '건너뛰기(·)' 로 되돌릴 수 없다", () => {
    const onApply = vi.fn();
    render(
      <CompareDialog
        plan={planOf([mk("x.txt", "differ", { left_size: 1, right_size: 2 })], {
          strategy: { kind: "local_to_local" },
        })}
        onClose={() => {}}
        onMerge={() => {}}
        onApply={onApply}
      />,
    );
    const list = screen.getByRole("listbox");
    expect(applyBtn().disabled).toBe(true); // differ 기본 skip
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(applyBtn().disabled).toBe(false);
    for (const key of ["Delete", "Backspace", " ", "Escape", "s", "."])
      fireEvent.keyDown(list, { key });
    expect(applyBtn().disabled).toBe(false); // 여전히 적용 대상
  });
});

describe("C-08 내용 검증", () => {
  it("64MB 초과 등 검증 불가 개수를 문장으로 알려 준다", async () => {
    vi.mocked(commands.fsCompareVerify).mockResolvedValue({
      status: "ok",
      data: [
        { rel: "big.iso", equal: null },
        { rel: "s.txt", equal: false },
      ],
    });
    render(
      <CompareDialog
        plan={planOf([mk("big.iso", "same"), mk("s.txt", "same")], {
          strategy: { kind: "local_to_local" },
        })}
        onClose={() => {}}
        onMerge={() => {}}
        onApply={() => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Verify/ }));
      await Promise.resolve();
    });
    expect(
      screen.getByText(/Verified 2 — actually differ 1, unverifiable 1/),
    ).toBeTruthy();
  });
});

describe("C-19 SyncDialog 목록", () => {
  it.fails(
    "sync-compare: 200개 넘는 복사 목록은 '외 N개' 처럼 잘렸음을 보여야 한다",
    async () => {
      const copy = Array.from({ length: 450 }, (_, i) => `f${i}.txt`);
      vi.mocked(commands.fsSyncPreview).mockResolvedValue({
        status: "ok",
        data: { copy, prune: [], truncated: false },
      });
      render(
        <SyncDialog
          src={{ source: { kind: "local" }, path: "/fixture/a" }}
          dst={{ source: { kind: "local" }, path: "/fixture/b" }}
          onClose={() => {}}
          onConfirm={() => {}}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText("f199.txt")).toBeTruthy();
      expect(screen.queryByText("f200.txt")).toBeNull(); // 현재 200개에서 끊김
      // 기대: 끊겼다는 표시(250 more / 외 250개 …)
      expect(screen.getByText(/250/)).toBeTruthy();
    },
  );

  it("현재: 새로 만들 파일과 덮어쓸 파일이 한 목록('Copy (new/changed)')으로 섞인다", async () => {
    vi.mocked(commands.fsSyncPreview).mockResolvedValue({
      status: "ok",
      data: { copy: ["new.txt", "existing.txt"], prune: [], truncated: false },
    });
    render(
      <SyncDialog
        src={{ source: { kind: "local" }, path: "/fixture/a" }}
        dst={{ source: { kind: "local" }, path: "/fixture/b" }}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Copy \(new\/changed\)/)).toBeTruthy();
    expect(screen.queryByText(/overwrit|backup|\.bak/i)).toBeNull();
  });

  it("미리보기 실패 + 삭제 전파 끔 → 미리보기 없이도 실행 가능(의도된 동작 기록)", async () => {
    vi.mocked(commands.fsSyncPreview).mockResolvedValue({
      status: "error",
      error: { kind: "Ssh", message: "rsync dry-run failed (exit 12): x" },
    });
    const onConfirm = vi.fn();
    render(
      <SyncDialog
        src={{ source: { kind: "local" }, path: "/fixture/a" }}
        dst={{ source: { kind: "local" }, path: "/fixture/b" }}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const cta = screen.getByRole("button", {
      name: /^Sync/,
    }) as HTMLButtonElement;
    expect(cta.disabled).toBe(false);
    expect(screen.getByText(/Preview failed: /)).toBeTruthy();
  });
});
