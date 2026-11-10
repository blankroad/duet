// 암호 프롬프트 대기열을 실제로 그려서 — 아카이브 A 의 입력·오류·진행 상태가 다음
// 아카이브 B 의 창으로 넘어가지 않고, 취소 뒤 늦게 끝난 A 의 제출이 B 를 닫지 않는다.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ExtractPlan } from "@/types/bindings";

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/types/bindings", () => ({
  commands: new Proxy(
    { fsExtractExecute: h.execute } as Record<string, unknown>,
    {
      get: (target, key) =>
        target[String(key)] ??
        (() => Promise.resolve({ status: "ok", data: null })),
    },
  ),
}));

import i18n from "@/i18n";
import { useUIDialogs } from "@/stores/ui-dialogs";
import {
  requestExtractPassword,
  resetExtractPendingForTest,
} from "@/lib/extractPending";
import { ExtractPasswordPrompt } from "./ExtractPasswordPrompt";

/** App 의 extract-password 블록과 같은 렌더 — 프롬프트 id 를 key 로. */
function Host() {
  const d = useUIDialogs((s) => s.dialog);
  return d.kind === "extract-password" ? (
    <ExtractPasswordPrompt key={d.promptId} prompt={d} />
  ) : null;
}

/** 같은 이름의 아카이브 둘 — 폴더만 다르다. */
function plan(dir: string): ExtractPlan {
  return {
    source: { kind: "local" },
    archive_dir: { source: { kind: "local" }, path: dir },
    archive_name: "same.zip",
    format: "zip",
    dest_dir: `${dir}/same`,
    conflict: false,
    keep_both: true,
  };
}

const current = () => {
  const d = useUIDialogs.getState().dialog;
  return d.kind === "extract-password" ? d : null;
};
const input = () =>
  screen.getByPlaceholderText(
    i18n.t("dialog.passwordPrompt.placeholder"),
  ) as HTMLInputElement;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  h.execute.mockReset();
  resetExtractPendingForTest();
  useUIDialogs.setState({
    dialog: { kind: "none" },
    queue: [],
    fromQueue: false,
  });
});
afterEach(cleanup);

it("cancel on A shows B fresh: empty input, no wrong-password state, new prompt id", () => {
  // A 는 틀린 암호로 다시 묻는 중, B 는 처음.
  requestExtractPassword({
    retry: { kind: "folder", plan: plan("/a") },
    wrong: true,
  });
  requestExtractPassword({
    retry: { kind: "folder", plan: plan("/b") },
    wrong: false,
  });
  render(<Host />);
  const a = current()!;
  expect(screen.getByText(i18n.t("dialog.passwordPrompt.wrong"))).toBeTruthy();
  fireEvent.change(input(), { target: { value: "secret-for-A" } });

  fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));

  const b = current()!;
  expect(b.promptId).not.toBe(a.promptId);
  expect(b.retry.kind === "folder" && b.retry.plan.archive_dir.path).toBe("/b");
  expect(input().value).toBe("");
  expect(screen.queryByText(i18n.t("dialog.passwordPrompt.wrong"))).toBeNull();
  expect(h.execute).not.toHaveBeenCalled();
});

it("A's submit finishing after A was cancelled does not close or answer B", async () => {
  let finish: (v: unknown) => void = () => {};
  h.execute.mockReturnValue(new Promise((r) => (finish = r)));
  requestExtractPassword({
    retry: { kind: "folder", plan: plan("/a") },
    wrong: false,
  });
  requestExtractPassword({
    retry: { kind: "folder", plan: plan("/b") },
    wrong: false,
  });
  render(<Host />);
  fireEvent.change(input(), { target: { value: "pw-A" } });
  fireEvent.click(screen.getByRole("button", { name: /Continue|…/ }));
  // A 의 재시도가 아직 끝나지 않은 사이에 A 를 취소 → B.
  fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
  const b = current()!;
  expect(b.retry.kind === "folder" && b.retry.plan.archive_dir.path).toBe("/b");

  await act(async () => {
    finish({ status: "ok", data: "task-A" });
  });
  await waitFor(() => expect(h.execute).toHaveBeenCalledTimes(1));
  // A 의 암호는 A 의 계획으로만 갔다. B 는 그대로 떠 있고 비어 있다.
  expect(h.execute).toHaveBeenCalledWith(plan("/a"), "pw-A");
  expect(current()?.promptId).toBe(b.promptId);
  expect(input().value).toBe("");
});
