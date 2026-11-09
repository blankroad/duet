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
    const once = formatErr({
      kind: "ConnectionFailed",
      message: "handshake aborted",
    });
    expect(once).toBe("Can't connect to the server — handshake aborted");
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

describe("explainError — connection causes (remote-26)", () => {
  const conn = (message: string) => ({ kind: "ConnectionFailed", message });
  const plain = (reason: string) => i18n.t(`errors.reason.${reason}`);

  it("explains refused, timed out, unreachable, DNS and reset", () => {
    const cases: Array<[string, string]> = [
      ["10.0.0.1:22 — Connection refused (os error 61)", "connRefused"],
      [
        "h:22 — No connection could be made because the target machine actively refused it. (os error 10061)",
        "connRefused",
      ],
      ["h:22 — Operation timed out (os error 60)", "connTimeout"],
      ["h:22 — No route to host (os error 113)", "connUnreachable"],
      ["h:22 — Network is unreachable (os error 51)", "connUnreachable"],
      [
        "nohost:22 — failed to lookup address information: nodename nor servname provided, or not known",
        "connDns",
      ],
      [
        "nohost:22 — failed to lookup address information: Name or service not known",
        "connDns",
      ],
      ["h:22 — No such host is known. (os error 11001)", "connDns"],
      ["ssh handshake: Connection reset by peer (os error 54)", "connReset"],
      ["ssh handshake: Broken pipe (os error 32)", "connReset"],
    ];
    for (const [message, reason] of cases) {
      // 서버·OS 가 달라도 문구가 우선 — 이 PC 가 Windows 여도 같은 원인.
      const r = explainError(conn(message), "windows");
      expect(r.text, message).toBe(plain(reason));
      expect(r.detail).toBe(message);
    }
  });

  it("uses the number when the text is missing", () => {
    expect(explainError(conn("h:22 — (os error 111)"), "linux").text).toBe(
      plain("connRefused"),
    );
    expect(explainError(conn("h:22 — (os error 10060)"), "windows").text).toBe(
      plain("connTimeout"),
    );
  });
});

describe("explainError — target name in the sentence (ss-04, ss-15)", () => {
  const plain = (reason: string) => i18n.t(`errors.reason.${reason}`);

  it("puts the basename of a labelled absolute path in front", () => {
    const r = explainError(
      {
        kind: "PermissionDenied",
        message:
          "permission denied: /srv/data/분기보고서 2026.xlsx (os error 13)",
      },
      "linux",
    );
    expect(r.text).toBe(`“분기보고서 2026.xlsx” — ${plain("accessDenied")}`);
  });

  it("treats a remote SFTP message that is only a path as the target", () => {
    const r = explainError(
      { kind: "NotFound", message: "/home/u/report (1).txt" },
      "windows",
    );
    expect(r.text).toBe(`“report (1).txt” — ${plain("notFound")}`);
  });

  it("finds Windows drive, UNC and quoted paths", () => {
    expect(
      explainError(
        {
          kind: "PermissionDenied",
          message: "C:\\Users\\a\\보고서.xlsx: Access is denied. (os error 5)",
        },
        "windows",
      ).text,
    ).toBe(`“보고서.xlsx” — ${plain("accessDenied")}`);
    expect(
      explainError(
        {
          kind: "Io",
          message:
            "open \\\\server\\share\\a.txt: The device is not ready. (os error 21)",
        },
        "windows",
      ).text,
    ).toBe(`“a.txt” — ${plain("deviceNotReady")}`);
    expect(
      explainError(
        {
          kind: "Ssh",
          message:
            "host command failed (exit 1): rm: cannot remove '/srv/x/old.log': Permission denied",
        },
        "macos",
      ).text,
    ).toBe(`“old.log” — ${plain("accessDenied")}`);
  });

  it("does not treat ordinary words with slashes as paths", () => {
    for (const message of [
      "Read/write error: Permission denied (os error 13)",
      "zip/tar and/or 3/4: permission denied",
      "https://example.com/a/b: permission denied",
      "expected / got x: permission denied",
    ])
      expect(explainError({ kind: "Io", message }, "linux").text).toBe(
        plain("accessDenied"),
      );
    expect(formatErr({ kind: "Io", message: "a: b" })).toBe("I/O error — a: b");
  });

  it("reads the cause from the text around the path, not the file name", () => {
    expect(
      explainError(
        {
          kind: "Io",
          message:
            "open /tmp/already exists/bad header.txt: Permission denied (os error 13)",
        },
        "linux",
      ).text,
    ).toBe(`“bad header.txt” — ${plain("accessDenied")}`);
  });

  it("keeps the path inside the raw text when the cause is unknown", () => {
    expect(
      explainError({ kind: "Io", message: "target exists: /w/A.txt" }, "linux")
        .text,
    ).toBe("I/O error — target exists: /w/A.txt");
  });
});
