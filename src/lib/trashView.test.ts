import { describe, it, expect } from "vitest";
import type { TrashItemDto } from "@/types/bindings";
import {
  buildTrashEntries,
  isVirtualTrash,
  VIRTUAL_TRASH_PATH,
} from "./trashView";

const item = (over: Partial<TrashItemDto>): TrashItemDto => ({
  id: "id",
  name: "a.txt",
  kind: "file",
  original_path: "C:\\Users\\me\\Desktop\\a.txt",
  deleted_ms: 1_700_000_000_000,
  size: 10,
  ...over,
});

describe("trashView", () => {
  it("가상 휴지통은 로컬 + 센티널 경로일 때만", () => {
    expect(
      isVirtualTrash({ source: { kind: "local" }, path: VIRTUAL_TRASH_PATH }),
    ).toBe(true);
    expect(isVirtualTrash({ source: { kind: "local" }, path: "/tmp" })).toBe(
      false,
    );
    expect(
      isVirtualTrash({
        source: {
          kind: "ssh",
          connection_id: "c",
          host_ip: "1.1.1.1",
          user: "u",
        },
        path: VIRTUAL_TRASH_PATH,
      }),
    ).toBe(false);
  });

  it("삭제 시각을 수정시각 열에, 크기/종류를 그대로 옮긴다", () => {
    const { entries } = buildTrashEntries([
      item({ id: "1", kind: "dir", size: null }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "a.txt",
      kind: "dir",
      size: null,
      modified_ms: 1_700_000_000_000,
    });
  });

  /**
   * 휴지통엔 같은 이름이 여러 개 있을 수 있다(같은 파일을 두 번 지움). 패널의 선택/커서는
   * 이름이 키라 표시 이름을 구분해야 하고, 그 표시 이름으로 원래 항목(id)을 찾을 수 있어야 한다.
   */
  it("같은 이름은 ' (n)' 으로 구분하고 id 매핑을 유지한다", () => {
    const { entries, index } = buildTrashEntries([
      item({ id: "first" }),
      item({ id: "second" }),
      item({ id: "third" }),
    ]);
    expect(entries.map((e) => e.name)).toEqual([
      "a.txt",
      "a.txt (2)",
      "a.txt (3)",
    ]);
    expect(index.get("a.txt (2)")?.id).toBe("second");
    expect(index.get("a.txt (3)")?.id).toBe("third");
  });

  it("이미 ' (2)' 로 끝나는 이름과도 충돌하지 않는다", () => {
    const { entries } = buildTrashEntries([
      item({ id: "x", name: "a.txt (2)" }),
      item({ id: "y", name: "a.txt" }),
      item({ id: "z", name: "a.txt" }),
    ]);
    const names = entries.map((e) => e.name);
    expect(new Set(names).size).toBe(3);
    expect(names).toContain("a.txt (3)");
  });
});
