// 팔레트 명령 file.extract / file.compress (Addendum A) — 기본 키 없음, File 분류,
// file.calcSize 바로 뒤, 두 언어 라벨, 실행 시 주입된 동작을 부른다.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));

const { buildBuiltins, commandLabel } = await import("./commands");
const i18n = (await import("@/i18n")).default;

const extract = vi.fn();
const compress = vi.fn();
const deps = new Proxy(
  { permanentDeleteEnabled: true, extract, compress },
  {
    get: (t, k) =>
      k in t ? (t as Record<string, unknown>)[k as string] : () => {},
  },
) as unknown as Parameters<typeof buildBuiltins>[0];

describe("palette: extract / compress", () => {
  const cmds = buildBuiltins(deps);
  const ids = cmds.map((c) => c.id);
  const byId = new Map(cmds.map((c) => [c.id, c]));

  beforeEach(() => {
    extract.mockReset();
    compress.mockReset();
  });

  it("sit right after file.calcSize, in File, with no default key", () => {
    const at = ids.indexOf("file.calcSize");
    expect(ids.slice(at + 1, at + 3)).toEqual([
      "file.extract",
      "file.compress",
    ]);
    for (const id of ["file.extract", "file.compress"]) {
      const c = byId.get(id)!;
      expect(c.category).toBe("File");
      expect(c.defaultKey).toBeUndefined();
      expect(c.altKeys ?? []).toEqual([]);
    }
  });

  it("run the injected actions", () => {
    byId.get("file.extract")!.action();
    byId.get("file.compress")!.action();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(compress).toHaveBeenCalledTimes(1);
  });

  it.each(["en", "ko"])("have translated labels (%s)", async (lng) => {
    await i18n.changeLanguage(lng);
    for (const id of ["file.extract", "file.compress"]) {
      expect(i18n.exists(`cmd.${id}`)).toBe(true);
      expect(commandLabel(byId.get(id)!, (k, o) => i18n.t(k, o))).toBe(
        i18n.t(`cmd.${id}`),
      );
    }
  });
});
