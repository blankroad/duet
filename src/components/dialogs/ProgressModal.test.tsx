import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { ProgressInfo, TaskDto } from "@/types/bindings";
import "@/i18n";

vi.mock("@/types/bindings", () => ({ commands: { taskCancel: vi.fn() } }));

const { useTasks } = await import("@/stores/tasks");
const { ProgressModal } = await import("./ProgressModal");

const DST = "/Users/ctmctm/Desktop/01_PROJECT/duet/src/assets";
const LONG_NAME = "report-final-revision-2026-Q3-approved.pdf";

const PROGRESS: ProgressInfo = {
  bytes_done: 1_200_000,
  bytes_total: 5_000_000,
  speed_bps: 3_100_000,
  eta_sec: 2,
  percent: 24,
  current_file: LONG_NAME,
  files_done: 0,
  files_total: 3,
};

function seedTask(over: Partial<TaskDto> = {}) {
  const task = {
    id: "t1",
    kind: "copy",
    status: { kind: "running" },
    title: `Copying ${LONG_NAME} → ${DST}`,
    host_key: "local",
    progress: PROGRESS,
    error_message: null,
    affected_locations: [{ source: { kind: "local" }, path: DST }],
    ...over,
  } as unknown as TaskDto;
  useTasks.setState({ tasks: new Map([["t1", task]]) });
}

function render_() {
  return render(
    <ProgressModal title="Copying…" taskId="t1" onBackground={() => {}} />,
  );
}

describe("ProgressModal", () => {
  beforeEach(() => useTasks.setState({ tasks: new Map() }));

  it("파일명을 경로와 섞지 않고 단독으로 보여준다", () => {
    seedTask();
    render_();

    const name = screen.getByText(LONG_NAME);
    // 파일명 요소 안에 경로가 섞여 있으면 truncate 가 이름을 지운다 — 회귀 방지.
    expect(name.textContent).toBe(LONG_NAME);
    expect(name.textContent).not.toContain("/");
    expect(name.getAttribute("title")).toBe(LONG_NAME);
  });

  it("받는 위치는 가운데를 생략하되 말단과 전체 경로(tooltip)를 남긴다", () => {
    seedTask();
    render_();

    const dst = screen.getByTitle(DST);
    expect(dst.textContent).toContain("…");
    expect(dst.textContent?.endsWith("assets")).toBe(true);
    expect(dst.textContent!.length).toBeLessThan(DST.length);
  });

  it("항목 카운터는 '현재 번째 / 전체'", () => {
    seedTask();
    render_();
    expect(screen.getByText("1 / 3")).toBeDefined();
  });

  it("목적지 개념이 없는 kind 는 받는 위치를 숨긴다", () => {
    seedTask({ kind: "delete" });
    render_();
    expect(screen.queryByTitle(DST)).toBeNull();
  });

  it("진행률 도착 전(spinner)에도 받는 위치는 보여준다", () => {
    seedTask({ progress: null });
    render_();
    expect(screen.getByTitle(DST)).toBeDefined();
  });

  /**
   * 스모크 — 실제 이벤트 경로를 그대로 탄다: enqueued(add) → progress(setProgress).
   * useTaskEvents 가 하는 것과 동일한 store 호출이므로, 백엔드가 emit_item_start 로
   * 보내는 첫 Progress 가 화면의 파일명이 되는지까지 이어서 확인한다.
   */
  it("enqueued → progress 이벤트 순서대로 들어와도 파일명이 뜬다", () => {
    seedTask({ progress: null });
    render_();
    // 아직 진행률 없음 — 파일명 자리는 비어 있다.
    expect(screen.queryByText(LONG_NAME)).toBeNull();

    // 백엔드의 첫 emit(항목 시작): 바이트 0, 파일명만 있는 상태.
    act(() => {
      useTasks.getState().setProgress("t1", {
        ...PROGRESS,
        bytes_done: 0,
        speed_bps: null,
        eta_sec: null,
        percent: 0,
      });
    });

    expect(screen.getByText(LONG_NAME)).toBeDefined();
    expect(screen.getByText("1 / 3")).toBeDefined();
    expect(screen.getByTitle(DST)).toBeDefined();
  });
});
