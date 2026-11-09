import { afterEach, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { NoticeBadge } from "./NoticeBadge";
import { useNotices } from "@/stores/notices";
import i18n from "@/i18n";

afterEach(() => {
  cleanup();
  useNotices.getState().clear();
});

function openBadge() {
  useNotices
    .getState()
    .add({ kind: "error", message: "x", detail: "raw error" });
  render(
    <>
      <button>Previous control</button>
      <NoticeBadge />
    </>,
  );
  const previous = screen.getByRole("button", { name: "Previous control" });
  previous.focus();
  fireEvent.click(screen.getByRole("button", { name: /1/ }));
  return { previous, panel: screen.getByRole("dialog") };
}

it("cycles Tab and Shift+Tab inside the panel including details summaries", () => {
  const { panel } = openBadge();
  const first = within(panel).getByRole("button", {
    name: i18n.t("notices.clear"),
  });
  const last = panel.querySelector("summary")!;
  fireEvent.keyDown(panel, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
});

it("handles Escape from window and restores the badge focus", () => {
  openBadge();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: i18n.t("notices.openRead") }),
  );
});

it("returns to the previous connected control after clearing and closes cleanly", () => {
  const { previous } = openBadge();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("notices.clear") }),
  );
  expect(document.activeElement).toBe(previous);
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => useNotices.getState().add({ kind: "error", message: "later" }));
  expect(useNotices.getState().unread).toBe(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});
