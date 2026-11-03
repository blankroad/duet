import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@/i18n";
import { SudoPasswordDialog } from "./SudoPasswordDialog";
import { MasterPasswordDialog } from "./MasterPasswordDialog";

vi.mock("@/stores/vault", () => ({ vaultUnlock: vi.fn() }));

afterEach(cleanup);

describe("암호 대화상자 Enter 동작", () => {
  it("sudo: 빈 비밀번호는 제출되지 않는다", () => {
    const onConfirm = vi.fn();
    render(
      <SudoPasswordDialog
        dest="/fixture"
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    const input = document.querySelector("input[type=password]")!;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "pw" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("pw");
  });

  it("마스터 비밀번호 만들기: 첫 칸 Enter 는 확인 칸으로 (불일치 오류 없이)", () => {
    render(
      <MasterPasswordDialog
        open
        mode="create"
        onClose={() => {}}
        onUnlocked={() => {}}
      />,
    );
    const [first, confirm] = Array.from(
      document.querySelectorAll("input[type=password]"),
    );
    fireEvent.change(first!, { target: { value: "longenough" } });
    fireEvent.keyDown(first!, { key: "Enter" });
    expect(document.activeElement).toBe(confirm);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toMatch(/match/i);
  });
});
