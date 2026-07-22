import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 셸 메뉴 예열/캐시의 수명 관리 검증. Tauri command 는 모킹(CLAUDE.md — 테스트는
 * 실제 OS/COM 을 건드리지 않음). Windows 전용 런타임은 macOS 에서 실행 못 하므로,
 * "언제 build/close 를 부르고 캐시를 재사용/무효화하는지" 로직만이라도 여기서 고정한다.
 */

const shellMenuOpen = vi.fn();
const shellMenuClose = vi.fn();
const shellMenuInvoke = vi.fn();

vi.mock("@/types/bindings", () => ({
  commands: {
    shellMenuOpen: (...a: unknown[]) => shellMenuOpen(...a),
    shellMenuClose: (...a: unknown[]) => shellMenuClose(...a),
    shellMenuInvoke: (...a: unknown[]) => shellMenuInvoke(...a),
  },
}));

const { openShellMenu } = await import("./shellMenu");
const {
  prewarmShellMenu,
  takeShellMenu,
  onShellMenuClosed,
  resetShellPrewarm,
} = await import("./shellPrewarm");

/** 마이크로태스크 큐를 비운다(closeShellSession/onShellMenuClosed 의 지연 확인). */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

/** shellMenuOpen 성공 응답(항목 1개 + 리프) 헬퍼. token 별로 구분. */
function okMenu(token: number) {
  return {
    status: "ok",
    data: {
      token,
      items: [
        {
          id: 101,
          label: "7-Zip",
          separator: false,
          disabled: false,
          children: [],
          icon: null,
        },
      ],
    },
  };
}

beforeEach(() => {
  shellMenuOpen.mockReset();
  shellMenuClose.mockReset();
  shellMenuInvoke.mockReset();
});

afterEach(async () => {
  resetShellPrewarm();
  await flush();
});

describe("shellPrewarm 예열/캐시", () => {
  it("커서 멈춤 시 미리 빌드하고, 같은 경로 우클릭은 재사용(재빌드 없음)", async () => {
    shellMenuOpen.mockResolvedValue(okMenu(1));

    prewarmShellMenu("C:/a/file.txt", "file");
    await flush();
    expect(shellMenuOpen).toHaveBeenCalledTimes(1);

    const s = await takeShellMenu("C:/a/file.txt", "file");
    expect(s?.token).toBe(1);
    expect(shellMenuOpen).toHaveBeenCalledTimes(1); // 재빌드 안 함
  });

  it("예열 안 된 경로 우클릭은 지금 빌드", async () => {
    shellMenuOpen.mockResolvedValue(okMenu(2));

    const s = await takeShellMenu("C:/b/x.txt", "file");
    expect(s?.token).toBe(2);
    expect(shellMenuOpen).toHaveBeenCalledTimes(1);
  });

  it("다른 경로로 커서가 옮겨가면 이전 세션을 close 로 정리", async () => {
    shellMenuOpen.mockResolvedValueOnce(okMenu(1)).mockResolvedValueOnce(okMenu(2));

    prewarmShellMenu("C:/a/1.txt", "file");
    await flush();
    prewarmShellMenu("C:/a/2.txt", "file");
    await flush();

    expect(shellMenuOpen).toHaveBeenCalledTimes(2);
    expect(shellMenuClose).toHaveBeenCalledWith(1); // 이전(token 1) 정리
    expect(shellMenuClose).not.toHaveBeenCalledWith(2);
  });

  it("메뉴를 선택 없이 닫으면 세션 유지 → 재우클릭 즉시(재빌드·close 없음)", async () => {
    shellMenuOpen.mockResolvedValue(okMenu(1));

    await takeShellMenu("C:/a/f.txt", "file");
    onShellMenuClosed();
    await flush();

    expect(shellMenuClose).not.toHaveBeenCalled();
    await takeShellMenu("C:/a/f.txt", "file");
    expect(shellMenuOpen).toHaveBeenCalledTimes(1); // 캐시 재사용
  });

  it("셸 항목 선택(invoke) 후 닫으면 캐시 무효화 → 다음 우클릭은 재빌드", async () => {
    shellMenuOpen.mockResolvedValueOnce(okMenu(1)).mockResolvedValueOnce(okMenu(9));

    const s = await takeShellMenu("C:/a/f.txt", "file");
    // 리프 onSelect = invoke (invokedTokens 에 token 기록).
    (s!.entries[0] as { onSelect: () => void }).onSelect();
    expect(shellMenuInvoke).toHaveBeenCalledWith(1, 101);

    onShellMenuClosed();
    await flush();

    // invoke 로 백엔드가 이미 파기 → close 재전송 안 함.
    expect(shellMenuClose).not.toHaveBeenCalled();
    // 캐시 무효 → 같은 경로라도 재빌드.
    const s2 = await takeShellMenu("C:/a/f.txt", "file");
    expect(s2?.token).toBe(9);
    expect(shellMenuOpen).toHaveBeenCalledTimes(2);
  });

  it("항목 없는 응답은 null(‘(none)’ 처리)", async () => {
    shellMenuOpen.mockResolvedValue({ status: "ok", data: { token: 5, items: [] } });
    const s = await openShellMenu("C:/a/empty", "file");
    expect(s).toBeNull();
  });
});
