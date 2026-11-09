import { describe, it, expect, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { ConnectErrorBox } from "./ConnectErrorBox";

describe("ConnectErrorBox", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("ko");
  });

  it("shows a readable title instead of the raw error kind", () => {
    render(<ConnectErrorBox error={{ kind: "AuthFailed" }} authHint="hint" />);
    expect(screen.getByRole("alert").textContent).toContain("인증 실패");
    expect(screen.getByRole("alert").textContent).not.toContain("AuthFailed");
    expect(screen.getByText("hint")).toBeTruthy();
  });

  it("puts the backend detail under the title, without the kind label", () => {
    render(
      <ConnectErrorBox
        error={{ kind: "ConnectionFailed", message: "connection refused" }}
        authHint="hint"
      />,
    );
    const box = screen.getByRole("alert");
    expect(box.textContent).toContain("서버에 연결할 수 없습니다");
    expect(box.textContent).toContain("connection refused");
    expect(screen.queryByText("hint")).toBeNull();
  });

  it("remote-26: shows a sentence instead of the OS error number, keeping the original in the tooltip", () => {
    const raw = "tcp connect 10.0.0.1:22: Connection refused (os error 61)";
    render(
      <ConnectErrorBox
        error={{ kind: "ConnectionFailed", message: raw }}
        authHint="hint"
      />,
    );
    const box = screen.getByRole("alert");
    expect(box.textContent).not.toContain("os error 61");
    expect(box.querySelector("[title]")?.getAttribute("title")).toBe(raw);
  });

  it("falls back to a generic title for kinds without one", () => {
    render(<ConnectErrorBox error={{ kind: "Cancelled" }} authHint="hint" />);
    expect(screen.getByRole("alert").textContent).toContain(
      "연결하지 못했습니다",
    );
  });
});
