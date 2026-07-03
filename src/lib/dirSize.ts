import { commands } from "@/types/bindings";
import { activeTab, usePanes, type PaneId } from "@/stores/panes";
import { useToast } from "@/stores/toast";
import { childLocation } from "@/lib/entryDnd";
import { formatSize } from "@/lib/format";
import { formatErr } from "@/lib/error";

/**
 * 폴더 크기 계산 (TC 관례) — 대상 폴더들의 재귀 총 바이트를 backend(fs_dir_size)로
 * 구해 탭의 dirSizes 캐시에 기록(크기 컬럼 표시). 파일은 이미 크기가 있어 스킵.
 *
 * names 미지정 시 활성 탭의 선택 집합(없으면 커서 항목). 폴더 여러 개는 순차 계산 —
 * SSH 에 동시 du 폭주 방지. 단일 폴더면 결과를 토스트로도 보여준다.
 */
export async function calcDirSizes(
  paneId: PaneId,
  names?: string[],
): Promise<void> {
  const s = usePanes.getState();
  const tab = activeTab(s, paneId);
  const toast = useToast.getState().show;

  const cursorName = tab.entries[tab.cursorIndex]?.name;
  const candidates =
    names ?? (tab.selected.size > 0 ? [...tab.selected] : cursorName ? [cursorName] : []);
  const dirs = candidates.filter(
    (n) =>
      n !== ".." && tab.entries.find((e) => e.name === n)?.kind === "dir",
  );
  if (dirs.length === 0) {
    toast("Calculate size: select a folder");
    return;
  }

  for (const name of dirs) {
    const r = await commands.fsDirSize(childLocation(tab.location, name));
    if (r.status === "error") {
      toast(`Size of ${name}: ${formatErr(r.error)}`);
      return;
    }
    usePanes.getState().setDirSize(paneId, tab.id, name, r.data);
    if (dirs.length === 1) toast(`${name}: ${formatSize(r.data)}`);
  }
}
