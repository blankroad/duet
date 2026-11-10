// UX smoke (fileops, opus) — mocked FE test. Copy into the same folder (F5 with both
// panes on one folder, Ctrl+C → Ctrl+V in place): every conflict is the source item
// itself, so the confirm dialog preselects "Keep both" (Explorer/Finder duplicate).
// The dialog still shows; the user can pick another policy. The global default and the
// remembered session choice are not changed by this preselect.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  Conflict,
  CopyPlan,
  EntryRef,
  Location,
  MovePlan,
} from "@/types/bindings";
import { CopyMoveConfirmDialog } from "@/components/dialogs/CopyMoveConfirmDialog";
import { useAppSettings } from "@/stores/settings";
import { selfConflictsOnly } from "@/lib/planItems";
import "@/i18n";

const here: Location = { source: { kind: "local" }, path: "C:\\work" };
const other: Location = { source: { kind: "local" }, path: "D:\\backup" };
const remote: Location = {
  source: { kind: "ssh", connection_id: "c1", host_ip: "10.0.0.5", user: "u" },
  path: "/srv/data",
};

const ref = (loc: Location, name: string): EntryRef => ({
  location: loc,
  name,
});
const conflict = (name: string): Conflict => ({
  name,
  dst_path: name,
  will_become_backup: "",
  dst_is_dir: false,
  dst_size: 1,
  dst_modified_ms: 0,
  src_size: 1,
  src_modified_ms: 0,
});
const plan = (
  items: EntryRef[],
  dst: Location,
  conflicts: string[],
): CopyPlan => ({
  src_source: items[0]!.location.source,
  dst,
  items,
  conflicts: conflicts.map(conflict),
  total_size_bytes: 0,
  strategy: { kind: "local_to_local" },
});

function show(kind: "copy" | "move", p: CopyPlan) {
  const onConfirm = vi.fn();
  render(
    <CopyMoveConfirmDialog
      kind={kind}
      plan={kind === "move" ? ({ ...p, is_same_fs: true } as MovePlan) : p}
      onCancel={() => {}}
      onConfirm={onConfirm}
      onConfirmPerFile={vi.fn()}
    />,
  );
  const cta = screen.getAllByRole("button", {
    name: kind === "copy" ? /^Copy/ : /^Move/,
  });
  fireEvent.click(cta[cta.length - 1]!);
  return onConfirm;
}

/** Which conflict policy radio is selected when the dialog opens. */
function selectedPolicy(kind: "copy" | "move", p: CopyPlan): string | null {
  render(
    <CopyMoveConfirmDialog
      kind={kind}
      plan={kind === "move" ? ({ ...p, is_same_fs: true } as MovePlan) : p}
      onCancel={() => {}}
      onConfirm={vi.fn()}
      onConfirmPerFile={vi.fn()}
    />,
  );
  const on = screen
    .getAllByRole("radio")
    .find((r) => r.getAttribute("aria-checked") === "true");
  return on?.textContent ?? null;
}

afterEach(() => {
  cleanup();
  useAppSettings.setState({
    conflictDefault: "skip",
    rememberConflictChoice: false,
    lastConflictChoice: null,
  });
});

describe("selfConflictsOnly", () => {
  it("true when every conflict is an item copied onto itself", () => {
    expect(
      selfConflictsOnly(
        plan([ref(here, "a.txt"), ref(here, "b")], here, ["a.txt", "b"]),
      ),
    ).toBe(true);
  });
  it("ignores separator spelling of the same folder", () => {
    const fwd: Location = { source: { kind: "local" }, path: "C:/work/" };
    expect(selfConflictsOnly(plan([ref(here, "a.txt")], fwd, ["a.txt"]))).toBe(
      true,
    );
  });
  it("false when the destination is another folder", () => {
    expect(
      selfConflictsOnly(plan([ref(here, "a.txt")], other, ["a.txt"])),
    ).toBe(false);
  });
  it("false without conflicts", () => {
    expect(selfConflictsOnly(plan([ref(here, "a.txt")], here, []))).toBe(false);
  });
  it("same path on another source is not the same item", () => {
    const remoteSame: Location = { ...remote, path: "C:\\work" };
    expect(
      selfConflictsOnly(plan([ref(here, "a.txt")], remoteSame, ["a.txt"])),
    ).toBe(false);
  });
});

describe("copy confirm dialog — same-folder duplicate", () => {
  it("preselects Keep both when every conflict is the item itself", async () => {
    await import("@/i18n").then((m) => m.default.changeLanguage("en"));
    const onConfirm = show("copy", plan([ref(here, "a.txt")], here, ["a.txt"]));
    expect(onConfirm).toHaveBeenCalledWith("keepboth");
  });

  it("works the same on a remote folder", () => {
    const onConfirm = show(
      "copy",
      plan([ref(remote, "a.txt")], remote, ["a.txt"]),
    );
    expect(onConfirm).toHaveBeenCalledWith("keepboth");
  });

  it("the user can still pick another policy", () => {
    const onConfirm = vi.fn();
    render(
      <CopyMoveConfirmDialog
        kind="copy"
        plan={plan([ref(here, "a.txt")], here, ["a.txt"])}
        onCancel={() => {}}
        onConfirm={onConfirm}
        onConfirmPerFile={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Replace" }));
    fireEvent.click(screen.getByRole("button", { name: /^Copy/ }));
    expect(onConfirm).toHaveBeenCalledWith("replace");
  });

  it("keeps the configured default when a conflict is a different item", () => {
    expect(
      selectedPolicy("copy", plan([ref(here, "a.txt")], other, ["a.txt"])),
    ).toBe("Skip");
  });

  it("does not change the default setting or the remembered choice", () => {
    useAppSettings.setState({ rememberConflictChoice: true });
    show("copy", plan([ref(here, "a.txt")], here, ["a.txt"]));
    expect(useAppSettings.getState().conflictDefault).toBe("skip");
    expect(useAppSettings.getState().lastConflictChoice).toBeNull();
  });

  it("does not apply to move (moves into the same folder are refused earlier)", () => {
    expect(
      selectedPolicy("move", plan([ref(here, "a.txt")], here, ["a.txt"])),
    ).toBe("Skip");
  });
});
