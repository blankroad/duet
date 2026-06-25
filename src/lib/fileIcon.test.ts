import { describe, it, expect } from "vitest";
import { iconForEntry } from "./fileIcon";
import type { Entry } from "@/types/bindings";

function file(name: string): Entry {
  return {
    name,
    kind: "file",
    size: 0,
    modified_ms: null,
    permissions: null,
    hidden: false,
  };
}

describe("fileIcon — iconForEntry 우선순위", () => {
  it("유저 override 가 내장 매핑보다 우선", () => {
    // 내장: txt → doc(인디고). override 로 image(그린) 지정 시 override 우선.
    const def = iconForEntry(file("a.txt"));
    expect(def.className).toBe("text-icon-doc");
    const over = iconForEntry(file("a.txt"), { txt: "image" });
    expect(over.className).toBe("text-icon-image");
  });

  it("override 가 없으면 내장 매핑", () => {
    expect(iconForEntry(file("x.pptx"), { docx: "code" }).className).toBe(
      "text-icon-slides",
    );
  });

  it("팔레트에 없는 이름이면 내장으로 폴백", () => {
    expect(iconForEntry(file("x.txt"), { txt: "nonsense" }).className).toBe(
      "text-icon-doc",
    );
  });

  it("디렉토리는 override 무관하게 폴더", () => {
    const dir: Entry = { ...file("foo"), kind: "dir" };
    expect(iconForEntry(dir, { foo: "image" }).className).toBe("text-accent");
  });

  it("확장자 없는 잘 알려진 파일명 매칭 (대소문자 무관)", () => {
    expect(iconForEntry(file("Makefile")).className).toBe("text-icon-code");
    expect(iconForEntry(file("Dockerfile")).className).toBe("text-icon-code");
    expect(iconForEntry(file(".gitignore")).className).toBe("text-icon-data");
    expect(iconForEntry(file("README")).className).toBe("text-icon-doc");
    expect(iconForEntry(file("LICENSE")).className).toBe("text-icon-doc");
  });
});
