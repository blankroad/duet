import { describe, it, expect } from "vitest";
import { formatKeyEvent } from "./keyEvent";

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
    expect(formatKeyEvent(mkEvent({ key: "f", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+F");
  });

  it("Alt+ArrowLeft", () => {
    expect(formatKeyEvent(mkEvent({ key: "ArrowLeft", altKey: true }))).toBe("Alt+Left");
  });

  it("F5 no modifier", () => {
    expect(formatKeyEvent(mkEvent({ key: "F5" }))).toBe("F5");
  });

  it("Ctrl+,", () => {
    expect(formatKeyEvent(mkEvent({ key: ",", ctrlKey: true }))).toBe("Ctrl+,");
  });

  it("modifier-only returns null", () => {
    expect(formatKeyEvent(mkEvent({ key: "Control", ctrlKey: true }))).toBeNull();
    expect(formatKeyEvent(mkEvent({ key: "Shift", shiftKey: true }))).toBeNull();
  });

  it("Ctrl+Tab", () => {
    expect(formatKeyEvent(mkEvent({ key: "Tab", ctrlKey: true }))).toBe("Ctrl+Tab");
  });

  it("Ctrl+Shift+Tab", () => {
    expect(formatKeyEvent(mkEvent({ key: "Tab", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+Tab");
  });
});
