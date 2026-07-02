import { useEffect } from "react";
import { create } from "zustand";
import { commands } from "@/types/bindings";
import { bytesToPngDataUrl } from "./appIcons";
import { extOf } from "@/lib/fileInfo";

/**
 * 파일 목록 OS 아이콘 캐시 — Windows 로컬 파일의 연결 프로그램 아이콘(PNG)을
 * backend(`fileIcon`)에서 추출해 data URL 로 보관 (탐색기와 동일한 타입 아이콘).
 *
 * 캐시 키: 대부분 타입은 아이콘이 확장자에 종속이라 `ext:<확장자>` — 디렉토리당
 * IPC 가 확장자 가짓수만큼만 나간다. 자기(임베드) 아이콘을 가질 수 있는 타입
 * (exe/lnk/ico 등)만 `path:<절대경로>`. 실패/미지원(non-Windows)은 null 로 확정
 * 캐시하고 재시도하지 않으며, 표시 측(EntryIcon)은 내장 글리프로 fallback.
 */
interface State {
  icons: Record<string, string | null>;
}

const useStore = create<State>(() => ({ icons: {} }));

/** 동일 키 중복 호출 방지(in-flight). */
const inflight = new Set<string>();

/** 추출 소스 px — 행(14px)·그리드 아이콘 공용, hidpi 여유 포함. */
const ICON_PX = 32;

/** 파일별(임베드) 아이콘 가능 확장자 — 경로 단위 캐시 대상. 나머지는 확장자 단위. */
const OWN_ICON_EXTS = new Set(["exe", "lnk", "ico", "scr", "url", "cur", "ani"]);

function cacheKey(path: string, name: string): string {
  const ext = extOf(name);
  return OWN_ICON_EXTS.has(ext) ? `path:${path}` : `ext:${ext}`;
}

/** key 의 아이콘을 최초 1회 추출해 캐시 (실패는 null 로 확정 캐시). */
function load(key: string, path: string): void {
  if (key in useStore.getState().icons || inflight.has(key)) return;
  inflight.add(key);
  void commands.fileIcon(path, ICON_PX).then((r) => {
    inflight.delete(key);
    let url: string | null = null;
    if (r.status === "ok" && r.data.length > 0) {
      try {
        url = bytesToPngDataUrl(r.data);
      } catch {
        url = null;
      }
    }
    useStore.setState((s) => ({ icons: { ...s.icons, [key]: url } }));
  });
}

/** 로컬 절대경로의 OS 아이콘 data URL 구독 — 미로드면 로드 트리거. path null 이면 null. */
export function useOsFileIcon(
  path: string | null,
  name: string,
): string | null {
  const key = path ? cacheKey(path, name) : null;
  const url = useStore((s) => (key ? (s.icons[key] ?? null) : null));
  useEffect(() => {
    if (key && path) load(key, path);
  }, [key, path]);
  return url;
}
