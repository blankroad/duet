/**
 * OS 휴지통 가상 뷰 (Windows Recycle Bin) — 패널이 실제 경로 대신 `VIRTUAL_TRASH_PATH`
 * 에 머물고, 목록은 `trash_list` 명령(trash crate)에서 온다.
 *
 * 항목은 경로가 아니라 `id` 로 다룬다. 패널/선택은 이름(Entry.name) 기준이라 같은 이름이
 * 여러 개 있을 수 있는 휴지통에서는 표시 이름을 `name (2)` 식으로 구분하고, 표시 이름 →
 * 휴지통 항목 매핑을 여기 모듈 캐시에 둔다 (휴지통은 사용자당 하나라 전역이어도 된다).
 *
 * 백엔드 `commands::trash::VIRTUAL_TRASH_PATH` 와 같은 값이어야 한다.
 */
import { commands } from "@/types/bindings";
import type { Entry, Location, TrashItemDto } from "@/types/bindings";

export const VIRTUAL_TRASH_PATH = "shell:RecycleBinFolder";

/** 이 location 이 가상 휴지통인가 (로컬 전용). */
export function isVirtualTrash(location: Location): boolean {
  return (
    location.source.kind === "local" && location.path === VIRTUAL_TRASH_PATH
  );
}

export interface TrashEntries {
  entries: Entry[];
  /** 표시 이름 → 휴지통 항목. */
  index: Map<string, TrashItemDto>;
}

/**
 * 휴지통 항목 → 패널 Entry. 삭제 시각을 "수정시각" 열에 보여준다.
 * 같은 이름이 겹치면 두 번째부터 ` (2)`, ` (3)` … 을 붙여 선택/커서 키를 유일하게.
 */
export function buildTrashEntries(items: TrashItemDto[]): TrashEntries {
  const index = new Map<string, TrashItemDto>();
  const entries: Entry[] = [];
  for (const it of items) {
    let name = it.name;
    for (let n = 2; index.has(name); n++) name = `${it.name} (${n})`;
    index.set(name, it);
    entries.push({
      name,
      kind: it.kind,
      size: it.size,
      modified_ms: it.deleted_ms,
      permissions: null,
      hidden: false,
    });
  }
  return { entries, index };
}

let current: Map<string, TrashItemDto> = new Map();

/** 휴지통 목록을 새로 받아 Entry 로 — navigate/refresh 의 listDirectory 대체. */
export async function loadTrashEntries(): Promise<Entry[]> {
  const r = await commands.trashList();
  if (r.status === "error") throw r.error;
  const built = buildTrashEntries(r.data);
  current = built.index;
  return built.entries;
}

/** 표시 이름으로 휴지통 항목 조회 (마지막 목록 기준). */
export function trashItemFor(name: string): TrashItemDto | undefined {
  return current.get(name);
}

/** 표시 이름들 → 휴지통 id 들 (목록에 없는 이름은 건너뜀). */
export function trashIdsFor(names: string[]): string[] {
  return names
    .map((n) => current.get(n)?.id)
    .filter((id): id is string => typeof id === "string");
}
