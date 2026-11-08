import { expect, it } from "vitest";
import { buildCrumbs } from "@/components/pane/pathCrumbs";
import { parentPath } from "@/lib/entryDnd";
import { isRootPath } from "@/stores/panes";

it.each([
  ["C:\\", true, null],
  ["C:", true, null],
  ["C:\\Users", false, "C:\\"],
  ["\\\\server\\share\\dir", false, "\\\\server\\share"],
  ["/", true, null],
  ["/home", false, "/"],
] as const)("root/parent %s", (path, root, parent) => {
  expect(isRootPath(path)).toBe(root);
  expect(parentPath(path)).toBe(parent);
});

it.fails(
  "browse-10 (F-sol-10): UNC share root has no parent navigation",
  () => {
    expect(isRootPath("\\\\server\\share")).toBe(true);
    expect(parentPath("\\\\server\\share")).toBeNull();
  },
);

it.fails(
  "browse-10 (F-sol-10): extended drive root has no parent navigation",
  () => {
    expect(isRootPath("\\\\?\\C:\\")).toBe(true);
    expect(parentPath("\\\\?\\C:\\")).toBeNull();
  },
);

it.fails(
  "browse-10 (F-sol-10): extended drive child's parent preserves the root separator",
  () => {
    expect(parentPath("\\\\?\\C:\\long")).toBe("\\\\?\\C:\\");
  },
);

it.fails(
  "browse-10 (F-sol-10): extended drive breadcrumb never offers the device prefix as a parent",
  () => {
    expect(buildCrumbs("\\\\?\\C:\\long\\file", true)[0]?.path).toBe(
      "\\\\?\\C:\\",
    );
  },
);

it.each(["C:\\한글 폴더\\space name\\", "\\\\서버\\공유\\한글 폴더\\"])(
  "Korean, spaces and trailing separator preserve current path: %s",
  (path) => expect(buildCrumbs(path, true).at(-1)?.path).toBe(path),
);

it.fails(
  "browse-10 (F-sol-10): extended UNC breadcrumb keeps server and share together",
  () => {
    expect(buildCrumbs("\\\\?\\UNC\\server\\share\\dir", true)[0]?.path).toBe(
      "\\\\?\\UNC\\server\\share",
    );
  },
);
