import { create } from "zustand";
import { commands } from "@/types/bindings";
import type { Place, Volume, SourceId, ConnectionId } from "@/types/bindings";

/**
 * Places(Home/Desktop/…) + Volumes 를 **소스별**로 캐시.
 * 로컬은 `"local"`, 원격은 connection_id 를 키로. 사이드바는 활성 패널의 소스로 선택.
 * backend 가 OS별(로컬: `dirs`, 원격: SFTP) 해석.
 */
interface SourceData {
  places: Place[];
  volumes: Volume[];
}

interface State {
  bySource: Record<string, SourceData>;
  setData: (key: string, data: SourceData) => void;
  setVolumes: (key: string, volumes: Volume[]) => void;
  evict: (key: string) => void;
}

/** SourceId → 캐시 키. 로컬은 `"local"`, 원격은 connection_id. */
export function sourceKey(source: SourceId): string {
  return source.kind === "local" ? "local" : source.connection_id;
}

export const usePlaces = create<State>((set) => ({
  bySource: {},
  setData: (key, data) => set((s) => ({ bySource: { ...s.bySource, [key]: data } })),
  setVolumes: (key, volumes) =>
    set((s) => ({
      bySource: {
        ...s.bySource,
        [key]: { places: s.bySource[key]?.places ?? [], volumes },
      },
    })),
  evict: (key) =>
    set((s) => {
      const next = { ...s.bySource };
      delete next[key];
      return { bySource: next };
    }),
}));

/** 로컬 Places/Volumes 초기 로드. */
export async function bootstrapPlaces(): Promise<void> {
  const [p, v] = await Promise.all([commands.places(), commands.volumes()]);
  usePlaces.getState().setData("local", {
    places: p.status === "ok" ? p.data : [],
    volumes: v.status === "ok" ? v.data : [],
  });
}

/** 원격 호스트 Places/Volumes 로드 — 연결 open 시 1회. */
export async function loadRemotePlaces(connectionId: ConnectionId): Promise<void> {
  const [p, v] = await Promise.all([
    commands.sshPlaces(connectionId),
    commands.sshVolumes(connectionId),
  ]);
  usePlaces.getState().setData(connectionId, {
    places: p.status === "ok" ? p.data : [],
    volumes: v.status === "ok" ? v.data : [],
  });
}

/** 원격 호스트 캐시 제거 — 연결 close 시. */
export function evictRemotePlaces(connectionId: ConnectionId): void {
  usePlaces.getState().evict(connectionId);
}

/** 로컬 볼륨 새로고침 (마운트/언마운트 반영). */
export async function refreshVolumes(): Promise<void> {
  const v = await commands.volumes();
  if (v.status === "ok") usePlaces.getState().setVolumes("local", v.data);
}

/** 원격 볼륨 새로고침 (on-demand). */
export async function refreshRemoteVolumes(connectionId: ConnectionId): Promise<void> {
  const v = await commands.sshVolumes(connectionId);
  if (v.status === "ok") usePlaces.getState().setVolumes(connectionId, v.data);
}
