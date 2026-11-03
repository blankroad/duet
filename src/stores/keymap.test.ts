import { describe, expect, it, vi } from "vitest";
import { effectiveKey, resolveKeyCommand, shadowedBy } from "./keymap";

vi.mock("@/types/bindings", () => ({ commands: {} }));

const CMDS = [
  { id: "file.copy", defaultKey: "F5" },
  { id: "file.delete", defaultKey: "Delete" },
  { id: "filter.focus", defaultKey: "Ctrl+F", altKeys: ["/"] },
];

describe("키 규칙 — 표시와 실행이 같다", () => {
  it("다른 명령이 기본 키를 가져가면 원래 명령은 키 없음", () => {
    const b = [{ key: "F5", command_id: "file.delete" }];
    expect(effectiveKey("file.copy", b, "F5")).toBeUndefined();
    expect(resolveKeyCommand("F5", b, CMDS)).toBe("file.delete");
    expect(shadowedBy("file.copy", b, "F5")).toBe("file.delete");
  });

  it("사용자 지정이 있는 명령의 기본·보조 키는 꺼진다 (편집 = 교체)", () => {
    const b = [{ key: "Ctrl+K", command_id: "filter.focus" }];
    expect(effectiveKey("filter.focus", b, "Ctrl+F")).toBe("Ctrl+K");
    expect(resolveKeyCommand("Ctrl+F", b, CMDS)).toBeUndefined();
    expect(resolveKeyCommand("/", b, CMDS)).toBeUndefined();
    expect(resolveKeyCommand("Ctrl+K", b, CMDS)).toBe("filter.focus");
  });

  it("사용자 지정 없으면 기본·보조 키 그대로", () => {
    expect(effectiveKey("file.copy", [], "F5")).toBe("F5");
    expect(resolveKeyCommand("/", [], CMDS)).toBe("filter.focus");
    expect(shadowedBy("file.copy", [], "F5")).toBeUndefined();
  });
});
