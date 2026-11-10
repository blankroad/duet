/** Valid SSH alias collides with Object.prototype in the reconnect registry. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConnectionBanner } from "@/components/pane/ConnectionBanner";
import { useConnections } from "@/stores/connections";
import { usePanes } from "@/stores/panes";

vi.mock("@/types/bindings", () => ({ commands: { connectionClose: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

beforeEach(() => {
  useConnections.setState({ active: {}, hosts: [], reconnecting: {} });
});
afterEach(cleanup);

it.each(["constructor", "toString", "__proto__"])(
  "remote-NEW-3: disconnected %s alias must offer Reconnect",
  (alias) => {
    usePanes.getState().setEntries(
      "left",
      {
        source: {
          kind: "ssh",
          connection_id: `${alias}:old`,
          host_ip: "10.0.0.2",
          user: "u",
        },
        path: "/srv",
      },
      [],
    );
    render(<ConnectionBanner id="left" onReconnect={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "banner.reconnect" }),
    ).toBeTruthy();
  },
);
