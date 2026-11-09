import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SymlinkDialog } from "./SymlinkDialog";
import i18n from "@/i18n";

// 대상 경로 정리(따옴표 등)는 백엔드 platform::parse_path_input — 여기서는 대화상자가
// 대상 칸을 그 command 로 넘기고 결과를 쓰는지만 본다 (G-24, browse 넘김).
const parse = vi.hoisted(() => vi.fn());
vi.mock("@/types/bindings", async (orig) => {
  const real = await orig<typeof import("@/types/bindings")>();
  return { ...real, commands: { ...real.commands, pathParseInput: parse } };
});
afterEach(() => {
  cleanup();
  parse.mockReset();
});

it("붙여 넣은 따옴표 대상 경로는 백엔드가 정리한 값으로 만든다", async () => {
  await i18n.changeLanguage("en");
  parse.mockResolvedValue({ status: "ok", data: "C:\\a b\\target" });
  const onSubmit = vi.fn();
  render(
    <SymlinkDialog
      parent={{ source: { kind: "local" }, path: "C:\\work" }}
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
  const [name, target] = screen.getAllByRole("textbox");
  fireEvent.change(name!, { target: { value: " link " } });
  fireEvent.change(target!, { target: { value: '"C:\\a b\\target"' } });
  fireEvent.keyDown(target!, { key: "Enter" });
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith("link", "C:\\a b\\target"),
  );
  expect(parse).toHaveBeenCalledWith('"C:\\a b\\target"', true);
});
