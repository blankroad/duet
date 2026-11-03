import { beforeEach, expect, it } from "vitest";
import type { Entry } from "@/types/bindings";
import { useUI } from "@/stores/ui";
import {
  usePreviewHover,
  setHoverEntry,
  clearHover,
  dropHoverTarget,
} from "./previewHover";

const file = (name: string): Entry => ({
  name,
  kind: "file",
  size: 1,
  modified_ms: 0,
  permissions: null,
  hidden: false,
});
const hovered = () => usePreviewHover.getState().target?.entry.name;

beforeEach(() => {
  useUI.setState({ previewOpen: true });
  clearHover();
});

it("follows the pointer when it moves onto another row", () => {
  setHoverEntry("left", file("a.txt"), { x: 10, y: 10 });
  setHoverEntry("left", file("b.txt"), { x: 10, y: 40 });
  expect(hovered()).toBe("b.txt");
});

it("ignores rows that slide under a stationary pointer (keyboard scroll)", () => {
  setHoverEntry("left", file("a.txt"), { x: 10, y: 10 });
  dropHoverTarget(); // 키보드로 커서 이동
  setHoverEntry("left", file("c.txt"), { x: 10, y: 10 }); // 스크롤로 지나간 행
  expect(hovered()).toBeUndefined();
  setHoverEntry("left", file("d.txt"), { x: 12, y: 30 }); // 실제로 움직임
  expect(hovered()).toBe("d.txt");
});
