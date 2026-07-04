import { create } from "zustand";
import { commands } from "@/types/bindings";
import type { HostGroup } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";

/**
 * Saved hosts 그룹(폴더) 오버레이 — backend `host-groups.json` 영속.
 * 호스트 데이터를 복제하지 않고 alias 만 참조(진실의 원천은 savedHosts).
 * 그룹핑 로직은 여기(FE)서 수행하고 backend 는 get/set 영속 + 정규화만.
 */
interface State {
  groups: HostGroup[];
  setGroups: (g: HostGroup[]) => void;
}

export const useHostGroups = create<State>((set) => ({
  groups: [],
  setGroups: (groups) => set({ groups }),
}));

export async function bootstrapHostGroups(): Promise<void> {
  const r = await commands.hostGroupsList();
  if (r.status === "ok") useHostGroups.getState().setGroups(r.data);
}

/** 낙관적 업데이트 + backend 정규화 반영 (실패 시 롤백 + toast). */
async function persist(next: HostGroup[]): Promise<void> {
  const prev = useHostGroups.getState().groups;
  useHostGroups.getState().setGroups(next);
  const r = await commands.hostGroupsSet(next);
  if (r.status === "ok") {
    useHostGroups.getState().setGroups(r.data);
  } else {
    useHostGroups.getState().setGroups(prev);
    useToast.getState().show(`Group update failed: ${formatErr(r.error)}`, "error");
  }
}

function newId(): string {
  return crypto.randomUUID();
}

/** 새 그룹 생성 (선택적으로 첫 멤버 alias 포함). */
export async function createGroup(name: string, firstMember?: string): Promise<void> {
  const groups = [
    ...useHostGroups.getState().groups,
    { id: newId(), name, members: firstMember ? [firstMember] : [] },
  ];
  await persist(groups);
}

export async function renameGroup(id: string, name: string): Promise<void> {
  await persist(useHostGroups.getState().groups.map((g) => (g.id === id ? { ...g, name } : g)));
}

/** 그룹 삭제 — 멤버는 ungrouped 로 돌아감(members 가 사라질 뿐 host 자체는 그대로). */
export async function deleteGroup(id: string): Promise<void> {
  await persist(useHostGroups.getState().groups.filter((g) => g.id !== id));
}

/** alias 를 folderId 그룹으로 이동 (null = 모든 그룹에서 제거 → ungrouped). */
export async function assignToGroup(alias: string, folderId: string | null): Promise<void> {
  const groups = useHostGroups
    .getState()
    .groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== alias) }));
  if (folderId) {
    const g = groups.find((x) => x.id === folderId);
    if (g) g.members = [...g.members, alias];
  }
  await persist(groups);
}

/** 그룹 순서 이동 (-1 = 위로, +1 = 아래로). */
export async function moveGroup(id: string, dir: -1 | 1): Promise<void> {
  const groups = [...useHostGroups.getState().groups];
  const i = groups.findIndex((g) => g.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= groups.length) return;
  [groups[i], groups[j]] = [groups[j]!, groups[i]!];
  await persist(groups);
}
