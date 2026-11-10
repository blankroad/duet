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

describe("commands — F4 편집 (UX-SHL-07)", () => {
  it("file.edit 가 F4 로 등록되고 editFile 콜백을 부른다", () => {
    const editFile = vi.fn();
    const cmds = buildBuiltins(
      new Proxy(
        { permanentDeleteEnabled: true, editFile },
        {
          get: (t, k) =>
            k in t ? (t as Record<string, unknown>)[k as string] : () => {},
        },
      ) as Parameters<typeof buildBuiltins>[0],
    );
    const edit = cmds.find((c) => c.id === "file.edit");
    expect(edit?.defaultKey).toBe("F4");
    edit?.action();
    expect(editFile).toHaveBeenCalledTimes(1);
  });
});

describe("commands — DESIGN.md 보조 키 (fileops-03)", () => {
  it("F8·Shift+F8·Ctrl+Shift+N·Shift+F6 가 삭제·영구 삭제·새 폴더·이름 바꾸기", () => {
    const byId = new Map(buildBuiltins(deps).map((c) => [c.id, c]));
    expect(byId.get("file.delete")?.altKeys).toContain("F8");
    expect(byId.get("file.deletePerm")?.altKeys).toContain("Shift+F8");
    expect(byId.get("file.newFolder")?.altKeys).toContain("Ctrl+Shift+N");
    expect(byId.get("file.rename")?.altKeys).toContain("Shift+F6");
  });

  it("보조 키도 다른 명령의 기본·보조 키와 겹치지 않는다", () => {
    const seen = new Map<string, string>();
    for (const c of buildBuiltins(deps)) {
      for (const k of [c.defaultKey, ...(c.altKeys ?? [])]) {
        if (!k) continue;
        expect(seen.has(k), `${k}: ${seen.get(k)} vs ${c.id}`).toBe(false);
        seen.set(k, c.id);
      }
    }
  });
});
