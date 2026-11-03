import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PathBreadcrumbs } from "./PathBreadcrumbs";
import { useContextMenu, isSeparator } from "@/stores/contextMenu";
import "@/i18n";
afterEach(() => {
  cleanup();
  useContextMenu.getState().close();
});
it.each([
  [
    { label: "/", path: "/" },
    { label: "projects", path: "/projects" },
    { label: "duet", path: "/projects/duet" },
  ],
  [
    { label: "C:", path: "C:\\" },
    { label: "projects", path: "C:\\projects" },
    { label: "duet", path: "C:\\projects\\duet" },
  ],
])("상위 폴더 메뉴에서 전달된 경로를 그대로 탐색한다: %j", (...items) => {
  const navigate = vi.fn();
  render(<PathBreadcrumbs items={items} onNavigate={navigate} />);
  fireEvent.click(screen.getAllByRole("button")[0]!);
  const parents = useContextMenu.getState().items;
  expect(parents).toHaveLength(2);
  // 가까운 부모가 첫 항목.
  const parent = parents[0]!;
  if (!isSeparator(parent)) parent.onSelect?.();
  expect(navigate).toHaveBeenCalledWith(items[1]!.path);
  fireEvent.click(screen.getByText("duet"));
  expect(navigate).toHaveBeenLastCalledWith(items[2]!.path);
});
it("루트에서는 불필요한 상위 폴더 버튼을 표시하지 않는다", () => {
  render(
    <PathBreadcrumbs
      items={[{ label: "/", path: "/" }]}
      onNavigate={vi.fn()}
    />,
  );
  expect(screen.getAllByRole("button")).toHaveLength(1);
});
it("현재 폴더 클릭 핸들러가 있으면 재이동 대신 그것을 부르고, 메뉴 머리 항목을 앞에 붙인다", () => {
  const navigate = vi.fn();
  const edit = vi.fn();
  const copy = vi.fn();
  render(
    <PathBreadcrumbs
      items={[
        { label: "/", path: "/" },
        { label: "a", path: "/a" },
        { label: "b", path: "/a/b" },
      ]}
      onNavigate={navigate}
      onCurrentClick={edit}
      menuHead={[{ id: "copy", label: "Copy path", onSelect: copy }]}
    />,
  );
  fireEvent.click(screen.getByText("b"));
  expect(edit).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Parent folders" }));
  const menu = useContextMenu.getState().items;
  expect(menu.map((m) => (isSeparator(m) ? "-" : m.label))).toEqual([
    "Copy path",
    "a",
    "/",
  ]);
});
