import { describe, it, expect, beforeEach } from "vitest";
import { useShelf, shelfKey } from "./shelf";
import type { EntryRef } from "@/types/bindings";

const localRef = (path: string, name: string): EntryRef => ({
  location: { source: { kind: "local" }, path },
  name,
});

const sshRef = (connId: string, path: string, name: string): EntryRef => ({
  location: {
    source: {
      kind: "ssh",
      connection_id: connId,
      host_ip: "10.0.0.1",
      user: "u",
    },
    path,
  },
  name,
});

beforeEach(() => useShelf.getState().clear());

describe("shelf store", () => {
  it("add returns count and stores items", () => {
    const n = useShelf.getState().add([localRef("/a", "x"), localRef("/a", "y")]);
    expect(n).toBe(2);
    expect(useShelf.getState().items).toHaveLength(2);
  });

  it("dedups by source + path + name", () => {
    useShelf.getState().add([localRef("/a", "x")]);
    const n = useShelf.getState().add([localRef("/a", "x"), localRef("/a", "z")]);
    expect(n).toBe(1); // x 는 중복, z 만 추가
    expect(useShelf.getState().items).toHaveLength(2);
  });

  it("same name in different folders are distinct", () => {
    const n = useShelf.getState().add([localRef("/a", "x"), localRef("/b", "x")]);
    expect(n).toBe(2);
  });

  it("local vs ssh same path/name are distinct", () => {
    const n = useShelf
      .getState()
      .add([localRef("/a", "x"), sshRef("c1", "/a", "x")]);
    expect(n).toBe(2);
  });

  it("remove by key", () => {
    useShelf.getState().add([localRef("/a", "x"), localRef("/a", "y")]);
    useShelf.getState().remove(shelfKey(localRef("/a", "x")));
    expect(useShelf.getState().items.map((r) => r.name)).toEqual(["y"]);
  });

  it("clear empties the shelf", () => {
    useShelf.getState().add([localRef("/a", "x")]);
    useShelf.getState().clear();
    expect(useShelf.getState().items).toHaveLength(0);
  });
});
