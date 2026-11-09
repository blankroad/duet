/**
 * shell-settings 점검 (C-08 사이드바 필터 · C-11 명령 팔레트) 재현 테스트.
 * 결함을 재현하는 것은 `it.fails` 로 표시한다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SidebarFilter, SIDEBAR_ROW } from "@/components/SidebarFilter";
import { useSidebarFilter, matchesQuery } from "@/stores/sidebarFilter";
import { fuzzyScore } from "@/lib/fuzzy";

afterEach(() => {
  cleanup();
  useSidebarFilter.getState().clear();
});

function renderFilterWithRow(onOpen: () => void) {
  render(
    <div data-sidebar="">
      <SidebarFilter />
      <div {...{ [SIDEBAR_ROW]: "" }} tabIndex={-1} onClick={onOpen}>
        문서
      </div>
    </div>,
  );
  return screen.getByRole("textbox");
}

describe("C-08 sidebar filter + IME", () => {
  it("shell-settings-05: 한글 조합을 끝내려고 누른 Enter 로 첫 결과가 열리지 않는다", () => {
    const onOpen = vi.fn();
    const input = renderFilterWithRow(onOpen);
    fireEvent.change(input, { target: { value: "문" } });
    // 조합 중 Enter (Chromium/WebView2: isComposing=true, keyCode 229)
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shell-settings-05: 한글 조합 중 Esc 는 조합 취소 — 입력한 필터 전체를 지우지 않는다", () => {
    const input = renderFilterWithRow(vi.fn());
    fireEvent.change(input, { target: { value: "프로젝트 문" } });
    fireEvent.keyDown(input, {
      key: "Escape",
      keyCode: 229,
      isComposing: true,
    });
    expect(useSidebarFilter.getState().q).toBe("프로젝트 문");
  });

  it("조합이 끝난 Enter 는 첫 결과를 연다(대조군)", () => {
    const onOpen = vi.fn();
    const input = renderFilterWithRow(onOpen);
    fireEvent.change(input, { target: { value: "문서" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("C-08/C-11 Korean names in NFD (macOS 파일 이름)", () => {
  const nfdName = "회의록".normalize("NFD");

  it.fails(
    "shell-settings-21: 사이드바 필터가 NFD 이름(macOS 폴더명으로 만든 북마크)을 NFC 입력으로 찾는다",
    () => {
      expect(matchesQuery(nfdName, "회의")).toBe(true);
    },
  );

  it.fails(
    "shell-settings-21: 명령 팔레트가 NFD 북마크 이름을 NFC 입력으로 찾는다",
    () => {
      expect(fuzzyScore("회의", `Bookmark: ${nfdName}`)).not.toBeNull();
    },
  );
});
