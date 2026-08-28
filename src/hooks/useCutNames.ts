import { useMemo } from "react";
import type { Location } from "@/types/bindings";
import { sameLocationDir } from "@/lib/entryDnd";
import { useClipboard } from "@/stores/clipboard";

/** 잘라내기 대기 항목이 없을 때 공유하는 빈 집합 — 렌더마다 새 Set 을 만들지 않는다. */
const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * 이 폴더에서 Ctrl+X(잘라내기) 대기 중인 항목 이름들.
 *
 * 목록이 해당 행을 흐리게(반투명) 그려 "이미 잘라냈다"를 보여주기 위한 것 — 탐색기와
 * 같은 관례다. 복사(Ctrl+C)는 원본이 그대로 남으므로 표시하지 않는다.
 * 붙여넣기(이동 완료)나 새 복사/잘라내기가 클립보드를 바꾸면 자동으로 사라진다.
 *
 * 클립보드 항목은 원본 location 을 들고 있으므로 **같은 폴더를 보는 패널에서만** 흐려진다
 * (양쪽 패널이 같은 폴더면 양쪽 다). 비교는 구분자 무관(`sameLocationDir`).
 */
export function useCutNames(location: Location): ReadonlySet<string> {
  const clip = useClipboard((s) => s.entry);
  return useMemo(() => {
    if (!clip || clip.mode !== "move") return EMPTY;
    const names = new Set<string>();
    for (const t of clip.targets) {
      if (sameLocationDir(t.location, location)) names.add(t.name);
    }
    return names.size > 0 ? names : EMPTY;
  }, [clip, location]);
}
