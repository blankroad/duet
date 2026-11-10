import { create } from "zustand";
import { commands } from "@/types/bindings";
import { showError } from "@/lib/errorToast";

/** alias → 사용자 지정 표시명. 백엔드 host-nicknames.json 미러. */
export type NickMap = Partial<Record<string, string>>;

interface State {
  byAlias: NickMap;
  setAll: (m: NickMap) => void;
}

/**
 * 프로토타입 없는 맵으로 담는다 — `byAlias[alias]` 를 읽는 곳이 많은데, 보통 객체면
 * `constructor`·`toString`·`__proto__` 같은 (유효한) ssh alias 가 상속 속성(함수·객체)을
 * 별명으로 읽어 라벨 자리에 렌더하거나 필터에서 터졌다(remote-NEW-3).
 */
function ownMap(m: NickMap): NickMap {
  return Object.assign(Object.create(null) as NickMap, m);
}

export const useHostNicknames = create<State>((set) => ({
  byAlias: ownMap({}),
  setAll: (byAlias) => set({ byAlias: ownMap(byAlias) }),
}));

/**
 * alias 의 별명 — 자기 속성만 본다. 맵이 어디서 왔든(테스트·다른 setState) 상속
 * 속성을 별명으로 읽지 않게, 별명을 읽는 곳은 모두 이 함수를 쓴다(remote-NEW-3).
 */
export function nicknameOf(nicks: NickMap, alias: string): string | undefined {
  return Object.hasOwn(nicks, alias) ? nicks[alias] : undefined;
}

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
  else showError("toast.setNicknameFailed", r.error);
}
