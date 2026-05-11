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

export function useAllCommands(): Command[] {
  return useCommands((s) => [...s.builtins, ...s.dynamic]);
}
