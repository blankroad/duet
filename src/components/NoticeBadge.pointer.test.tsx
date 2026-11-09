import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NoticeBadge } from "./NoticeBadge";
import { useNotices } from "@/stores/notices";
import { releaseFocusAfterMouse } from "@/lib/keyIsolation";
import i18n from "@/i18n";

afterEach(() => {
  cleanup();
  useNotices.getState().clear();
});

function seed() {
  useNotices.getState().add({ kind: "error", message: "Failure" });
}

it("R2-2: remembers list focus before a Windows-style pointer click moves it to the badge", () => {
  seed();
  render(
    <>
      <div role="listbox" tabIndex={0} aria-label="Pane list" />
      <footer>
        <button type="button">Hidden files toggle</button>
        <NoticeBadge />
      </footer>
    </>,
  );
  const list = screen.getByRole("listbox");
  list.focus();
  const badge = screen.getByRole("button", { name: /1/ });
  fireEvent.pointerDown(badge, { button: 0 });
  badge.focus(); // WebView2 moves focus before click.
  fireEvent.click(badge, { detail: 1 });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("notices.clear") }),
    { detail: 1 },
  );
  expect(document.activeElement).toBe(list);
});

it("R2-2: pointer opening from body returns to a neutral container, not a nearby toggle", () => {
  seed();
  render(
    <footer data-testid="statusbar" onClick={releaseFocusAfterMouse}>
      <button type="button">Hidden files toggle</button>
      <NoticeBadge />
    </footer>,
  );
  expect(document.activeElement).toBe(document.body);
  const badge = screen.getByRole("button", { name: /1/ });
  fireEvent.pointerDown(badge, { button: 0 });
  badge.focus();
  fireEvent.click(badge, { detail: 1 });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("notices.clear") }),
    { detail: 1 },
  );
  expect(document.activeElement).toBe(screen.getByTestId("statusbar"));
  expect(document.activeElement).not.toBe(
    screen.getByRole("button", { name: "Hidden files toggle" }),
  );
});

it("R2-2: a badge excluded from the keyboard fallback list does not select the first control", () => {
  seed();
  render(
    <>
      <button type="button">Unrelated first control</button>
      <footer data-testid="statusbar">
        <NoticeBadge />
      </footer>
    </>,
  );
  const badge = screen.getByRole("button", { name: /1/ });
  badge.tabIndex = -1;
  badge.focus();
  fireEvent.click(badge, { detail: 0 });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("notices.clear") }),
  );
  expect(document.activeElement).not.toBe(
    screen.getByRole("button", { name: "Unrelated first control" }),
  );
  expect(document.activeElement).toBe(screen.getByTestId("statusbar"));
});
