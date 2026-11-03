import { describe, expect, it } from "vitest";
import { reorderInSlots } from "./reorderSlots";

const id = (x: string) => x;

describe("reorderInSlots", () => {
  it("전달한 항목의 자리만 새 순서로 채우고 나머지는 제자리", () => {
    // b, d 만 보이는(필터) 상태에서 d 를 b 앞으로.
    expect(reorderInSlots(["a", "b", "c", "d"], id, ["d", "b"])).toEqual([
      "a",
      "d",
      "c",
      "b",
    ]);
  });

  it("모르는 키는 무시하고 항목을 잃지 않는다", () => {
    expect(reorderInSlots(["a", "b"], id, ["zz", "b", "a"])).toEqual([
      "b",
      "a",
    ]);
  });
});
