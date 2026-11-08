import { describe, it, expect } from "vitest";
import { explainError, formatErr } from "./error";

// 테스트 환경 언어는 en (jsdom navigator.language).
describe("explainError — plain-language errors", () => {
  it("maps message-less kinds to a reason", () => {
    expect(formatErr({ kind: "AuthFailed" })).toMatch(/could not sign in/i);
    expect(formatErr({ kind: "NeedPassword" })).toMatch(
      /password is required/i,
    );
    expect(formatErr({ kind: "Cancelled" })).toBe("Cancelled.");
  });

  it("reads the innermost OS error code with the OS's own meaning", () => {
    const tar =
      "dir/link: failed to unpack `dir/link`: A required privilege is not held by the client. (os error 1314)";
    expect(explainError({ kind: "Io", message: tar }, "windows").text).toMatch(
      /developer mode/i,
    );
    // 1 = Windows "incorrect function" / Unix EPERM.
    const one = { kind: "Io", message: "x (os error 1)" };
    expect(explainError(one, "windows").text).toMatch(/drive doesn't support/i);
    expect(explainError(one, "unix").text).toMatch(/permission denied/i);
    expect(
      explainError({ kind: "Io", message: "open: (os error 32)" }, "windows")
        .text,
    ).toMatch(/another program/i);
    expect(
      explainError({ kind: "Io", message: "write (os error 28)" }, "unix").text,
    ).toMatch(/disk is full/i);
    expect(
      explainError({ kind: "Io", message: "create (os error 123)" }, "windows")
        .text,
    ).toMatch(/can't be used on this os/i);
  });

  it("keeps the raw message as detail", () => {
    const message = "a.txt: failed to unpack: Access is denied. (os error 5)";
    const r = explainError({ kind: "PermissionDenied", message }, "windows");
    expect(r.text).toMatch(/permission denied/i);
    expect(r.detail).toBe(message);
  });

  it("recognises archive problems before generic codes", () => {
    expect(
      formatErr({
        kind: "Io",
        message: "archive is damaged or not a tar: invalid gzip header",
      }),
    ).toMatch(/archive is damaged/i);
    expect(
      formatErr({
        kind: "Io",
        message:
          "zip extract: unsupported Zip archive: Compression method not supported",
      }),
    ).toMatch(/compression method/i);
    expect(
      formatErr({
        kind: "Io",
        message: "archive writes through a link (a/b), refusing to extract",
      }),
    ).toMatch(/for safety/i);
  });

  it("names a program missing on the server", () => {
    expect(
      formatErr({
        kind: "NotSupported",
        message: "`unzip` is not installed on the remote host",
      }),
    ).toMatch(/server doesn't have unzip/i);
  });

  it("matches remote (code-less) messages by text", () => {
    expect(
      formatErr({
        kind: "Ssh",
        message: "host command failed: No space left on device",
      }),
    ).toMatch(/disk is full/i);
  });

  it("connection failures keep the cause and are not doubled", () => {
    const once = formatErr({ kind: "ConnectionFailed", message: "timed out" });
    expect(once).toBe("Can't connect to the server — timed out");
    expect(formatErr({ kind: "ConnectionFailed", message: once })).toBe(once);
  });

  it("unknown causes keep the label and the cleaned message", () => {
    expect(
      formatErr({ kind: "Io", message: "something odd (os error 9999)" }),
    ).toBe("I/O error — something odd");
    expect(formatErr({ message: "ipc broke" })).toBe("ipc broke");
    expect(formatErr({ kind: "SomethingNew" })).toBe("SomethingNew");
    expect(formatErr("plain")).toBe("plain");
  });

  it("HostKeyUnverified (object message) → reason only", () => {
    expect(
      formatErr({ kind: "HostKeyUnverified", message: { fingerprint: "x" } }),
    ).toMatch(/host key/i);
  });
});
