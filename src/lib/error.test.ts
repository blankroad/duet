import { describe, it, expect } from "vitest";
import i18n from "@/i18n";
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

describe("explainError — errno tables per OS (ss-14)", () => {
  const io = (code: number) => ({
    kind: "Io",
    message: `x (os error ${code})`,
  });
  const plain = (reason: string) => i18n.t(`errors.reason.${reason}`);

  it("reads numbers that differ between macOS and Linux with the right OS", () => {
    expect(explainError(io(63), "macos").text).toBe(plain("nameTooLong"));
    expect(explainError(io(36), "linux").text).toBe(plain("nameTooLong"));
    expect(explainError(io(69), "macos").text).toBe(plain("diskFull"));
    expect(explainError(io(122), "linux").text).toBe(plain("diskFull"));
    // 36 = macOS EINPROGRESS, 63 = Linux ENOSR, 69 = Linux ESRMNT — 원인 없음.
    expect(explainError(io(36), "macos").text).toBe("I/O error — x");
    expect(explainError(io(63), "linux").text).toBe("I/O error — x");
    expect(explainError(io(69), "linux").text).toBe("I/O error — x");
  });

  it("'unix' only uses numbers that mean the same on both", () => {
    for (const code of [36, 63, 69, 122])
      expect(explainError(io(code), "unix").text).toBe("I/O error — x");
    expect(explainError(io(13), "unix").text).toBe(plain("accessDenied"));
  });

  it("explains a non-empty folder and an unsupported operation", () => {
    expect(explainError(io(66), "macos").text).toBe(plain("notEmpty"));
    expect(explainError(io(39), "linux").text).toBe(plain("notEmpty"));
    expect(explainError(io(145), "windows").text).toBe(plain("notEmpty"));
    expect(
      explainError(
        { kind: "Ssh", message: "rmdir: Directory not empty" },
        "windows",
      ).text,
    ).toBe(plain("notEmpty"));
    expect(explainError(io(45), "macos").text).toBe(plain("unsupportedOp"));
    expect(explainError(io(95), "linux").text).toBe(plain("unsupportedOp"));
  });

  it("does not read a remote command's errno with this PC's table", () => {
    // Windows 32 = 공유 위반이지만, 서버(Linux)의 EPIPE 다.
    expect(
      explainError(
        {
          kind: "Ssh",
          message: "command failed: Is a directory (os error 32)",
        },
        "windows",
      ).text,
    ).toBe("SSH error — command failed: Is a directory");
  });
});

describe("explainError — Windows-only causes", () => {
  const io = (code: number) => ({
    kind: "Io",
    message: `x (os error ${code})`,
  });
  const plain = (reason: string) => i18n.t(`errors.reason.${reason}`);

  it("maps device, network logon, antivirus and cloud file errors", () => {
    expect(explainError(io(21), "windows").text).toBe(plain("deviceNotReady"));
    expect(explainError(io(1326), "windows").text).toBe(plain("networkLogon"));
    expect(explainError(io(225), "windows").text).toBe(plain("virus"));
    expect(explainError(io(362), "windows").text).toBe(plain("cloudFile"));
    // 같은 번호라도 다른 OS 에선 다른 뜻.
    expect(explainError(io(21), "linux").text).toBe("I/O error — x");
  });

  it("recognises the Windows message text for other cloud file codes", () => {
    expect(
      explainError(
        {
          kind: "Io",
          message:
            "The cloud file provider exited unexpectedly. (os error 9999)",
        },
        "windows",
      ).text,
    ).toBe(plain("cloudFile"));
  });
});
