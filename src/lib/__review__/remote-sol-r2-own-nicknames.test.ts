import { expect, it } from "vitest";
import { nicknameOf, useHostNicknames } from "@/stores/hostNicknames";
import { aliasLabel } from "@/lib/hostLabel";

it("NEW-3 review: genuine own nicknames survive for prototype-named aliases", () => {
  const aliases = ["__proto__", "constructor", "toString"];
  const incoming = JSON.parse(
    '{"__proto__":"Proto server","constructor":"Build server","toString":"Logs server"}',
  );
  useHostNicknames.getState().setAll(incoming);
  const stored = useHostNicknames.getState().byAlias;
  expect(Object.getPrototypeOf(stored)).toBeNull();
  for (const alias of aliases) {
    expect(nicknameOf(stored, alias)).toBe(incoming[alias]);
    expect(aliasLabel(alias, stored)).toBe(incoming[alias]);
    expect(nicknameOf({}, alias)).toBeUndefined();
  }
});
