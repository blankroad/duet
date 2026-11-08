/**
 * sync-compare 점검 (C-20) — ChecksumDialog 재현 테스트.
 * 결함 재현은 `it.fails` (기대 동작을 단언 → 현재 실패).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { EntryRef } from "@/types/bindings";
import { commands } from "@/types/bindings";
import i18n from "@/i18n";
import { ChecksumDialog } from "../ChecksumDialog";

vi.mock("@/types/bindings", () => ({
  commands: {
    fsChecksum: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.mocked(commands.fsChecksum).mockReset();
});

const loc = { source: { kind: "local" as const }, path: "/fixture/dir" };
const T = (name: string): EntryRef => ({ location: loc, name });

const HA = "a".repeat(63) + "1";
const HB = "b".repeat(63) + "2";

function okBy(map: Record<string, string>) {
  vi.mocked(commands.fsChecksum).mockImplementation(async (l) => {
    const name = String(l.path).split("/").pop() ?? "";
    const h = map[name];
    return h
      ? { status: "ok", data: h }
      : { status: "error", error: { kind: "Io", message: "boom" } as never };
  });
}

function verifyInput(): HTMLInputElement {
  return screen.getByPlaceholderText(
    i18n.t("dialog.checksum.verifyPlaceholder"),
  ) as HTMLInputElement;
}

const MATCH = () => i18n.t("dialog.checksum.match");
const MISMATCH = () => i18n.t("dialog.checksum.mismatch");

describe("sync-compare C-20 ChecksumDialog", () => {
  it("여러 파일은 순차 계산 — 앞 파일이 끝나기 전엔 다음 호출이 없다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(commands.fsChecksum).mockImplementation(async (l) => {
      if (String(l.path).endsWith("a.bin")) await gate;
      return { status: "ok", data: HA };
    });
    render(
      <ChecksumDialog targets={[T("a.bin"), T("b.bin")]} onClose={() => {}} />,
    );
    await waitFor(() => expect(commands.fsChecksum).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(commands.fsChecksum).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await waitFor(() => expect(commands.fsChecksum).toHaveBeenCalledTimes(2));
  });

  it("한 파일 실패가 나머지를 막지 않는다 (오류 행 + 다음 행 해시)", async () => {
    okBy({ "b.bin": HB });
    render(
      <ChecksumDialog
        targets={[T("bad.bin"), T("b.bin")]}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(HB)).toBeTruthy());
    expect(commands.fsChecksum).toHaveBeenCalledTimes(2);
  });

  it("닫으면(언마운트) 진행 중인 계산 뒤로 더 호출하지 않는다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(commands.fsChecksum).mockImplementation(async () => {
      await gate;
      return { status: "ok", data: HA };
    });
    const { unmount } = render(
      <ChecksumDialog targets={[T("a.bin"), T("b.bin")]} onClose={() => {}} />,
    );
    await waitFor(() => expect(commands.fsChecksum).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => release());
    await act(async () => {
      await Promise.resolve();
    });
    expect(commands.fsChecksum).toHaveBeenCalledTimes(1);
  });

  it("검증: 대문자 + 앞뒤 공백 붙여넣기도 일치로 본다", async () => {
    okBy({ "a.bin": HA });
    render(<ChecksumDialog targets={[T("a.bin")]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(HA)).toBeTruthy());
    fireEvent.change(verifyInput(), {
      target: { value: `  ${HA.toUpperCase()}\n` },
    });
    expect(screen.getByText(MATCH())).toBeTruthy();
  });

  it.fails(
    "sync-compare: sha256sum 형식('<hash>  <name>') 붙여넣기는 일치인데 불일치로 표시",
    async () => {
      okBy({ "a.bin": HA });
      render(<ChecksumDialog targets={[T("a.bin")]} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByText(HA)).toBeTruthy());
      // 다이얼로그 자신의 '복사' 버튼이 만드는 바로 그 형식.
      fireEvent.change(verifyInput(), { target: { value: `${HA}  a.bin` } });
      expect(screen.queryByText(MISMATCH())).toBeNull();
      expect(screen.getByText(MATCH())).toBeTruthy();
    },
  );

  it.fails(
    "sync-compare: 여러 줄 SHA256SUMS 붙여넣기 — 파일별로 맞춰 보지 않아 전부 불일치",
    async () => {
      okBy({ "a.bin": HA, "b.bin": HB });
      render(
        <ChecksumDialog
          targets={[T("a.bin"), T("b.bin")]}
          onClose={() => {}}
        />,
      );
      await waitFor(() => expect(screen.getByText(HB)).toBeTruthy());
      fireEvent.change(verifyInput(), {
        target: { value: `${HA}  a.bin\n${HB}  b.bin\n` },
      });
      expect(screen.getAllByText(MATCH())).toHaveLength(2);
    },
  );

  it("단일 기대 해시를 2개 파일에 붙이면 다른 파일은 '불일치' 로 표시 (현재 동작 기록)", async () => {
    okBy({ "a.bin": HA, "b.bin": HB });
    render(
      <ChecksumDialog targets={[T("a.bin"), T("b.bin")]} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText(HB)).toBeTruthy());
    fireEvent.change(verifyInput(), { target: { value: HA } });
    expect(screen.getAllByText(MATCH())).toHaveLength(1);
    expect(screen.getAllByText(MISMATCH())).toHaveLength(1);
  });

  it("행 복사는 sha256sum 형식 '<hash>  <name>'", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    okBy({ "a.bin": HA });
    render(<ChecksumDialog targets={[T("a.bin")]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(HA)).toBeTruthy());
    fireEvent.click(screen.getByTitle(i18n.t("dialog.checksum.copyRow")));
    expect(writeText).toHaveBeenCalledWith(`${HA}  a.bin`);
  });
});
