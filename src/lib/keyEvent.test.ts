import { describe, it, expect } from "vitest";
import { formatKeyEvent, isImeComposing } from "./keyEvent";

function mkEvent(opts: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...opts,
  } as KeyboardEvent;
}

describe("formatKeyEvent", () => {
  it("plain letter", () => {
    expect(formatKeyEvent(mkEvent({ key: "a" }))).toBe("A");
  });

  it("Ctrl+T", () => {
    expect(formatKeyEvent(mkEvent({ key: "t", ctrlKey: true }))).toBe("Ctrl+T");
  });

  it("metaKey treated as Ctrl (cross-platform)", () => {
    expect(formatKeyEvent(mkEvent({ key: "t", metaKey: true }))).toBe("Ctrl+T");
  });

  it("Ctrl+Shift+F", () => {
    expect(
      formatKeyEvent(mkEvent({ key: "f", ctrlKey: true, shiftKey: true })),
    ).toBe("Ctrl+Shift+F");
  });

  it("Alt+ArrowLeft", () => {
    expect(formatKeyEvent(mkEvent({ key: "ArrowLeft", altKey: true }))).toBe(
      "Alt+Left",
    );
  });

  it("F5 no modifier", () => {
    expect(formatKeyEvent(mkEvent({ key: "F5" }))).toBe("F5");
  });

  it("Ctrl+,", () => {
    expect(formatKeyEvent(mkEvent({ key: ",", ctrlKey: true }))).toBe("Ctrl+,");
  });

  it("modifier-only returns null", () => {
    expect(
      formatKeyEvent(mkEvent({ key: "Control", ctrlKey: true })),
    ).toBeNull();
    expect(
      formatKeyEvent(mkEvent({ key: "Shift", shiftKey: true })),
    ).toBeNull();
  });

  it("Ctrl+Tab", () => {
    expect(formatKeyEvent(mkEvent({ key: "Tab", ctrlKey: true }))).toBe(
      "Ctrl+Tab",
    );
  });

  it("Ctrl+Shift+Tab", () => {
    expect(
      formatKeyEvent(mkEvent({ key: "Tab", ctrlKey: true, shiftKey: true })),
    ).toBe("Ctrl+Shift+Tab");
  });
});

describe("isImeComposing", () => {
  it("React 이벤트의 nativeEvent.isComposing", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true);
  });
  it("WebKit 조합 확정 Enter (keyCode 229)", () => {
    expect(
      isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 229 }),
    ).toBe(true);
  });
  it("네이티브 KeyboardEvent.isComposing", () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
  });
  it("일반 Enter 는 조합 아님", () => {
    expect(
      isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 13 }),
    ).toBe(false);
  });
});
