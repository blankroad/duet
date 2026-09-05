import { describe, it, expect, afterEach } from "vitest";
import { formatSize, formatTime, setFormatOptions } from "./format";

afterEach(() => setFormatOptions("binary", "relative"));

describe("formatSize", () => {
  it("handles bytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  /**
   * 1024 로 나누면 라벨도 KiB 여야 한다 — 예전엔 값은 1024 진, 라벨은 KB 라
   * 파인더/탐색기 값과 어긋났다.
   */
  it("binary 는 1024 진 + KiB 라벨", () => {
    expect(formatSize(1024)).toBe("1.0 KiB");
    expect(formatSize(1500)).toBe("1.5 KiB");
    expect(formatSize(2 * 1024 * 1024)).toBe("2.0 MiB");
  });

  it("decimal 은 1000 진 + kB 라벨 (파인더와 같은 값)", () => {
    setFormatOptions("decimal", "relative");
    expect(formatSize(1000)).toBe("1.0 kB");
    expect(formatSize(2_000_000)).toBe("2.0 MB");
  });

  it("bytes 는 그대로", () => {
    setFormatOptions("bytes", "relative");
    expect(formatSize(1536)).toBe("1,536 B");
  });

  it("returns empty for null", () => {
    expect(formatSize(null)).toBe("");
  });
});

describe("formatTime", () => {
  const ts = new Date(2024, 5, 1, 14, 32).getTime();

  it("iso 는 날짜+시각", () => {
    setFormatOptions("binary", "iso");
    expect(formatTime(ts)).toBe("2024-06-01 14:32");
  });

  it("null 은 빈 문자열", () => {
    expect(formatTime(null)).toBe("");
  });
});
