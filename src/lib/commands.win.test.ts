import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));

const { buildBuiltins } = await import("./commands");

/** 모든 deps 를 no-op 으로 채운 프록시 — 커맨드 목록만 보면 되므로. */
const deps = new Proxy(
  { permanentDeleteEnabled: true },
  {
    get: (t, k) =>
      k in t ? (t as Record<string, unknown>)[k as string] : () => {},
  },
) as Parameters<typeof buildBuiltins>[0];

describe("commands — Windows/Linux 기본 키", () => {
  const cmds = buildBuiltins(deps);

  it("기본 키가 서로 겹치지 않는다", () => {
    const seen = new Map<string, string>();
    for (const c of cmds) {
      if (!c.defaultKey) continue;
      expect(
        seen.has(c.defaultKey),
        `${c.defaultKey}: ${seen.get(c.defaultKey)} vs ${c.id}`,
      ).toBe(false);
      seen.set(c.defaultKey, c.id);
    }
  });
});
