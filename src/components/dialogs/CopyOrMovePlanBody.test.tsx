import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CopyStrategy, EntryRef } from "@/types/bindings";
import { CopyOrMovePlanBody } from "./CopyOrMovePlanBody";
import "@/i18n";

const LOCAL: CopyStrategy = { kind: "local_to_local" } as CopyStrategy;
const DST = "/Users/ctmctm/Documents";
const ref = (name: string): EntryRef =>
  ({ location: { source: { kind: "local" }, path: "/src" }, name }) as EntryRef;

describe("CopyOrMovePlanBody", () => {
  /**
   * 회귀 방지 — 원래 이 다이얼로그는 "1개, 40 KB → /경로" 만 보여줘서 어떤 파일을
   * 복사하는지 확인할 수 없었다. 개수는 파일명을 대신하지 못한다.
   */
  it("1개면 파일명을 그대로 보여준다", () => {
    render(
      <CopyOrMovePlanBody
        items={[ref("report-2026-final.pdf")]}
        totalSize={40960}
        dstPath={DST}
        conflicts={0}
        strategy={LOCAL}
      />,
    );

    const name = screen.getByText("report-2026-final.pdf");
    expect(name.getAttribute("title")).toBe("report-2026-final.pdf");
    // 파일명 요소에 경로가 섞이면 truncate 가 이름을 지운다.
    expect(name.textContent).not.toContain("/");
  });

  it("여러 개면 이름을 모두 목록으로 보여준다", () => {
    render(
      <CopyOrMovePlanBody
        items={[ref("a.txt"), ref("b.txt"), ref("c.txt")]}
        totalSize={1024}
        dstPath={DST}
        conflicts={0}
        strategy={LOCAL}
      />,
    );

    for (const n of ["a.txt", "b.txt", "c.txt"]) {
      expect(screen.getByText(n)).toBeDefined();
    }
  });

  it("목적지는 파일명과 분리된 줄에, 전체 경로는 tooltip", () => {
    render(
      <CopyOrMovePlanBody
        items={[ref("a.txt")]}
        totalSize={1024}
        dstPath={DST}
        conflicts={0}
        strategy={LOCAL}
      />,
    );

    const dst = screen.getByTitle(DST);
    expect(dst.textContent).toContain("Documents");
    expect(screen.getByText("a.txt")).not.toBe(dst);
  });

  it("개수·크기·전략은 보조 정보로 함께 표시", () => {
    const { container } = render(
      <CopyOrMovePlanBody
        items={[ref("a.txt"), ref("b.txt")]}
        totalSize={40960}
        dstPath={DST}
        conflicts={0}
        strategy={LOCAL}
      />,
    );

    // i18n 보간 + " · " 로 텍스트 노드가 쪼개지므로 전체 문자열로 확인.
    const text = container.textContent ?? "";
    expect(text).toContain("40 KB");
    expect(text).toContain("2 item(s)");
    expect(text).toContain("local");
  });

  /**
   * 같은 볼륨 이동(rename)은 총량을 미리 재지 않는다 — 그 스캔이 대용량 폴더에서
   * 확인 다이얼로그를 몇 초씩 붙잡던 원인. 미상(0)을 "0 B" 로 쓰면 빈 폴더로 읽힌다.
   */
  it("총량 미상(0)이면 크기를 표시하지 않는다", () => {
    const { container } = render(
      <CopyOrMovePlanBody
        items={[ref("bigfolder")]}
        totalSize={0}
        dstPath={DST}
        conflicts={0}
        strategy={LOCAL}
      />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("1 item(s)");
    expect(text).not.toContain("0 B");
  });

  it("충돌이 있으면 경고를 덧붙인다", () => {
    render(
      <CopyOrMovePlanBody
        items={[ref("a.txt")]}
        totalSize={10}
        dstPath={DST}
        conflicts={2}
        strategy={LOCAL}
      />,
    );

    expect(screen.getByText(/2 conflict/)).toBeDefined();
  });
});
