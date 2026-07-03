import { useEffect } from "react";
import { create } from "zustand";
import { commands } from "@/types/bindings";

/**
 * 앱 런처 아이콘 캐시 — path 별 OS 네이티브 아이콘(PNG)을 backend(`fileIcon`)에서
 * 1회 추출해 data URL 로 보관. 실패/미지원(non-Windows)은 `null` 로 캐시하고
 * 재시도하지 않으며, 표시 측은 모노그램으로 fallback 한다.
 *
 * 키는 앱 절대경로. `icons[path]` === undefined = 미로드, string = 아이콘,
 * null = 아이콘 없음(모노그램).
 */
interface State {
  icons: Record<string, string | null>;
}

const useStore = create<State>(() => ({ icons: {} }));

/** 동일 path 중복 호출 방지(in-flight). */
const inflight = new Set<string>();

/** 추출 소스 px — 표시(16~20px) × hidpi(~200%) 커버. GetImage 라 실제 64px 아트. */
const ICON_PX = 64;

/** Vec<u8>(number[]) PNG → data URL. 아이콘은 수 KB 라 단순 루프로 충분. */
export function bytesToPngDataUrl(bytes: number[]): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(bin)}`;
}

/** path 의 아이콘을 최초 1회 추출해 캐시 (실패는 null 로 확정 캐시). */
export function loadAppIcon(path: string): void {
  const st = useStore.getState();
  if (path in st.icons || inflight.has(path)) return;
  inflight.add(path);
  void commands.fileIcon(path, ICON_PX).then((r) => {
    inflight.delete(path);
    let url: string | null = null;
    if (r.status === "ok" && r.data.length > 0) {
      try {
        url = bytesToPngDataUrl(r.data);
      } catch {
        url = null;
      }
    }
    useStore.setState((s) => ({ icons: { ...s.icons, [path]: url } }));
  });
}

/** 아이콘 data URL 구독 + 마운트 시 로드 트리거. 미로드/없음/미지원이면 null. */
export function useAppIcon(path: string | null | undefined): string | null {
  const url = useStore((s) => (path ? (s.icons[path] ?? null) : null));
  useEffect(() => {
    if (path) loadAppIcon(path);
  }, [path]);
  return url;
}
