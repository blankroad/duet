import { create } from "zustand";
import { commands } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";
import type { KeymapBinding } from "@/types/bindings";

interface State {
  bindings: KeymapBinding[];
  setAll: (b: KeymapBinding[]) => void;
}

export const useKeymap = create<State>((set) => ({
  bindings: [],
  setAll: (bindings) => set({ bindings }),
}));

/**
 * 이 명령을 **실제로** 실행하는 키 — 디스패처(`resolveKeyCommand`)와 같은 규칙.
 *
 * - 사용자 지정(override)이 있으면 그 키만 (기본 키는 꺼진다 — 편집 = 교체).
 * - 없으면 기본 키. 단 그 기본 키를 다른 명령의 사용자 지정이 가져갔으면 없음:
 *   예전엔 가려진 기본 키를 툴팁·팔레트가 계속 보여 "눌러도 안 되는 키"를 가르쳤다.
 */
export function effectiveKey(
  commandId: string,
  bindings: KeymapBinding[],
  defaultKey?: string,
): string | undefined {
  const override = bindings.find((b) => b.command_id === commandId);
  if (override) return override.key;
  if (!defaultKey) return undefined;
  if (bindings.some((b) => b.key === defaultKey)) return undefined;
  return defaultKey;
}

/** 키 문자열이 가리킬 명령의 최소 모양 — `Command` 의 부분 집합. */
interface KeyedCommand {
  id: string;
  defaultKey?: string | undefined;
  altKeys?: string[] | undefined;
}

/**
 * 키 → 실행할 명령 id. 사용자 지정이 우선, 없으면 기본 키·보조 키 — 단 사용자
 * 지정이 있는 명령의 기본/보조 키는 더 이상 그 명령을 부르지 않는다(`effectiveKey`).
 */
export function resolveKeyCommand(
  keystr: string,
  bindings: KeymapBinding[],
  commands: KeyedCommand[],
): string | undefined {
  const bound = bindings.find((b) => b.key === keystr);
  if (bound) return bound.command_id;
  const rebound = new Set(bindings.map((b) => b.command_id));
  return commands.find(
    (c) =>
      !rebound.has(c.id) &&
      (c.defaultKey === keystr || c.altKeys?.includes(keystr)),
  )?.id;
}

/**
 * 기본 키를 다른 명령의 사용자 지정에 빼앗긴 경우 그 명령 id — 키맵 표가
 * "(없음)" 옆에 이유를 보여 준다.
 */
export function shadowedBy(
  commandId: string,
  bindings: KeymapBinding[],
  defaultKey?: string,
): string | undefined {
  if (!defaultKey) return undefined;
  if (bindings.some((b) => b.command_id === commandId)) return undefined;
  return bindings.find((b) => b.key === defaultKey)?.command_id;
}

export async function bootstrapKeymap(): Promise<void> {
  const r = await commands.keymapList();
  if (r.status === "ok") useKeymap.getState().setAll(r.data);
}

export async function setKeymap(
  key: string,
  commandId: string,
): Promise<boolean> {
  const r = await commands.keymapSet(key, commandId);
  if (r.status === "ok") {
    useKeymap.getState().setAll(r.data);
    return true;
  }
  useToast.getState().show(`Bind key: ${formatErr(r.error)}`, "error");
  return false;
}

export async function unsetKeymap(key: string): Promise<void> {
  const r = await commands.keymapUnset(key);
  if (r.status === "ok") useKeymap.getState().setAll(r.data);
  else useToast.getState().show(`Unbind key: ${formatErr(r.error)}`, "error");
}

export async function resetKeymap(): Promise<void> {
  const r = await commands.keymapReset();
  if (r.status === "ok") useKeymap.getState().setAll(r.data);
  else useToast.getState().show(`Reset keymap: ${formatErr(r.error)}`, "error");
}
