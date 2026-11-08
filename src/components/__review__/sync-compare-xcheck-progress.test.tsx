/**
 * sync-compare R2 교차 검토(opus-2) — 사용자가 실제로 보는 문자열 확인.
 * SC-14 진행 표시, SC-13 동기화 미리보기, SC-19 시작 시 전역 색인 호출 횟수.
 */
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ProgressInfo, TaskDto } from "@/types/bindings";
import { commands } from "@/types/bindings";
import "@/i18n";

vi.mock("@/types/bindings", () => ({
  commands: {
    taskCancel: vi.fn(),
    fsSyncPreview: vi.fn(),
    fsTrashUsage: vi.fn(),
    indexBuildGlobal: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
  events: {
    indexProgressEvent: { listen: vi.fn().mockResolvedValue(() => {}) },
  },
}));

const { useTasks } = await import("@/stores/tasks");
const { ProgressModal } = await import("../dialogs/ProgressModal");
const { TasksBar } = await import("../TasksBar");
const { SyncDialog } = await import("../dialogs/SyncDialog");
const { useIndexProgressEvents } =
  await import("@/hooks/useIndexProgressEvents");

// 백엔드 emit 그대로: sync 는 ops.rs:1296, merge/apply/3-way 는 emit_merge_progress(ops.rs:1936)
// — 항목 개수를 bytes_done/bytes_total 에 넣고 files_* 는 기본값 0.
const COUNT_AS_BYTES: ProgressInfo = {
  bytes_done: 12,
  bytes_total: 40,
  speed_bps: null,
  eta_sec: null,
  percent: 30,
  current_file: null,
  files_done: 0,
  files_total: 0,
};

function seed(kind: TaskDto["kind"], title: string) {
  useTasks.setState({
    tasks: new Map([
      [
        "t1",
        {
          id: "t1",
          kind,
          status: { kind: "running" },
          title,
          host_key: "local",
          progress: COUNT_AS_BYTES,
          error_message: null,
          affected_locations: [],
        } as unknown as TaskDto,
      ],
    ]),
    cancelling: new Set(),
  });
}

afterEach(cleanup);

describe("SC-14 진행 표시 — 항목 개수가 바이트로", () => {
  beforeEach(() =>
    useTasks.setState({ tasks: new Map(), cancelling: new Set() }),
  );

  it("현재: 동기화 진행 창이 '12 B / 40 B · 30%' (실제는 파일 12/40개)", () => {
    seed("sync", "Syncing /a → /b");
    render(
      <ProgressModal title="Syncing" taskId="t1" onBackground={() => {}} />,
    );
    expect(screen.getByText(/12 B \/ 40 B · 30%/)).toBeTruthy();
  });

  it("현재: 병합(같은 'sync' kind) 하단 작업 표시줄이 '12 B / 40 B'", () => {
    seed("sync", "Merging /a ↔ /b");
    render(<TasksBar />);
    expect(screen.getByText("12 B / 40 B")).toBeTruthy();
  });

  it.fails(
    "sync-compare: SC-14 동기화·병합 진행은 바이트가 아니라 개수로 보여야 한다",
    () => {
      seed("sync", "Merging /a ↔ /b");
      render(<TasksBar />);
      expect(screen.queryByText(/\bB \//)).toBeNull();
    },
  );

  it("대조군: 삭제(kind=delete) 는 개수로 보인다", () => {
    seed("delete", "Deleting");
    useTasks.setState((s) => {
      const t = s.tasks.get("t1")!;
      return {
        tasks: new Map([
          [
            "t1",
            {
              ...t,
              progress: { ...COUNT_AS_BYTES, files_done: 12, files_total: 40 },
            },
          ],
        ]),
      };
    });
    render(<TasksBar />);
    expect(screen.getByText("12 / 40")).toBeTruthy();
  });
});

describe("SC-13 동기화 미리보기가 빈 성공으로 오면", () => {
  it("현재: '복사 0' 만 보이고 [동기화] 활성 — 읽지 못한 하위 폴더 경고 없음", async () => {
    // 백엔드(sync_preview)는 읽기 실패 하위 폴더를 건너뛰고 빈 목록으로 성공 반환한다
    // (sol 재현 sync_preview_propagates_unreadable_source_subtree).
    vi.mocked(commands.fsSyncPreview).mockResolvedValue({
      status: "ok",
      data: { copy: [], prune: [], truncated: false },
    });
    render(
      <SyncDialog
        src={{ source: { kind: "local" }, path: "/fixture/src" }}
        dst={{ source: { kind: "local" }, path: "/fixture/dst" }}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Copy \(new\/changed\)/).textContent).toMatch(/0/);
    const cta = screen.getByRole("button", {
      name: /^Sync/,
    }) as HTMLButtonElement;
    expect(cta.disabled).toBe(false);
    expect(screen.queryByText(/unreadable|permission|skipped/i)).toBeNull();
  });
});

describe("SC-19 시작 시 전역 색인", () => {
  it("StrictMode(개발 빌드)에서는 indexBuildGlobal 이 두 번 — 백엔드는 매번 새 빌드를 띄운다", () => {
    vi.mocked(commands.indexBuildGlobal).mockClear();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    renderHook(() => useIndexProgressEvents(), { wrapper });
    expect(commands.indexBuildGlobal).toHaveBeenCalledTimes(2);
  });

  it("일반 마운트(배포 빌드)에서는 앱 시작마다 1번", () => {
    vi.mocked(commands.indexBuildGlobal).mockClear();
    renderHook(() => useIndexProgressEvents());
    expect(commands.indexBuildGlobal).toHaveBeenCalledTimes(1);
  });
});
