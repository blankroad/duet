import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PathBar } from "@/components/pane/PathBar";
import i18n from "@/i18n";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
// 경로 입력 해석은 백엔드(platform::parse_path_input, Rust 테스트로 검증)가 한다.
// 여기서는 PathBar 가 입력을 그 command 로 넘기고 **결과로** 이동하는지만 본다.
const parse = vi.hoisted(() => vi.fn());
vi.mock("@/types/bindings", async (orig) => {
  const real = await orig<typeof import("@/types/bindings")>();
  return { ...real, commands: { ...real.commands, pathParseInput: parse } };
});
afterEach(() => {
  cleanup();
  parse.mockReset();
});

it("browse-11 (F-sol-11): Explorer Copy as path quotes are removed (by the backend) before navigating", async () => {
  await i18n.changeLanguage("en");
  parse.mockResolvedValue({ status: "ok", data: "C:\\한글 폴더\\space name" });
  const navigate = vi.fn();
  render(
    <PathBar
      location={{ source: { kind: "local" }, path: "C:\\Users" }}
      canBack={false}
      canForward={false}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onSegmentClick={navigate}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit path" }));
  const input = screen.getByRole("textbox", { name: "Go to path" });
  fireEvent.change(input, {
    target: { value: '"C:\\한글 폴더\\space name"' },
  });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith("C:\\한글 폴더\\space name"),
  );
  expect(parse).toHaveBeenCalledWith('"C:\\한글 폴더\\space name"', true);
});

it("원격 패널의 경로 입력은 local=false 로 해석을 요청한다", async () => {
  await i18n.changeLanguage("en");
  parse.mockResolvedValue({ status: "ok", data: "/srv/a b" });
  const navigate = vi.fn();
  render(
    <PathBar
      location={{
        source: {
          kind: "ssh",
          connection_id: "c1",
          host_ip: "10.0.0.2",
          user: "u",
        },
        path: "/srv",
      }}
      canBack={false}
      canForward={false}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onSegmentClick={navigate}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit path" }));
  const input = screen.getByRole("textbox", { name: "Go to path" });
  fireEvent.change(input, { target: { value: '"/srv/a b"' } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/srv/a b"));
  expect(parse).toHaveBeenCalledWith('"/srv/a b"', false);
});
