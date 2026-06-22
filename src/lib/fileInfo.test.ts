import { describe, it, expect } from "vitest";
import {
  kindLabel,
  formatPerms,
  formatFullDate,
  summarizeEntries,
  countLabel,
  splitNameExt,
} from "./fileInfo";
import type { Entry } from "@/types/bindings";

const mk = (
  name: string,
  kind: Entry["kind"] = "file",
  permissions: number | null = null,
): Entry =>
  ({
    name,
    kind,
    size: 0,
    modified_ms: null,
    permissions,
    hidden: false,
  }) as Entry;

const mkSized = (
  name: string,
  kind: Entry["kind"],
  size: number | null,
): Entry =>
  ({
    name,
    kind,
    size,
    modified_ms: null,
    permissions: null,
    hidden: false,
  }) as Entry;

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

  it("summarizeEntries counts kinds and sums file sizes only", () => {
    const entries = [
      mkSized("a.txt", "file", 100),
      mkSized("b.bin", "file", 250),
      mkSized("dir1", "dir", null),
      mkSized("link", "symlink", 0),
    ];
    const s = summarizeEntries(entries);
    expect(s.folders).toBe(1);
    expect(s.files).toBe(3); // file, file, symlink (비-dir 은 파일로 집계)
    expect(s.totalSize).toBe(350);
  });

  it("splitNameExt splits stem/ext, handles edge cases", () => {
    expect(splitNameExt("photo.jpg", false)).toEqual({
      stem: "photo",
      ext: "jpg",
    });
    expect(splitNameExt("a.tar.gz", false)).toEqual({
      stem: "a.tar",
      ext: "gz",
    });
    expect(splitNameExt(".bashrc", false)).toEqual({
      stem: ".bashrc",
      ext: "",
    });
    expect(splitNameExt("Makefile", false)).toEqual({
      stem: "Makefile",
      ext: "",
    });
    expect(splitNameExt("trailing.", false)).toEqual({
      stem: "trailing.",
      ext: "",
    });
    // 디렉토리는 분리 안 함(이름에 점 있어도).
    expect(splitNameExt("my.folder", true)).toEqual({
      stem: "my.folder",
      ext: "",
    });
  });

  it("countLabel pluralization and empty", () => {
    expect(countLabel(12, 3)).toBe("12 files, 3 folders");
    expect(countLabel(1, 0)).toBe("1 file");
    expect(countLabel(0, 1)).toBe("1 folder");
    expect(countLabel(0, 0)).toBe("empty");
  });
});
