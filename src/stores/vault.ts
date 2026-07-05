import { create } from "zustand";
import { commands } from "@/types/bindings";

/**
 * Master-password vault state mirror (백엔드 SecretVault).
 *
 * `exists` = disk 에 vault 파일 있음 / `unlocked` = 메모리에 master 캐시됨.
 * 새 master 만들기: `exists=false` 인 상태에서 unlock 호출 → 첫 set 시 파일 생성.
 *
 * CLAUDE.md §5 — master / 평문 password 는 절대 frontend store 에 보관 X.
 * 이 store 는 status 만 추적, 실제 password 는 매번 backend 에서 fetch.
 */
interface State {
  exists: boolean;
  unlocked: boolean;
  refresh: () => Promise<void>;
}

export const useVault = create<State>((set) => ({
  exists: false,
  unlocked: false,
  refresh: async () => {
    const r = await commands.vaultStatus();
    if (r.status === "ok") set({ exists: r.data.exists, unlocked: r.data.unlocked });
  },
}));

/** master passphrase 로 unlock. 성공 시 store status 갱신 + true 반환. */
export async function vaultUnlock(passphrase: string): Promise<boolean> {
  const r = await commands.vaultUnlock(passphrase);
  if (r.status === "ok") {
    await useVault.getState().refresh();
    return true;
  }
  return false;
}

/** alias → password 저장. vault 가 unlocked 여야 함. */
export async function vaultSet(alias: string, password: string): Promise<boolean> {
  const r = await commands.vaultSet(alias, password);
  if (r.status === "ok") {
    await useVault.getState().refresh(); // exists=true 갱신
    return true;
  }
  return false;
}

/**
 * alias 에 저장된 비밀번호가 **있는지만** 확인(평문 노출 없음, §5 2026-07).
 * 실제 비번은 backend 가 접속 command 안에서 vault 에서 직접 꺼내 쓴다 —
 * 프론트로 평문을 되돌리지 않는다.
 */
export async function vaultHas(alias: string): Promise<boolean> {
  const r = await commands.vaultHas(alias);
  return r.status === "ok" ? r.data : false;
}

export async function vaultRemove(alias: string): Promise<void> {
  await commands.vaultRemove(alias);
}

export async function vaultLock(): Promise<void> {
  await commands.vaultLock();
  await useVault.getState().refresh();
}
