import { describe, it, expect } from "vitest";
import { displayKey } from "./keyDisplay";

describe("displayKey", () => {
  it("non-mac: passthrough", () => {
    expect(displayKey("Ctrl+Shift+F", false)).toBe("Ctrl+Shift+F");
    expect(displayKey("F5", false)).toBe("F5");
  });

  it("mac: Ctrl→⌘, Apple modifier order, no separators", () => {
    expect(displayKey("Ctrl+P", true)).toBe("⌘P");
    expect(displayKey("Ctrl+Shift+F", true)).toBe("⇧⌘F");
    expect(displayKey("Ctrl+Alt+C", true)).toBe("⌥⌘C");
  });

  it("mac: plain keys and special names", () => {
    expect(displayKey("F5", true)).toBe("F5");
    expect(displayKey("Shift+Delete", true)).toBe("⇧⌦");
    expect(displayKey("Shift+Space", true)).toBe("⇧Space");
  });
});
