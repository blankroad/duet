import { describe, it, expect } from "vitest";
import { kindLabel, formatPerms, formatFullDate } from "./fileInfo";
import type { Entry } from "@/types/bindings";

const mk = (name: string, kind: Entry["kind"] = "file", permissions: number | null = null): Entry =>
  ({ name, kind, size: 0, modified_ms: null, permissions, hidden: false }) as Entry;

describe("fileInfo", () => {
  it("kindLabel by extension / kind", () => {
    expect(kindLabel(mk("a.pdf"))).toBe("PDF document");
    expect(kindLabel(mk("a.PNG"))).toBe("PNG image");
    expect(kindLabel(mk("a.xyz"))).toBe("XYZ file");
    expect(kindLabel(mk("noext"))).toBe("File");
    expect(kindLabel(mk("d", "dir"))).toBe("Folder");
    expect(kindLabel(mk("l", "symlink"))).toBe("Alias (symlink)");
  });

  it("formatPerms rwx + octal", () => {
    expect(formatPerms(0o644)).toBe("rw-r--r-- · 644");
    expect(formatPerms(0o755)).toBe("rwxr-xr-x · 755");
    expect(formatPerms(null)).toBe("—");
  });

  it("formatFullDate null → dash", () => {
    expect(formatFullDate(null)).toBe("—");
    // non-null produces a non-empty string (locale-dependent).
    expect(formatFullDate(0).length).toBeGreaterThan(0);
  });
});
