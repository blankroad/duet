import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Conflict, CopyPlan, EntryRef } from "@/types/bindings";
import { CopyMoveConfirmDialog } from "./CopyMoveConfirmDialog";
import "@/i18n";

const SRC = "/src";
const DST = "/Users/ctmctm/Documents/very/long/path/to/target";
const ref = (name: string): EntryRef => ({
  location: { source: { kind: "local" }, path: SRC },
  name,
});
const conflict = (name: string): Conflict => ({
  name,
  dst_path: `${DST}/${name}`,
  will_become_backup: "",
  dst_size: 10,
  dst_modified_ms: 1000,
  src_size: 20,
  src_modified_ms: 2000,
});

function plan(over: Partial<CopyPlan> = {}): CopyPlan {
  return {
    src_source: { kind: "local" },
    dst: { source: { kind: "local" }, path: DST },
    items: [ref("a.txt")],
    conflicts: [],
    total_size_bytes: 1024,
    strategy: { kind: "local_to_local" },
    ...over,
  };
}

function render_(
  p: CopyPlan,
  handlers: Partial<Parameters<typeof CopyMoveConfirmDialog>[0]> = {},
) {
  const onConfirm = vi.fn();
  const onConfirmPerFile = vi.fn();
  render(
    <CopyMoveConfirmDialog
      kind="copy"
      plan={p}
      onCancel={() => {}}
      onConfirm={onConfirm}
      onConfirmPerFile={onConfirmPerFile}
      {...handlers}
    />,
  );
  return { onConfirm, onConfirmPerFile };
}

describe("CopyMoveConfirmDialog", () => {
  /**
   * 회귀 방지 — 원래 이 다이얼로그는 "1개, 40 KB → /경로" 만 보여줘서 어떤 파일을
   * 복사하는지 확인할 수 없었다. 개수는 파일명을 대신하지 못한다.
   */
  it("항목 이름을 모두 목록으로 보여준다", () => {
    render_(plan({ items: [ref("a.txt"), ref("b.txt"), ref("c.txt")] }));
    for (const n of ["a.txt", "b.txt", "c.txt"]) {
      const el = screen.getByText(n);
      // 파일명 요소에 경로가 섞이면 truncate 가 이름을 지운다.
      expect(el.textContent).toBe(n);
    }
  });

  it("원본과 받는 위치를 따로, 경로는 가운데 생략 + 전체는 tooltip", () => {
    render_(plan());
    const dst = screen.getByTitle(DST);
    expect(dst.textContent).toContain("…");
    expect(dst.textContent?.endsWith("target")).toBe(true);
    expect(screen.getByTitle(SRC).textContent).toBe(SRC);
  });

  it("개수·크기는 요약으로, 전송 경로는 말로", () => {
    render_(
      plan({ items: [ref("a.txt"), ref("b.txt")], total_size_bytes: 40960 }),
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("2 item(s) · 40 KB");
    expect(text).toContain("Local copy");
  });

  /**
   * 같은 볼륨 이동(rename)은 총량을 미리 재지 않는다 — 그 스캔이 대용량 폴더에서
   * 확인 다이얼로그를 몇 초씩 붙잡던 원인. 미상(0)을 "0 B" 로 쓰면 빈 폴더로 읽힌다.
   */
  it("총량 미상(0)이면 크기를 표시하지 않는다", () => {
    render_(plan({ items: [ref("bigfolder")], total_size_bytes: 0 }));
    const text = document.body.textContent ?? "";
    expect(text).toContain("1 item(s)");
    expect(text).not.toContain("0 B");
  });

  it("충돌이 없으면 주 버튼이 바로 실행한다", () => {
    const { onConfirm } = render_(plan());
    expect(screen.queryByText(/already exist/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
    expect(onConfirm).toHaveBeenCalledWith("replace");
  });

  /**
   * 충돌 시 기본 정책은 건너뛰기 — 아무것도 덮어쓰거나 새로 만들지 않는 안전한 시작점.
   * 주 버튼은 사라지지 않고 고른 정책으로 실행한다.
   */
  it("충돌이 있으면 배지·경고를 보이고 기본은 건너뛰기", () => {
    const { onConfirm } = render_(
      plan({
        items: [ref("a.txt"), ref("b.txt")],
        conflicts: [conflict("a.txt")],
      }),
    );
    expect(screen.getByText(/1 item\(s\) with the same name/)).toBeDefined();
    expect(screen.getByText("Exists")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
    expect(onConfirm).toHaveBeenCalledWith("skip");
  });

  it("교체를 고르면 그 정책으로 실행하고 경고 문구가 바뀐다", () => {
    const { onConfirm } = render_(plan({ conflicts: [conflict("a.txt")] }));
    fireEvent.click(screen.getByRole("radio", { name: "Replace" }));
    expect(screen.getByText(/cannot be undone/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
    expect(onConfirm).toHaveBeenCalledWith("replace");
  });

  it("파일별 선택은 항목마다 정책을 모아 전달한다", () => {
    const { onConfirmPerFile } = render_(
      plan({
        items: [ref("a.txt"), ref("b.txt")],
        conflicts: [conflict("a.txt"), conflict("b.txt")],
      }),
    );
    fireEvent.click(screen.getByText(/Choose per file/));
    // 두 행 모두 기본 skip. 첫 행만 교체로.
    const replaceRadios = screen.getAllByRole("radio", { name: "Replace" });
    // [0] 은 "일괄 설정" 세그먼트, [1] 이 a.txt 행.
    fireEvent.click(replaceRadios[1]!);
    expect(screen.getByText(/Replace 1 · Skip 1/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
    expect(onConfirmPerFile).toHaveBeenCalledWith({
      "a.txt": "replace",
      "b.txt": "skip",
    });
  });
});
