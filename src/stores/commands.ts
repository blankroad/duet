import { useMemo } from "react";
import { create } from "zustand";
import type { Command } from "@/lib/commands";

interface State {
  builtins: Command[];
  dynamic: Command[];
  setBuiltins: (cs: Command[]) => void;
  setDynamic: (cs: Command[]) => void;
}

export const useCommands = create<State>((set) => ({
  builtins: [],
  dynamic: [],
  setBuiltins: (cs) => set({ builtins: cs }),
  setDynamic: (cs) => set({ dynamic: cs }),
}));

/**
 * builtins + dynamic 합친 array.
 *
 * **중요**: selector 안에서 spread (`[...a, ...b]`) 하면 매 render 새 array
 * 가 반환되어 zustand Object.is 비교 실패 → 무한 re-render 루프. 그래서
 * 두 selector 분리 + useMemo 로 결합 (변경 있을 때만 새 array).
 */
export function useAllCommands(): Command[] {
  const builtins = useCommands((s) => s.builtins);
  const dynamic = useCommands((s) => s.dynamic);
  return useMemo(() => [...builtins, ...dynamic], [builtins, dynamic]);
}
