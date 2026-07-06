import { describe, it, expect, beforeEach } from "vitest";
import { useShelf, shelfKey, shelfSectionItems } from "./shelf";
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

/** 모든 섹션 항목 평탄화. */
const allItems = () => useShelf.getState().sections.flatMap((s) => s.items);

/** 단일 섹션·무항목 상태로 리셋(테스트 간 격리). */
function resetShelf() {
  const st = useShelf.getState;
  while (st().sections.length > 1) {
    st().deleteSection(st().sections[st().sections.length - 1]!.id);
  }
  st().clear();
  st().setTarget(st().sections[0]!.id);
}

beforeEach(resetShelf);

describe("shelf store", () => {
  it("add returns count and stores items in target section", () => {
    const n = useShelf.getState().add([localRef("/a", "x"), localRef("/a", "y")]);
    expect(n).toBe(2);
    expect(shelfSectionItems()).toHaveLength(2);
  });

  it("dedups globally by source + path + name", () => {
    useShelf.getState().add([localRef("/a", "x")]);
    const n = useShelf.getState().add([localRef("/a", "x"), localRef("/a", "z")]);
    expect(n).toBe(1); // x 는 중복, z 만 추가
    expect(allItems()).toHaveLength(2);
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
    expect(allItems().map((r) => r.name)).toEqual(["y"]);
  });

  it("clear empties all sections", () => {
    useShelf.getState().add([localRef("/a", "x")]);
    useShelf.getState().clear();
    expect(allItems()).toHaveLength(0);
  });

  it("new section becomes target; add lands there", () => {
    useShelf.getState().add([localRef("/a", "x")]); // → section 1
    const s2 = useShelf.getState().newSection("B");
    expect(useShelf.getState().targetId).toBe(s2);
    useShelf.getState().add([localRef("/a", "y")]); // → section B
    expect(shelfSectionItems(s2).map((r) => r.name)).toEqual(["y"]);
    expect(allItems()).toHaveLength(2);
  });

  it("moveItem relocates across sections; dedup stays global", () => {
    useShelf.getState().add([localRef("/a", "x")]);
    const first = useShelf.getState().sections[0]!.id;
    const s2 = useShelf.getState().newSection("B");
    useShelf.getState().moveItem(shelfKey(localRef("/a", "x")), s2);
    expect(shelfSectionItems(first)).toHaveLength(0);
    expect(shelfSectionItems(s2).map((r) => r.name)).toEqual(["x"]);
    // 이미 어느 섹션에 있으므로 재추가는 중복.
    expect(useShelf.getState().add([localRef("/a", "x")])).toBe(0);
  });

  it("deleteSection keeps at least one and moves target off deleted", () => {
    const first = useShelf.getState().sections[0]!.id;
    const s2 = useShelf.getState().newSection("B"); // target=s2
    useShelf.getState().deleteSection(s2);
    expect(useShelf.getState().sections).toHaveLength(1);
    expect(useShelf.getState().targetId).toBe(first);
    // 마지막 하나는 삭제 불가.
    useShelf.getState().deleteSection(first);
    expect(useShelf.getState().sections).toHaveLength(1);
  });
});
