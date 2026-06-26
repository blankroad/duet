import { create } from "zustand";
import { commands } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";

/** key → 태그 목록. 백엔드 tags.json 미러. key = `host:<alias>` / `bm:<id>` / `fav:<id>`. */
export type TagMap = Partial<Record<string, string[]>>;

interface State {
  byKey: TagMap;
  setAll: (m: TagMap) => void;
}

export const useTags = create<State>((set) => ({
  byKey: {},
  setAll: (byKey) => set({ byKey }),
}));

export async function bootstrapTags(): Promise<void> {
  const r = await commands.tagList();
  if (r.status === "ok") useTags.getState().setAll(r.data);
}

/** 한 키의 태그 교체(백엔드가 trim·dedup·빈값제거). 반환 맵으로 정합. */
export async function setTags(key: string, tags: string[]): Promise<void> {
  const r = await commands.tagSet(key, tags);
  if (r.status === "ok") useTags.getState().setAll(r.data);
  else useToast.getState().show(`Set tags: ${formatErr(r.error)}`);
}

/** 키의 태그 목록(없으면 빈 배열). */
export function tagsFor(byKey: TagMap, key: string): string[] {
  return byKey[key] ?? [];
}

/** 전체 태그 이름(정렬·유일). 필터 칩바용. */
export function allTagNames(byKey: TagMap): string[] {
  const set = new Set<string>();
  for (const k in byKey) for (const t of byKey[k] ?? []) set.add(t);
  return [...set].sort();
}

/** 활성 필터(OR) 매칭 — 필터 없으면 항상 통과. */
export function matchesTagFilter(itemTags: string[], active: string[]): boolean {
  if (active.length === 0) return true;
  return active.some((t) => itemTags.includes(t));
}

/** 쉼표 구분 입력으로 태그 편집(프롬프트). 취소(null)면 무시. */
export function editTagsPrompt(key: string, current: string[]): void {
  const next = window.prompt("Tags (comma-separated):", current.join(", "));
  if (next === null) return;
  void setTags(
    key,
    next
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );
}

// ── 키 빌더 ───────────────────────────────────────────────────────────────
export const hostTagKey = (alias: string): string => `host:${alias}`;
export const bmTagKey = (id: string): string => `bm:${id}`;
export const favTagKey = (id: string): string => `fav:${id}`;
