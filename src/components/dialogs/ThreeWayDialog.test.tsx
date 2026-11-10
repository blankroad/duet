import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ThreeWayPlan } from "@/types/bindings";
import "@/i18n";
import { ThreeWayDialog } from "./ThreeWayDialog";

afterEach(cleanup);

const loc = (path: string) => ({ source: { kind: "local" as const }, path });

// SC-05: 한쪽에서 읽지 못한 폴더는 "읽지 못함" 충돌 행 — 적용 수(auto)에 들지 않는다.
const plan: ThreeWayPlan = {
  base: loc("/fixture/B"),
  left: loc("/fixture/L"),
  right: loc("/fixture/R"),
  entries: [
    { rel: "only_l", kind: "dir", status: "left_added" },
    { rel: "sub", kind: "dir", status: "unreadable" },
  ],
  auto: 1,
  conflicts: 1,
  truncated: false,
};

describe("ThreeWayDialog unreadable rows (SC-05)", () => {
  it("labels the unreadable folder and keeps it out of Apply", () => {
    render(
      <ThreeWayDialog plan={plan} onClose={() => {}} onApply={() => {}} />,
    );
    expect(screen.getByText("Unreadable — skipped")).toBeTruthy();
    expect(screen.getByText("sub/")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Apply auto-resolved \(1\)/ }),
    ).toBeTruthy();
  });

  it("shows the unreadable folder under 'Conflicts only'", () => {
    render(
      <ThreeWayDialog plan={plan} onClose={() => {}} onApply={() => {}} />,
    );
    fireEvent.click(screen.getByLabelText("Conflicts only"));
    expect(screen.getByText("sub/")).toBeTruthy();
    expect(screen.queryByText("only_l/")).toBeNull();
  });
});
