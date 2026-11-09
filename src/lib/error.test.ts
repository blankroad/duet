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

describe("explainError — remote archive commands (archive-32)", () => {
  const ssh = (message: string) => ({ kind: "Ssh", message });
  const plain = (reason: string, vars?: Record<string, string>) =>
    i18n.t(`errors.reason.${reason}`, vars ?? {});

  it("unzip exit 50 is a full disk", () => {
    expect(formatErr(ssh("host command failed (exit 50): "))).toBe(
      plain("diskFull"),
    );
    expect(
      formatErr(
        ssh("host command failed (exit 50): error: write error (disk full?)"),
      ),
    ).toBe(plain("diskFull"));
  });

  it("an exit code without output says the command failed", () => {
    expect(formatErr(ssh("host command failed (exit 1): "))).toBe(
      plain("remoteExit", { code: "1" }),
    );
  });

  it("a missing tar codec program names the program", () => {
    expect(
      formatErr(
        ssh(
          "host command failed (exit 2): tar (child): xz: Cannot exec: No such file or directory\ntar (child): Error is not recoverable: exiting now",
        ),
      ),
    ).toBe(plain("remoteMissingProgram", { prog: "xz" }));
    expect(
      formatErr(
        ssh(
          'host command failed (exit 1): tar: Error opening archive: Can\'t initialize filter; unable to run program "zstd -d -qq"',
        ),
      ),
    ).toBe(plain("remoteMissingProgram", { prog: "zstd" }));
    expect(
      formatErr(
        ssh("host command failed (exit 64): tar: unrecognized option '--zstd'"),
      ),
    ).toBe(plain("remoteMissingProgram", { prog: "zstd" }));
  });

  it("an unknown host failure drops the developer prefix", () => {
    expect(
      formatErr(ssh("host command failed (exit 2): tar: something odd")),
    ).toBe("SSH error — tar: something odd");
  });
});

describe("explainError — sync between different hosts (SC-15)", () => {
  it("points to Compare → Apply/Merge instead of the developer sentence", () => {
    const r = explainError({
      kind: "NotSupported",
      message:
        "sync supports local↔local and same-host SSH only (cross-host relay is a follow-up)",
    });
    expect(r.text).toBe(i18n.t("errors.reason.syncCrossHost"));
    expect(r.text).toMatch(/Compare/);
    expect(r.text).not.toMatch(/local↔local/);
  });
});

describe("explainError — backup kept after a failed folder replace (fileops-09)", () => {
  it("names the first cause and the full backup path, not the backup as target", () => {
    const message =
      "1 item(s) failed — a: io: copy failed (permission denied: injected list failure); " +
      "original preserved at backup /w/dst/a.bak.20261108-101500 " +
      "(rollback failed: io: Directory not empty (os error 66))";
    const r = explainError({ kind: "Io", message }, "macos");
    expect(r.text).toBe(
      `${i18n.t("errors.reason.accessDenied")} ${i18n.t("errors.backupKept", {
        path: "/w/dst/a.bak.20261108-101500",
      })}`,
    );
    expect(r.detail).toBe(message);
  });
});

describe("explainError — R3 review (sol-3) R3-01", () => {
  // R3-01: 백업 경로는 marker 와 마지막 " (rollback failed:" 사이 전체(core/ops.rs:695,1027).
  it.each([
    ["macos", "/w/dst/a (1).bak.20261108-101500"],
    ["macos", "/w/dst/it's.bak.20261108-101500"],
    ["windows", "C:\\w\\dst\\a (1).bak.20261108-101500"],
  ] as const)("R3-01 %s keeps the whole backup path %s", (os, backup) => {
    const message =
      "1 item(s) failed — a: io: copy failed (permission denied: injected list failure); " +
      `original preserved at backup ${backup} ` +
      "(rollback failed: io: Directory not empty (os error 66))";
    const r = explainError({ kind: "Io", message }, os);
    expect(r.text).toContain(i18n.t("errors.backupKept", { path: backup }));
  });
});

describe("explainError — R3 review (sol-3) R3-02", () => {
  const plain = (reason: string, vars?: Record<string, string>) =>
    i18n.t(`errors.reason.${reason}`, vars ?? {});
  const named = (name: string, reason: string) =>
    i18n.t("errors.withName", { name, text: plain(reason) });

  // R3-02 A: SFTP NotFound/PermissionDenied 는 message 전체가 경로(fs/ssh.rs:786).
  it.each([
    [
      "NotFound",
      "/srv/project: permission denied.txt",
      "project: permission denied.txt",
      "notFound",
    ],
    [
      "PermissionDenied",
      "/srv/report: no such file.txt",
      "report: no such file.txt",
      "accessDenied",
    ],
    [
      "NotFound",
      "/srv/report\nconnection refused.txt",
      "report\nconnection refused.txt",
      "notFound",
    ],
  ])("R3-02 A %s whole-path message %j", (kind, message, name, reason) => {
    expect(explainError({ kind, message }, "linux").text).toBe(
      named(name, reason),
    );
  });

  // R3-02 B: combine_failures(core/ops.rs:447) 의 "<name>: <err>" 이름도 원인으로 읽지 않는다.
  it.each([
    [
      "bad header.txt",
      "1 item(s) failed — bad header.txt: permission denied: /src/bad header.txt",
    ],
    [
      "timed out.txt",
      "1 item(s) failed — timed out.txt: permission denied: /src/timed out.txt",
    ],
  ])(
    "R3-02 B item name %s keeps the PermissionDenied cause",
    (name, message) => {
      expect(
        explainError({ kind: "PermissionDenied", message }, "linux").text,
      ).toBe(named(name, "accessDenied"));
    },
  );

  it("R3-02 B item names containing ': ' are masked up to the error prefix", () => {
    expect(
      explainError(
        {
          kind: "NotFound",
          message:
            "2 item(s) failed — a: already exists.txt: not found: x; b.txt: not found: y",
        },
        "linux",
      ).text,
    ).toBe(named("a: already exists.txt", "notFound"));
  });
});

describe("explainError — R3 review (sol-3) R3-04", () => {
  const plain = (reason: string, vars?: Record<string, string>) =>
    i18n.t(`errors.reason.${reason}`, vars ?? {});
  const named = (name: string, reason: string) =>
    i18n.t("errors.withName", { name, text: plain(reason) });

  // R3-04: 따옴표 속 URL·':' 포함 주소·숫자/숫자 는 경로가 아니다.
  it.each([
    "ratio or URL 'https://example.com/a/b': Permission denied",
    "ratio or URL '2001:db8::/64': Permission denied",
    "ratio or URL '3/4': Permission denied",
  ])("R3-04 does not name %j", (message) => {
    expect(explainError({ kind: "Io", message }, "linux").text).toBe(
      plain("accessDenied"),
    );
  });

  it("R3-04 still finds relative and extended paths in quotes", () => {
    expect(
      explainError(
        { kind: "Io", message: "unpack 'dir/link': Permission denied" },
        "linux",
      ).text,
    ).toBe(named("link", "accessDenied"));
    expect(
      explainError(
        {
          kind: "Io",
          message:
            "open '\\\\?\\C:\\work\\file.txt': Access is denied. (os error 5)",
        },
        "windows",
      ).text,
    ).toBe(named("file.txt", "accessDenied"));
    for (const message of [
      "C: Permission denied",
      "at 10:30 Permission denied",
      "--output=/tmp/a Permission denied",
    ])
      expect(explainError({ kind: "Io", message }, "linux").text).toBe(
        plain("accessDenied"),
      );
  });
});
