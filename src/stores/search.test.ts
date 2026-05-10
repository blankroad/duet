import { describe, it, expect, beforeEach } from "vitest";
import { useSearch } from "./search";

describe("search store", () => {
  beforeEach(() => {
    useSearch.setState({
      isOpen: false,
      rootPaneId: null,
      root: null,
      query: "",
      results: [],
      status: "idle",
      error: null,
    });
  });

  it("open sets isOpen + root", () => {
    useSearch.getState().open("left", { source: { kind: "local" }, path: "/" });
    expect(useSearch.getState().isOpen).toBe(true);
    expect(useSearch.getState().rootPaneId).toBe("left");
    expect(useSearch.getState().root?.path).toBe("/");
  });

  it("close resets state", () => {
    useSearch.getState().open("left", { source: { kind: "local" }, path: "/" });
    useSearch.getState().setQueryNow("foo");
    useSearch.getState().setResults([]);
    useSearch.getState().close();
    expect(useSearch.getState().isOpen).toBe(false);
    expect(useSearch.getState().query).toBe("");
    expect(useSearch.getState().results.length).toBe(0);
  });

  it("setStatus updates status", () => {
    useSearch.getState().setStatus("searching");
    expect(useSearch.getState().status).toBe("searching");
    useSearch.getState().setStatus("done");
    expect(useSearch.getState().status).toBe("done");
  });

  it("setError stores error message + status=error", () => {
    useSearch.getState().setError("network down");
    expect(useSearch.getState().error).toBe("network down");
    expect(useSearch.getState().status).toBe("error");
  });
});
