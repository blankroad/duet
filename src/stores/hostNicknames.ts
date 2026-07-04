import { create } from "zustand";
import { commands } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";

/** alias → 사용자 지정 표시명. 백엔드 host-nicknames.json 미러. */
export type NickMap = Partial<Record<string, string>>;

interface State {
  byAlias: NickMap;
  setAll: (m: NickMap) => void;
}

export const useHostNicknames = create<State>((set) => ({
  byAlias: {},
  setAll: (byAlias) => set({ byAlias }),
}));

export async function bootstrapHostNicknames(): Promise<void> {
  const r = await commands.hostNicknameList();
  if (r.status === "ok") useHostNicknames.getState().setAll(r.data);
}

/** 별명 설정(빈 문자열이면 제거). 백엔드 반환 맵으로 정합. */
export async function setHostNickname(
  alias: string,
  nickname: string,
): Promise<void> {
  const r = await commands.hostNicknameSet(alias, nickname);
  if (r.status === "ok") useHostNicknames.getState().setAll(r.data);
  else useToast.getState().show(`Set nickname: ${formatErr(r.error)}`, "error");
}
