/**
 * 프론트엔드 아카이브 확장자 판정 — 우클릭 메뉴에 "Extract" 노출 여부 결정용.
 * 실제 포맷 판정/해제는 백엔드(core::archive)가 담당 (단일 진실). 여기서는
 * 메뉴 가시성만 위해 동일한 확장자 집합을 가볍게 검사한다.
 */
// .7z/.rar 는 읽기 전용(browse/extract, 로컬 전용) — 원격/repack 은 백엔드가 명시 거부.
const ARCHIVE_SUFFIXES = [".tar.gz", ".tgz", ".tar", ".zip", ".gz", ".7z", ".rar"] as const;

/** name 이 지원 아카이브 확장자로 끝나면 true. */
export function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_SUFFIXES.some((s) => lower.endsWith(s));
}
