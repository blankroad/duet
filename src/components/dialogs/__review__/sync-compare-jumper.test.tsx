/**
 * sync-compare 점검 (C-25) — FrecencyJumper 재현 테스트.
 * 결함 재현은 `it.fails` (기대 동작을 단언 → 현재 실패).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { FrecencyEntry } from "@/types/bindings";
import { commands } from "@/types/bindings";
import "@/i18n";
import { FrecencyJumper } from "@/components/FrecencyJumper";
import { useFrecency } from "@/stores/frecency";

vi.mock("@/types/bindings", () => ({
  commands: {
    frecencyQuery: vi.fn(),
  },
}));

Element.prototype.scrollIntoView = () => {};

afterEach(() => {
  act(() => useFrecency.getState().close());
  cleanup();
  vi.mocked(commands.frecencyQuery).mockReset();
});

const remote = (alias: string, path: string, ip = "10.0.0.5"): FrecencyEntry =>
  ({
    location: {
      source: {
        kind: "ssh",
        // 재시작 후라 이 id 의 연결은 store 에 없다(죽은 id).
        connection_id: "dead-conn-id",
        host_ip: ip,
        user: "u",
      },
      path,
    },
    host_alias: alias,
    count: 3,
    last_visit_ms: 1,
  }) as FrecencyEntry;

function renderJumper(entries: FrecencyEntry[]) {
  vi.mocked(commands.frecencyQuery).mockResolvedValue({
    status: "ok",
    data: entries,
  });
  const onOpenLocation = vi.fn();
  const onOpenHostPath = vi.fn();
  render(
    <FrecencyJumper
      onOpenLocation={onOpenLocation}
      onOpenHostPath={onOpenHostPath}
    />,
  );
  act(() => useFrecency.getState().open());
  return { onOpenLocation, onOpenHostPath };
}

describe("sync-compare C-25 FrecencyJumper", () => {
  it("원격 항목 Enter → (죽은 connection_id 대신) alias 로 onOpenHostPath", async () => {
    const { onOpenHostPath, onOpenLocation } = renderJumper([
      remote("prod", "/srv/app"),
    ]);
    await waitFor(() => expect(screen.getByText("/srv/app")).toBeTruthy());
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onOpenHostPath).toHaveBeenCalledWith("prod", "/srv/app", "left");
    expect(onOpenLocation).not.toHaveBeenCalled();
  });

  it.fails(
    "sync-compare: 재시작 후 원격 항목의 출처 라벨이 alias('prod') 대신 IP 로 보인다",
    async () => {
      renderJumper([remote("prod", "/srv/app")]);
      await waitFor(() => expect(screen.getByText("/srv/app")).toBeTruthy());
      // 기대: 저장된 host_alias 가 있으니 'prod' 로 표시.
      expect(screen.getByText("prod")).toBeTruthy();
    },
  );

  it.fails(
    "sync-compare: 같은 IP 의 두 alias 가 같은 경로를 가지면 React key 충돌 경고",
    async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        renderJumper([
          remote("prod-root", "/var/log"),
          remote("prod-app", "/var/log"),
        ]);
        await waitFor(() =>
          expect(screen.getAllByText("/var/log")).toHaveLength(2),
        );
        const dupKey = err.mock.calls.some((c) =>
          String(c[0]).includes("same key"),
        );
        expect(dupKey).toBe(false);
      } finally {
        err.mockRestore();
      }
    },
  );

  it("IME 조합 중 Enter 는 이동하지 않는다", async () => {
    const { onOpenHostPath } = renderJumper([remote("prod", "/srv/app")]);
    await waitFor(() => expect(screen.getByText("/srv/app")).toBeTruthy());
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    expect(onOpenHostPath).not.toHaveBeenCalled();
  });
});
