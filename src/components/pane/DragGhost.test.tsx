import { afterEach, beforeEach, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { DragGhost } from "./DragGhost";
import { useDragState } from "@/stores/dragState";
import i18n from "@/i18n";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  useDragState.getState().end();
});

it("shows whether dropping will copy or move", () => {
  render(<DragGhost />);
  const src = { source: { kind: "local" as const }, path: "/w" };
  act(() =>
    useDragState
      .getState()
      .start({ source: src, targets: [], label: "a.txt", x: 0, y: 0 }),
  );
  expect(screen.getByText("Copy")).toBeTruthy();
  act(() => useDragState.getState().end());
  act(() =>
    useDragState.getState().start({
      source: src,
      targets: [],
      label: "a.txt",
      mode: "move",
      x: 0,
      y: 0,
    }),
  );
  expect(screen.getByText("Move")).toBeTruthy();
});
