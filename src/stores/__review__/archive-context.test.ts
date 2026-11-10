/**
 * archive 점검 (opus, C-11/C-13) — 패널 store 의 아카이브 문맥(archive context).
 *
 * App.tsx 의 흐름을 store 호출 순서로 재현한다:
 * - 더블클릭 browse: navigateTo(임시 폴더) → setEntries, 그다음 setArchiveContext (App.tsx:567~576)
 * - "위로" at 아카이브 루트: navigateTo(exitTo) (App.tsx:492~495) → setEntries
 */
import { beforeEach, describe, expect, it } from "vitest";
import { activeTab, usePanes } from "@/stores/panes";
import type { Location } from "@/types/bindings";

const loc = (path: string): Location => ({ source: { kind: "local" }, path });
const T = "/tmp/duet-archive";

function open(path: string) {
  usePanes.getState().setEntries("left", loc(path), []);
}
function ctx() {
  return activeTab(usePanes.getState(), "left").archive;
}

beforeEach(() => {
  open("/home/u/Downloads");
});

describe("archive-opus: archive context in panes store", () => {
  it("하위 폴더로 들어가도 문맥 유지, 루트 밖으로 나가면 해제 (정상)", () => {
    open(`${T}/A/content`);
    usePanes.getState().setArchiveContext("left", {
      label: "outer.zip",
      root: `${T}/A/content`,
      exitTo: loc("/home/u/Downloads"),
    });
    open(`${T}/A/content/docs`);
    expect(ctx()?.label).toBe("outer.zip");
    // 하위 폴더에서도 문맥(= "아카이브 업데이트" 버튼)이 살아 있다 — Pane.tsx:145 조건은
    // tab.archive 만 본다. 이때 onUpdateArchive 는 tab.location(= .../docs)을 browse_root 로
    // 보낸다 (App.tsx:1270) → Rust opus_repack_from_subfolder_keeps_other_entries 참조.
    expect(activeTab(usePanes.getState(), "left").location.path).toBe(
      `${T}/A/content/docs`,
    );
    open("/home/u/Downloads");
    expect(ctx()).toBeUndefined();
  });

  it(
    "archive-15: 아카이브 안의 아카이브: 안쪽에서 '위로' 로 나오면 바깥 아카이브 문맥이 돌아와야 한다",
    () => {
      // 바깥 아카이브 열기.
      open(`${T}/A/content`);
      usePanes.getState().setArchiveContext("left", {
        label: "outer.zip",
        root: `${T}/A/content`,
        exitTo: loc("/home/u/Downloads"),
      });
      open(`${T}/A/content/sub`);
      // 안쪽 아카이브 더블클릭 → 새 임시 폴더로 이동 + 문맥 교체 (exitTo = 바깥 임시 폴더).
      open(`${T}/B/content`);
      usePanes.getState().setArchiveContext("left", {
        label: "inner.zip",
        root: `${T}/B/content`,
        exitTo: loc(`${T}/A/content/sub`),
      });
      expect(ctx()?.label).toBe("inner.zip");
      // 안쪽 루트에서 "위로" → exitTo 로 이동.
      open(`${T}/A/content/sub`);
      // 기대: outer.zip 문맥 복귀 (breadcrumb·"아카이브 업데이트"·"위로=원래 폴더").
      // 현재: 문맥이 사라져 임시 경로가 그대로 보이고 "위로" 가 시스템 temp 로 올라간다.
      expect(ctx()?.label).toBe("outer.zip");
    },
  );
});
