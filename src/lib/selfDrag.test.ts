import { expect, it } from "vitest";
import type { Location } from "@/types/bindings";
import { rememberSelfDrag, selfDropKind } from "./selfDrag";

const SRC: Location = { source: { kind: "local" }, path: "/w/src" };
const at = (path: string): Location => ({ source: { kind: "local" }, path });

it("recognises our own OS drag dropped back on its folder or onto itself", () => {
  rememberSelfDrag(["/w/src/a.txt", "/w/src/dir"], SRC, ["a.txt", "dir"]);
  // 순서가 달라도 같은 드래그
  expect(selfDropKind(["/w/src/dir", "/w/src/a.txt"], at("/w/src/"))).toBe(
    "same",
  );
  expect(selfDropKind(["/w/src/a.txt", "/w/src/dir"], at("/w/src/dir"))).toBe(
    "self",
  );
  expect(
    selfDropKind(["/w/src/a.txt", "/w/src/dir"], at("/w/other")),
  ).toBeNull();
});

it("ignores drops of other files (e.g. from Finder) into the same folder", () => {
  rememberSelfDrag(["/w/src/a.txt"], SRC, ["a.txt"]);
  expect(selfDropKind(["/Users/me/x.txt"], SRC)).toBeNull();
});
