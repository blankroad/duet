import type { Location } from "@/types/bindings";
import { childLocation, sameLocationDir } from "@/lib/entryDnd";

/**
 * 이 앱 목록에서 시작한 **OS 네이티브 드래그** 기록.
 *
 * 로컬 항목을 끌면 OS 드래그로 넘겨서, 같은 창에 다시 놓아도 "바깥에서 온 파일"처럼
 * 들어온다(useOsFileDrop). 인앱 드래그에 있던 "같은 폴더/자기 자신에 놓기" 방어가 이
 * 경로엔 없어, 살짝 끌었다 놓기만 해도 자기 자신과 충돌하는 복사 확인 창이 떴다.
 * 드롭된 경로 목록이 방금 시작한 드래그와 같을 때만 우리 드래그로 본다.
 */
let last: {
  paths: string[];
  source: Location;
  names: string[];
  at: number;
} | null = null;

/** 드래그가 오래 걸려도(다른 창을 오가다 돌아옴) 기록을 지키는 시간. */
const TTL_MS = 5 * 60 * 1000;

export function rememberSelfDrag(
  paths: string[],
  source: Location,
  names: string[],
): void {
  last = { paths: [...paths].sort(), source, names, at: Date.now() };
}

/**
 * 이 드롭이 방금 우리가 시작한 드래그를 원래 폴더나 끈 폴더 자신에게 놓은 것인가.
 * 맞으면 "same"(같은 폴더) / "self"(자기 자신 안), 아니면 null.
 */
export function selfDropKind(
  paths: string[],
  dst: Location,
): "same" | "self" | null {
  if (!last || Date.now() - last.at > TTL_MS) return null;
  const sorted = [...paths].sort();
  if (
    sorted.length !== last.paths.length ||
    sorted.some((p, i) => p !== last!.paths[i])
  )
    return null;
  if (sameLocationDir(last.source, dst)) return "same";
  const src = last.source;
  if (last.names.some((n) => sameLocationDir(childLocation(src, n), dst)))
    return "self";
  return null;
}
