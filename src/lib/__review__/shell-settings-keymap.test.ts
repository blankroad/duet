import { describe, expect, it, vi } from "vitest";
import { formatKeyEvent } from "../keyEvent";
import { resolveKeyCommand } from "@/stores/keymap";

vi.mock("@/types/bindings", () => ({ commands: {} }));

describe("shell-settings: 수동 keymap 및 국제 키보드", () => {
  const commands = [{ id: "tab.new", defaultKey: "Ctrl+T" }];

  it.fails("shell-settings-improve: 수동 소문자 바인딩도 키 입력과 매칭된다", () => {
    const event = new KeyboardEvent("keydown", {
      key: "t",
      code: "KeyT",
      ctrlKey: true,
    });
    const key = formatKeyEvent(event)!;
    expect(
      resolveKeyCommand(
        key,
        [{ key: "ctrl+t", command_id: "tab.new" }],
        commands,
      ),
    ).toBe("tab.new");
  });

  it.fails(
    "shell-settings-improve: Cmd 표기 수동 바인딩이 macOS meta 키와 매칭된다",
    () => {
      const event = new KeyboardEvent("keydown", {
        key: "t",
        code: "KeyT",
        metaKey: true,
      });
      const key = formatKeyEvent(event)!;
      expect(
        resolveKeyCommand(
          key,
          [{ key: "Cmd+T", command_id: "tab.new" }],
          commands,
        ),
      ).toBe("tab.new");
    },
  );

  it.fails(
    "shell-settings-29: AltGr+Digit2 문자 입력을 사용자 지정 Ctrl+Alt+2 정렬로 실행하지 않는다",
    () => {
      const event = new KeyboardEvent("keydown", {
        key: "@",
        code: "Digit2",
        ctrlKey: true,
        altKey: true,
      });
      Object.defineProperty(event, "getModifierState", {
        value: (name: string) => name === "AltGraph",
      });
      const key = formatKeyEvent(event);
      expect(
        key &&
          resolveKeyCommand(
            key,
            [{ key: "Ctrl+Alt+2", command_id: "sort.bySize" }],
            [{ id: "sort.bySize", defaultKey: "Ctrl+Shift+2" }],
          ),
      ).not.toBe("sort.bySize");
    },
  );
});
