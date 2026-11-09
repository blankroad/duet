/**
 * remote review (lead) — 저장 호스트의 주소를 바꿔 다시 저장하면, vault 에 남은 옛 서버
 * 비밀번호가 같은 alias 로 새 주소에 전송된다.
 *
 * 지난 라운드는 "주소를 고친 그 접속" 에서만 저장 비번을 막았다. 고친 주소를 [호스트 저장]
 * 하면 saved-hosts 의 alias 레코드가 새 주소로 바뀌고 vault 항목(alias 키)은 그대로라,
 * 다음 접속부터는 savedEndpoint 비교가 통과해 옛 비번이 새 서버로 간다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AdHocConnectDialog } from "../AdHocConnectDialog";
import { useConnections } from "@/stores/connections";
import { useVault } from "@/stores/vault";
import { useSavedHosts } from "@/stores/savedHosts";
import type { SavedHost } from "@/types/bindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const m = vi.hoisted(() => ({
  connectionOpen: vi.fn(),
  connectionOpenAdhoc: vi.fn(),
  connectionClose: vi.fn(),
  vaultHas: vi.fn(),
  vaultStatus: vi.fn(),
  vaultSet: vi.fn(),
  vaultRemove: vi.fn(),
  savedHostsUpsert: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({ commands: m }));

const oldServer: SavedHost = {
  alias: "box",
  host: "box.lan",
  port: 22,
  user: "u",
  key_path: null,
};

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.connectionClose.mockResolvedValue({ status: "ok", data: null });
  // vault 에는 "box"(=box.lan) 의 비밀번호가 저장돼 있다.
  m.vaultHas.mockResolvedValue({ status: "ok", data: true });
  m.savedHostsUpsert.mockImplementation(async (h: SavedHost) => ({
    status: "ok",
    data: [h],
  }));
  useVault.setState({ exists: true, unlocked: true });
  useSavedHosts.setState({ hosts: [oldServer] });
  useConnections.setState({ active: {}, reconnecting: {}, hosts: [] });
});

describe("remote-lead: saved password follows the alias, not the endpoint", () => {
  it.fails(
    "remote-04: editing a saved host's address and saving must not keep the old server's password bound",
    async () => {
      // 1) 저장 호스트 box(box.lan) 를 열어 주소를 new.lan 으로 고치고 [호스트 저장] (키 인증 성공).
      m.connectionOpenAdhoc.mockResolvedValueOnce({
        status: "ok",
        data: {
          id: "u@new.lan:22:1",
          alias: "u@new.lan:22",
          host_ip: "10.0.0.9",
          user: "u",
        },
      });
      const first = render(
        <AdHocConnectDialog
          open
          onClose={vi.fn()}
          onConnected={vi.fn()}
          prefill={oldServer}
        />,
      );
      fireEvent.change(screen.getByLabelText("dialog.adhoc.host"), {
        target: { value: "new.lan" },
      });
      fireEvent.click(screen.getByRole("checkbox"));
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: /dialog.connection.connect/ }),
        );
      });
      // 이 접속 자체는 옛 비번을 보내지 않는다 (지난 라운드 수정 — 정상).
      expect(m.connectionOpenAdhoc).toHaveBeenLastCalledWith(
        expect.objectContaining({ host: "new.lan", savedPasswordAlias: null }),
      );
      // alias "box" 레코드가 새 주소로 덮어써진다. vault 의 "box" 항목은 손대지 않는다.
      expect(m.savedHostsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ alias: "box", host: "new.lan" }),
      );
      first.unmount();

      // 2) 다음에 저장 호스트 box(이제 new.lan) 로 접속 — 비번 입력 없이.
      m.connectionOpenAdhoc.mockResolvedValueOnce({
        status: "error",
        error: { kind: "AuthFailed" },
      });
      render(
        <AdHocConnectDialog
          open
          onClose={vi.fn()}
          onConnected={vi.fn()}
          prefill={{ ...oldServer, host: "new.lan" }}
        />,
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: /dialog.connection.connect/ }),
        );
      });
      // 기대: box.lan 용으로 저장한 비번이 new.lan 으로 가면 안 된다.
      // 실제: savedPasswordAlias "box" 가 전송돼 backend 가 box.lan 의 비번을 new.lan 에 보낸다.
      expect(m.connectionOpenAdhoc).toHaveBeenLastCalledWith(
        expect.objectContaining({ host: "new.lan", savedPasswordAlias: null }),
      );
    },
  );
});
