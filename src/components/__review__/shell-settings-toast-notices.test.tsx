/**
 * shell-settings 점검 (C-15) — 토스트 자동 소멸·알림 배지 재현 테스트.
 * 결함을 재현하는 것은 `it.fails` 로 표시한다(고치면 표시만 떼서 회귀 테스트로).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import i18n from "@/i18n";
import { Toast } from "@/components/Toast";
import { NoticeBadge } from "@/components/NoticeBadge";
import { useToast } from "@/stores/toast";
import { useNotices } from "@/stores/notices";
import { formatErr } from "@/lib/error";
import { showError } from "@/lib/errorToast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useToast.getState().clear();
  useNotices.getState().clear();
});

describe("C-15 toast auto-dismiss", () => {
  it("shell-settings-23: 마우스를 올려 읽는 중인 오류 토스트는 사라지지 않는다", () => {
    vi.useFakeTimers();
    render(<Toast />);
    act(() =>
      useToast.getState().show(`삭제 실패: ${"긴 설명 ".repeat(40)}`, "error"),
    );
    const card = screen.getByRole("alert").parentElement!;
    fireEvent.mouseEnter(card);
    fireEvent.pointerEnter(card);
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.queryByRole("alert")).not.toBeNull();
  });

  it("shell-settings-23: 키보드로 포커스해 스크롤하며 읽는 오류 토스트는 사라지지 않는다", () => {
    vi.useFakeTimers();
    render(<Toast />);
    act(() => useToast.getState().show("복사 실패: …", "error"));
    const body = screen.getByRole("alert");
    body.focus();
    expect(document.activeElement).toBe(body);
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.queryByRole("alert")).not.toBeNull();
  });

  it.fails(
    "shell-settings-24: 오류 4개가 떠 있어도 방금 한 작업의 성공 토스트는 보인다",
    () => {
      for (let i = 0; i < 4; i++)
        useToast.getState().show(`복사 실패 ${i}`, "error");
      useToast.getState().show("이름을 바꿨습니다", "success");
      // 현재: 상한 초과 시 '기록에 안 남는 것' 중 첫째 = 방금 넣은 성공 토스트 자신이 즉시 빠진다.
      expect(useToast.getState().toasts.map((t) => t.message)).toContain(
        "이름을 바꿨습니다",
      );
    },
  );

  it.fails(
    "shell-settings-improve: 같은 오류가 연달아 나면 알림 기록에 한 줄로 합쳐진다(개선)",
    () => {
      for (let i = 0; i < 10; i++)
        useToast.getState().show("서버에 연결할 수 없습니다", "error");
      // 현재: 화면 4개가 같은 문구로 꽉 차고, 기록에 10줄·배지 10.
      expect(useToast.getState().toasts).toHaveLength(1);
      expect(useNotices.getState().items).toHaveLength(1);
    },
  );
});

describe("C-15 notice badge", () => {
  it(
    "shell-settings-25: 기록이 50개로 꽉 찬 뒤엔 목록을 열어 둔 채 새 알림이 와도 읽음 처리되지 않는다",
    () => {
      act(() => {
        for (let i = 0; i < 50; i++)
          useNotices.getState().add({ kind: "error", message: `e${i}` });
      });
      render(<NoticeBadge />);
      fireEvent.click(screen.getByRole("button"));
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(useNotices.getState().unread).toBe(0);
      // 목록이 열려 있는 동안 새 오류 — 49개 이하일 땐 바로 읽음 처리된다.
      act(() =>
        useNotices.getState().add({ kind: "error", message: "new while open" }),
      );
      expect(useNotices.getState().unread).toBe(0);
    },
  );

  it("49개 이하일 땐 열어 둔 채 들어온 알림이 바로 읽음 처리된다(대조군)", () => {
    act(() => useNotices.getState().add({ kind: "error", message: "a" }));
    render(<NoticeBadge />);
    fireEvent.click(screen.getByRole("button"));
    act(() => useNotices.getState().add({ kind: "error", message: "b" }));
    expect(useNotices.getState().unread).toBe(0);
  });

  it(
    "shell-settings-25: 키보드로 '모두 지우기' 를 누르면 포커스가 body 로 떨어지지 않는다",
    () => {
      act(() => useNotices.getState().add({ kind: "error", message: "x" }));
      render(
        <>
          <button type="button">pane</button>
          <NoticeBadge />
        </>,
      );
      fireEvent.click(screen.getByRole("button", { name: /1/ }));
      const clear = screen.getByRole("button", {
        name: i18n.t("notices.clear"),
      });
      clear.focus();
      fireEvent.click(clear);
      // 배지 버튼이 언마운트돼 close() 의 buttonRef.focus() 가 헛돈다.
      expect(document.activeElement).not.toBe(document.body);
    },
  );

  it(
    "shell-settings-25: 목록 밖으로 Tab 해 나간 뒤 Esc 로 목록을 닫을 수 있다",
    () => {
      act(() => useNotices.getState().add({ kind: "error", message: "x" }));
      render(
        <>
          <button type="button">top bar</button>
          <NoticeBadge />
        </>,
      );
      fireEvent.click(screen.getByRole("button", { name: /1/ }));
      const outside = screen.getByRole("button", { name: "top bar" });
      outside.focus(); // Tab 으로 패널 밖에 나간 상태(포커스 트랩 없음)
      fireEvent.keyDown(outside, { key: "Escape" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );
});

describe("C-15 error text keeps which file failed", () => {
  const err = {
    kind: "PermissionDenied",
    message: "permission denied: /srv/data/분기보고서 2026.xlsx (os error 13)",
  };

  it(
    "shell-settings-04: formatErr 결과(토스트 문장)에 실패한 파일 이름이 남는다",
    () => {
      const text = formatErr(err);
      // 현재: "권한이 없습니다. 이 위치의 접근 권한을 확인하세요." — 파일명이 사라짐.
      expect(text).toContain("분기보고서 2026.xlsx");
    },
  );

  it("shell-settings-04: 오류 토스트(showError)는 알림 기록 '자세히' 에 원문이 남는다", () => {
    // 예전 호출부 형태 `show(t(..., {err: formatErr(e)}), "error")` 는 원문을 버렸다 —
    // 오류 토스트는 showError 헬퍼로 띄운다(G-16).
    showError("toast.deleteFailed", err);
    const [logged] = useNotices.getState().items;
    expect(logged!.detail).toContain("분기보고서 2026.xlsx");
  });
});
