import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Toast } from "./Toast";
import { useToast } from "@/stores/toast";
import { useNotices } from "@/stores/notices";

afterEach(() => {
  cleanup();
  useToast.getState().clear();
  useNotices.getState().clear();
  vi.useRealTimers();
});

it("resumes the remaining duration only after both hover and focus leave", () => {
  vi.useFakeTimers();
  useToast.getState().show("Read this", "error");
  render(
    <>
      <button>Outside</button>
      <Toast />
    </>,
  );
  act(() => vi.advanceTimersByTime(5000));
  const alert = screen.getByRole("alert");
  fireEvent.mouseEnter(alert);
  act(() => alert.focus());
  act(() => vi.advanceTimersByTime(20000));
  fireEvent.mouseLeave(alert);
  act(() => vi.advanceTimersByTime(20000));
  expect(screen.queryByRole("alert")).not.toBeNull();
  // Moving to the close button stays within the card.
  act(() => screen.getAllByRole("button")[1]!.focus());
  act(() => vi.advanceTimersByTime(20000));
  expect(screen.queryByRole("alert")).not.toBeNull();
  act(() => screen.getByRole("button", { name: "Outside" }).focus());
  act(() => vi.advanceTimersByTime(2999));
  expect(screen.queryByRole("alert")).not.toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("allows at least 1.5 seconds after a pause near the deadline", () => {
  vi.useFakeTimers();
  useToast.getState().show("Read this", "error");
  const id = useToast.getState().toasts[0]!.id;
  vi.advanceTimersByTime(7900);
  useToast.getState().pause(id);
  vi.advanceTimersByTime(20000);
  useToast.getState().resume(id);
  vi.advanceTimersByTime(1499);
  expect(useToast.getState().toasts).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(useToast.getState().toasts).toHaveLength(0);
});

it("cleans timers on eviction, dismiss and clear without changing the cap policy", () => {
  vi.useFakeTimers();
  for (let i = 0; i < 5; i++) useToast.getState().show(`Error ${i}`, "error");
  expect(vi.getTimerCount()).toBe(4);
  const id = useToast.getState().toasts[0]!.id;
  useToast.getState().pause(id);
  useToast.getState().dismiss(id);
  useToast.getState().resume(id);
  expect(vi.getTimerCount()).toBe(3);
  useToast.getState().show("Success", "success");
  useToast.getState().show("Another error", "error");
  expect(useToast.getState().toasts.map((t) => t.kind)).toEqual(
    Array(4).fill("error"),
  );
  expect(vi.getTimerCount()).toBe(4);
  useToast.getState().clear();
  expect(vi.getTimerCount()).toBe(0);
});
