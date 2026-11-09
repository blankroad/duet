import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NoticeBadge } from "./NoticeBadge";
import { useNotices } from "@/stores/notices";
import i18n from "@/i18n";

afterEach(() => {
  cleanup();
  useNotices.getState().clear();
});

function seed() {
  useNotices.getState().add({ kind: "error", message: "Failure" });
}

function openBadge() {
  seed();
  render(<NoticeBadge />);
  fireEvent.click(screen.getByRole("button"));
}

const modalTypes = ["dialog", "aria-modal"] as const;

function renderOtherModal(type: (typeof modalTypes)[number]) {
  render(
    <div
      role={type === "dialog" ? "dialog" : undefined}
      aria-modal={type === "aria-modal" ? "true" : undefined}
    >
      <input aria-label="Other modal input" />
    </div>,
  );
  const input = screen.getByRole("textbox");
  input.focus();
  return input;
}

it.each(modalTypes)("R2-1: Tab stays with another %s", (type) => {
  openBadge();
  const input = renderOtherModal(type);
  expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(input);
  expect(fireEvent.keyDown(input, { key: "Tab", shiftKey: true })).toBe(true);
  expect(document.activeElement).toBe(input);
});

it.each(modalTypes)("R2-1: Escape reaches another %s handler", (type) => {
  openBadge();
  const input = renderOtherModal(type);
  const onEscape = vi.fn((event: KeyboardEvent) => {
    if (event.key === "Escape") event.preventDefault();
  });
  document.addEventListener("keydown", onEscape, true);
  try {
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(input);
    expect(
      screen.getByRole("dialog", { name: i18n.t("notices.title") }),
    ).toBeTruthy();
  } finally {
    document.removeEventListener("keydown", onEscape, true);
  }
});
