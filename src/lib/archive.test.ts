import { describe, it, expect } from "vitest";
import {
  canExtractArchive,
  canRepackArchive,
  repackBrowseRoot,
} from "./archive";
import type { ArchiveBrowse } from "@/stores/panes";
import type { Location, SourceId } from "@/types/bindings";

const local: SourceId = { kind: "local" };
const ssh: SourceId = {
  kind: "ssh",
  connection_id: "c1",
  host_ip: "10.0.0.1",
  user: "u",
};

describe("canExtractArchive", () => {
  it("local: every supported format, case-insensitive", () => {
    for (const n of [
      "a.zip",
      "a.tar",
      "a.tar.gz",
      "a.TGZ",
      "a.tar.bz2",
      "a.tbz2",
      "a.tar.xz",
      "a.txz",
      "a.tar.zst",
      "a.7z",
      "A.RAR",
      "log.txt.gz",
      "log.bz2",
      "log.xz",
      "log.zst",
    ])
      expect(canExtractArchive(n, local), n).toBe(true);
    expect(canExtractArchive("notes.txt", local)).toBe(false);
    expect(canExtractArchive("noext", local)).toBe(false);
  });

  it("remote: only the zip/tar family (server unzip/tar)", () => {
    for (const n of [
      "a.zip",
      "a.tar",
      "a.tar.gz",
      "a.tgz",
      "a.tar.bz2",
      "a.tar.xz",
      "a.tar.zst",
    ])
      expect(canExtractArchive(n, ssh), n).toBe(true);
    for (const n of ["a.7z", "a.rar", "log.txt.gz", "log.bz2", "log.xz"])
      expect(canExtractArchive(n, ssh), n).toBe(false);
  });
});

describe("canRepackArchive", () => {
  it(".zip / .tar.gz only", () => {
    for (const n of ["a.zip", "a.tar.gz", "a.TGZ"])
      expect(canRepackArchive(n), n).toBe(true);
    for (const n of ["a.tar", "a.tar.xz", "a.7z", "a.rar", "log.txt.gz", "x"])
      expect(canRepackArchive(n), n).toBe(false);
  });
});

describe("repackBrowseRoot", () => {
  it.each<[SourceId, string, string]>([
    [
      local,
      "/tmp/duet-archive/token/content",
      "/tmp/duet-archive/token/content/docs/sub",
    ],
    [
      local,
      "C:\\Temp\\duet-archive\\token\\content",
      "C:\\Temp\\duet-archive\\token\\content\\docs",
    ],
    [
      ssh,
      "/home/u/.duet-tmp/browse-token/content",
      "/home/u/.duet-tmp/browse-token/content/docs",
    ],
  ])(
    "uses the browse root from a subfolder with the same source (%j)",
    (source, root, path) => {
      const location: Location = { source, path };
      const archive: ArchiveBrowse = {
        label: "data.zip",
        root,
        exitTo: { source, path: "/archives" },
      };
      const result = repackBrowseRoot(location, archive);
      expect(result).toEqual({ source, path: root });
      expect(result.source).toBe(source);
      expect(location.path).toBe(path);
    },
  );

  it("keeps the same location values when already at the browse root", () => {
    const location: Location = {
      source: local,
      path: "/tmp/duet-archive/token/content",
    };
    const archive: ArchiveBrowse = {
      label: "data.tar.gz",
      root: location.path,
      exitTo: { source: local, path: "/archives" },
    };
    expect(repackBrowseRoot(location, archive)).toEqual(location);
  });
});
