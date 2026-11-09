import { describe, expect, it } from "vitest";
import { explainError } from "../error";

describe("shell-settings: 오류 원인의 경계 조건", () => {
  it("shell-settings-14: macOS EINPROGRESS(36)를 긴 이름으로 오해하지 않는다", () => {
    const result = explainError(
      {
        kind: "ConnectionFailed",
        message: "Operation now in progress (os error 36)",
      },
      "unix",
    );
    expect(result.text).not.toMatch(/name is too long/i);
  });

  it("shell-settings-14: Linux ESRMNT(69)를 디스크 용량 부족으로 오해하지 않는다", () => {
    const result = explainError(
      { kind: "Io", message: "Srmount error (os error 69)" },
      "unix",
    );
    expect(result.text).not.toMatch(/disk is full/i);
  });

  it("shell-settings-15: NotFound 파일 이름의 bad header를 압축 손상으로 오해하지 않는다", () => {
    const result = explainError(
      { kind: "NotFound", message: "/tmp/bad header.txt" },
      "windows",
    );
    expect(result.text).toMatch(/can't be found/i);
  });

  it("shell-settings-15: PermissionDenied 경로의 already exists를 이름 충돌로 오해하지 않는다", () => {
    const result = explainError(
      { kind: "PermissionDenied", message: "/tmp/already exists.txt" },
      "unix",
    );
    expect(result.text).toMatch(/permission denied/i);
  });

  it("shell-settings-improve: SSH exec의 원격 errno를 Windows 번호로 오해하지 않는다", () => {
    const remoteMac = explainError(
      {
        kind: "Ssh",
        message: "command failed (1): Operation not permitted (os error 1)",
      },
      "windows",
    );
    expect(remoteMac.text).toMatch(/permission denied/i);
  });

  it("Windows 흔한 파일 오류는 구체 원인으로 표시한다", () => {
    for (const code of [32, 33])
      expect(
        explainError({ kind: "Io", message: `(os error ${code})` }, "windows")
          .text,
      ).toMatch(/another program/i);
    expect(
      explainError({ kind: "Io", message: "(os error 112)" }, "windows").text,
    ).toMatch(/disk is full/i);
    expect(
      explainError({ kind: "Io", message: "(os error 206)" }, "windows").text,
    ).toMatch(/name is too long/i);
  });
});
