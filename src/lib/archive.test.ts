import { describe, it, expect } from "vitest";
import { canExtractArchive, canRepackArchive } from "./archive";
import type { SourceId } from "@/types/bindings";

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
