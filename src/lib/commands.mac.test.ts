import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

const { buildBuiltins } = await import("./commands");

/** 모든 deps 를 no-op 으로 채운 프록시 — 커맨드 목록만 보면 되므로. */
const deps = new Proxy(
  { permanentDeleteEnabled: true },
  {
    get: (t, k) =>
      k in t ? (t as Record<string, unknown>)[k as string] : () => {},
  },
) as Parameters<typeof buildBuiltins>[0];

describe("commands — macOS 기본 키", () => {
  const cmds = buildBuiltins(deps);
  const byId = new Map(cmds.map((c) => [c.id, c]));

  /**
   * 맥에서 ⇧⌘3/4/5 는 OS 스크린샷이라 앱까지 오지 않았다 — 정렬 3종이 키보드로
   * 불가능했다. 이 테스트는 그 자리로 되돌아가는 것을 막는다.
   */
  it("정렬은 OS 스크린샷 키(Ctrl+Shift+3..5)를 쓰지 않는다", () => {
    for (const id of ["sort.byMtime", "sort.byKind", "sort.byExt"]) {
      expect(byId.get(id)?.defaultKey).not.toMatch(/^Ctrl\+Shift\+[345]$/);
    }
  });

  it("숨김 토글은 파인더와 같은 ⇧⌘. 로", () => {
    expect(byId.get("view.toggleHidden")?.defaultKey).toBe("Ctrl+Shift+.");
  });

  it("미리보기 토글이 F11(데스크탑 보기)이 아니다", () => {
    expect(byId.get("view.togglePreview")?.defaultKey).not.toBe("F11");
  });

  it("경로 입력에 파인더식 ⇧⌘G 가 추가된다", () => {
    expect(byId.get("pane.editPath")?.altKeys).toContain("Ctrl+Shift+G");
  });

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
