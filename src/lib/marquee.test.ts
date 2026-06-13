import { describe, it, expect } from "vitest";
import { normRect, rowsInRect, cellsInRect, exceedsThreshold } from "./marquee";

describe("marquee — normRect", () => {
  it("orders corners regardless of drag direction", () => {
    expect(normRect({ x1: 10, y1: 20, x2: 2, y2: 5 })).toEqual({ x1: 2, y1: 5, x2: 10, y2: 20 });
  });
});

describe("marquee — rowsInRect", () => {
  it("returns rows overlapping the y range (rowH 28)", () => {
    // y 30..70 covers rows 1 (28-56) and 2 (56-84)
    expect(rowsInRect(30, 70, 28, 100)).toEqual([1, 2]);
  });
  it("works with inverted y", () => {
    expect(rowsInRect(70, 30, 28, 100)).toEqual([1, 2]);
  });
  it("clamps to count", () => {
    expect(rowsInRect(0, 10000, 28, 3)).toEqual([0, 1, 2]);
  });
  it("empty when count 0", () => {
    expect(rowsInRect(0, 100, 28, 0)).toEqual([]);
  });
});

describe("marquee — cellsInRect", () => {
  // 4 cols, cell 100x90
  it("selects the rectangle block of cells (row-major)", () => {
    // x 50..250 → cols 0,1,2 ; y 10..100 → rows 0,1
    const got = cellsInRect({ x1: 50, y1: 10, x2: 250, y2: 100 }, 4, 100, 90, 100);
    expect(got).toEqual([0, 1, 2, 4, 5, 6]);
  });
  it("drops indices beyond count", () => {
    // only 3 items, 4 cols → row 0 has 0,1,2
    const got = cellsInRect({ x1: 0, y1: 0, x2: 400, y2: 90 }, 4, 100, 90, 3);
    expect(got).toEqual([0, 1, 2]);
  });
  it("single column behaves like rows", () => {
    expect(cellsInRect({ x1: 0, y1: 30, x2: 200, y2: 70 }, 1, 200, 28, 100)).toEqual([1, 2]);
  });
});

describe("marquee — exceedsThreshold", () => {
  it("false for tiny movement", () => {
    expect(exceedsThreshold(2, 1)).toBe(false);
  });
  it("true once past default 4px", () => {
    expect(exceedsThreshold(0, 5)).toBe(true);
    expect(exceedsThreshold(-6, 0)).toBe(true);
  });
});
