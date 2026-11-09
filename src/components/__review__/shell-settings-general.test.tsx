/**
 * shell-settings 점검 (C-09 설정 일반 탭) 재현 테스트.
 * 결함을 재현하는 것은 `it.fails` 로 표시한다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
const cmd = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({ commands: cmd }));

import i18n from "@/i18n";
import { GeneralSection } from "@/components/settings/GeneralSection";

afterEach(cleanup);

describe("C-09 editor command input", () => {
  it.fails(
    "shell-settings-26: 편집기 명령 입력칸 — 저장(IPC)이 끝나기 전에 친 글자가 사라지지 않는다",
    async () => {
      cmd.settingsGet.mockResolvedValue({
        status: "ok",
        data: { editor_command: "" },
      });
      // 저장이 바로 끝나지 않는 상황(디스크 느림·다른 쓰기와 경쟁).
      let release!: () => void;
      cmd.settingsSet.mockImplementation(
        (patch: { editor_command: string }) =>
          new Promise((res) => {
            release = () =>
              res({
                status: "ok",
                data: { editor_command: patch.editor_command },
              });
          }),
      );
      render(<GeneralSection />);
      const input = (await screen.findByPlaceholderText(
        i18n.t("settings.editorPlaceholder"),
      )) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "c" } });
      // 현재: 제어 입력의 값은 저장 응답이 와야 바뀌어서 그 사이 "" 로 되돌아간다 →
      // 다음 키는 "" 위에 쳐져 앞 글자가 빠진다(그리고 저장 요청이 글자마다 경쟁).
      expect(input.value).toBe("c");
      await act(async () => release());
    },
  );
});
