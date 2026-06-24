import { describe, it, expect } from "vitest";
import { tagsFor, allTagNames, matchesTagFilter } from "./tags";

describe("tags helpers", () => {
  const map = { "host:a": ["prod", "db"], "bm:1": ["prod"], "fav:2": ["client"] };

  it("tagsFor returns tags or empty", () => {
    expect(tagsFor(map, "host:a")).toEqual(["prod", "db"]);
    expect(tagsFor(map, "missing")).toEqual([]);
  });

  it("allTagNames is unique + sorted", () => {
    expect(allTagNames(map)).toEqual(["client", "db", "prod"]);
  });

  it("matchesTagFilter: empty filter passes everything", () => {
    expect(matchesTagFilter([], [])).toBe(true);
    expect(matchesTagFilter(["prod"], [])).toBe(true);
  });

  it("matchesTagFilter: OR semantics", () => {
    expect(matchesTagFilter(["prod", "db"], ["prod"])).toBe(true);
    expect(matchesTagFilter(["db"], ["prod", "client"])).toBe(false);
    expect(matchesTagFilter(["client"], ["prod", "client"])).toBe(true);
  });
});
