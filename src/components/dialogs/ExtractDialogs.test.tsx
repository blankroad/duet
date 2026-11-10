// 압축 해제 다이얼로그 — 여기에 풀기 정책 선택, 각각 폴더로 풀기 충돌 선택.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import type { EntryRef, ExtractPlanItem } from "@/types/bindings";
import { ExtractHereDialog } from "./ExtractHereDialog";
import { ExtractConflictDialog } from "./ExtractConflictDialog";

const ref = (name: string): EntryRef => ({
  location: { source: { kind: "local" }, path: "/w" },
  name,
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

it("Extract here: lists the archives, defaults to Keep both", () => {
  const onConfirm = vi.fn();
  render(
    <ExtractHereDialog
      archives={[ref("a.zip"), ref("b.tar.gz")]}
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
  );
  expect(screen.getByText("a.zip")).toBeTruthy();
  expect(screen.getByText("b.tar.gz")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Extract/ }));
  expect(onConfirm).toHaveBeenCalledWith("keep_both");
});

it("Extract here: the chosen policy is passed on confirm", () => {
  const onConfirm = vi.fn();
  render(
    <ExtractHereDialog
      archives={[ref("a.zip")]}
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: /Replace/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Extract/ }));
  expect(onConfirm).toHaveBeenLastCalledWith("replace");
  fireEvent.click(screen.getByRole("radio", { name: /Skip/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Extract/ }));
  expect(onConfirm).toHaveBeenLastCalledWith("skip");
});

it("Extract here: Cancel does not confirm", () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ExtractHereDialog
      archives={[ref("a.zip")]}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
  expect(onCancel).toHaveBeenCalled();
  expect(onConfirm).not.toHaveBeenCalled();
});

it("Folder conflict: lists the taken names; each button calls only its handler", () => {
  const items: ExtractPlanItem[] = [
    {
      archive: ref("a.zip"),
      plan: {
        source: { kind: "local" },
        archive_dir: { source: { kind: "local" }, path: "/w" },
        archive_name: "a.zip",
        format: "zip",
        dest_dir: "/w/a",
        conflict: true,
        keep_both: false,
      },
      error: null,
    },
  ];
  const h = { replace: vi.fn(), keep: vi.fn(), cancel: vi.fn() };
  render(
    <ExtractConflictDialog
      items={items}
      onReplace={h.replace}
      onKeepBoth={h.keep}
      onCancel={h.cancel}
    />,
  );
  expect(screen.getByText("a")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
  expect(h.cancel).toHaveBeenCalledTimes(1);
  expect(h.replace).not.toHaveBeenCalled();
  expect(h.keep).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Keep both/ }));
  expect(h.keep).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /^Replace/ }));
  expect(h.replace).toHaveBeenCalledTimes(1);
});
