import { describe, it, expect } from "vitest";
import { formatErr } from "./error";

describe("formatErr — humanized error lines", () => {
  it("maps message-less kinds to friendly labels", () => {
    expect(formatErr({ kind: "AuthFailed" })).toBe("Authentication failed");
    expect(formatErr({ kind: "NeedPassword" })).toBe("Password required");
    expect(formatErr({ kind: "Cancelled" })).toBe("Cancelled");
  });

  it("strips '(os error N)' noise and prefixes the label", () => {
    expect(
      formatErr({
        kind: "PermissionDenied",
        message: "Access is denied. (os error 5)",
      }),
    ).toBe("Permission denied — Access is denied.");
    expect(
      formatErr({ kind: "Io", message: "No space left on device (os error 28)" }),
    ).toBe("I/O error — No space left on device");
  });

  it("does not repeat the label when detail already starts with it", () => {
    expect(
      formatErr({ kind: "PermissionDenied", message: "permission denied" }),
    ).toBe("permission denied");
  });

  it("falls back to message / kind / String for unknown shapes", () => {
    expect(formatErr({ message: "ipc broke" })).toBe("ipc broke");
    expect(formatErr({ kind: "SomethingNew" })).toBe("SomethingNew");
    expect(formatErr("plain")).toBe("plain");
  });

  it("HostKeyUnverified (object message) → label only", () => {
    expect(
      formatErr({ kind: "HostKeyUnverified", message: { fingerprint: "x" } }),
    ).toBe("Host key not verified");
  });
});
