import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import i18n from "@/i18n";
import { NoticeBadge } from "./NoticeBadge";
import { useNotices } from "@/stores/notices";
import { useToast } from "@/stores/toast";
import { describeArchiveNotice } from "@/hooks/useArchiveNoticeEvents";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useToast.getState().clear();
  useNotices.getState().clear();
});

describe("toast → notice log", () => {
  it("error toasts disappear on their own but stay in the log with detail", () => {
    vi.useFakeTimers();
    useToast.getState().show("Extract failed — link", "error", {
      detail: "raw (os error 1314)",
    });
    useToast.getState().show("Copied", "success");
    expect(useToast.getState().toasts).toHaveLength(2);
    const [logged] = useNotices.getState().items;
    expect(logged).toMatchObject({
      kind: "error",
      message: "Extract failed — link",
      detail: "raw (os error 1314)",
    });
    // 정보·성공은 기록하지 않는다.
    expect(useNotices.getState().items).toHaveLength(1);
    act(() => vi.advanceTimersByTime(3000));
    expect(useToast.getState().toasts.map((t) => t.kind)).toEqual(["error"]);
    act(() => vi.advanceTimersByTime(5000));
    expect(useToast.getState().toasts).toHaveLength(0);
    expect(useNotices.getState().unread).toBe(1);
  });

  it("keeps only the newest 50 notices", () => {
    for (let i = 0; i < 60; i++)
      useNotices.getState().add({ kind: "error", message: `e${i}` });
    const { items, unread } = useNotices.getState();
    expect(items).toHaveLength(50);
    expect(items[0]!.message).toBe("e59");
    expect(unread).toBe(50);
  });
});

describe("NoticeBadge", () => {
  it("renders nothing without notices", () => {
    const { container } = render(<NoticeBadge />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the unread count, opens the list, marks read, and shows details", () => {
    act(() => {
      useNotices
        .getState()
        .add({ kind: "warning", message: "Renamed 2 names" });
      useNotices
        .getState()
        .add({ kind: "error", message: "Extract failed", detail: "raw cause" });
    });
    render(<NoticeBadge />);
    const button = screen.getByRole("button", {
      name: i18n.t("notices.openUnread", { count: 2 }),
    });
    expect(button.textContent).toBe("2");
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", {
      name: i18n.t("notices.title"),
    });
    expect(useNotices.getState().unread).toBe(0);
    const rows = dialog.querySelectorAll("li");
    expect(rows[0]!.textContent).toContain("Extract failed");
    expect(rows[1]!.textContent).toContain("Renamed 2 names");
    // 원문은 "자세히" 안에.
    expect(rows[0]!.querySelector("details pre")?.textContent).toBe(
      "raw cause",
    );
    expect(rows[1]!.querySelector("details")).toBeNull();
    // Esc 로 닫고, 다 읽은 배지는 개수 없이 남는다.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: i18n.t("notices.openRead") })
        .textContent,
    ).toBe("");
  });

  it("clear all empties the log and hides the badge", () => {
    act(() => useNotices.getState().add({ kind: "error", message: "x" }));
    render(<NoticeBadge />);
    fireEvent.click(screen.getByRole("button", { name: /1/ }));
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("notices.clear") }),
    );
    expect(useNotices.getState().items).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("clicking outside closes the list", () => {
    act(() => useNotices.getState().add({ kind: "error", message: "x" }));
    render(<NoticeBadge />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("archive notice text", () => {
  it("summarises skipped links and renamed names, listing them in detail", () => {
    const { message, detail } = describeArchiveNotice({
      archive_name: "src.tar.gz",
      skipped_links: ["lib/a.so"],
      skipped_links_count: 3,
      renamed: ["logs/10:00.txt"],
      renamed_count: 1,
    });
    expect(message).toContain("src.tar.gz");
    expect(message).toContain("3 links");
    expect(message).toContain("1 name");
    expect(detail).toContain("lib/a.so");
    expect(detail).toContain(i18n.t("notices.more", { count: 2 }));
    expect(detail).toContain("logs/10:00.txt");
  });
});
