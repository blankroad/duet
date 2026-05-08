import { describe, it, expect } from "vitest";
import { formatSize } from "./format";

describe("formatSize", () => {
  it("handles bytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
  });
  it("handles kilobytes with one decimal under 10", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1500)).toBe("1.5 KB");
  });
  it("handles megabytes", () => {
    expect(formatSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
  it("returns empty for null", () => {
    expect(formatSize(null)).toBe("");
  });
});
