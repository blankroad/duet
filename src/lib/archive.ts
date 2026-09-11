/**
 * 프론트엔드 아카이브 판정 — 우클릭 "압축 풀기"·더블클릭 내부 탐색·"Update archive"
 * 노출 여부 결정용. 실제 포맷 판정/해제는 백엔드(core::archive)가 담당 (단일 진실).
 * 아래 세 목록은 백엔드 `SUFFIXES` 표·능력과 같아야 하며 Rust 테스트
 * `frontend_archive_lists_match_backend` 가 대조한다 — 한쪽만 고치면 테스트가 깨진다.
 */
import type { SourceId } from "@/types/bindings";

/** 원격(SSH)에서도 해제·탐색되는 포맷 — 서버의 unzip/tar 로 처리(PC 경유 0). */
const REMOTE_SUFFIXES = [
  ".zip",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".tar.bz2",
  ".tbz2",
  ".tbz",
  ".tar.xz",
  ".txz",
  ".tar.zst",
  ".tzst",
] as const;

/** 로컬 전용 — 7z/rar(서버에 바이너리 보장 불가)와 단일 파일 압축. */
const LOCAL_ONLY_SUFFIXES = [
  ".7z",
  ".rar",
  ".gz",
  ".bz2",
  ".xz",
  ".zst",
] as const;

/** "Update archive"(편집 후 재압축) 가능 — 원본과 같은 포맷으로 다시 만들 수 있는 것만. */
const REPACK_SUFFIXES = [".zip", ".tar.gz", ".tgz"] as const;

// 긴 접미사부터 — "a.tar.gz" 가 ".gz"(단일 파일)로 오판되지 않게.
const ALL_SUFFIXES: readonly string[] = [
  ...REMOTE_SUFFIXES,
  ...LOCAL_ONLY_SUFFIXES,
].sort((a, b) => b.length - a.length);
const REMOTE = new Set<string>(REMOTE_SUFFIXES);
const REPACK = new Set<string>(REPACK_SUFFIXES);

/** name 에 맞는 가장 긴 아카이브 접미사(소문자). 아카이브가 아니면 null. */
function archiveSuffix(name: string): string | null {
  const lower = name.toLowerCase();
  return ALL_SUFFIXES.find((s) => lower.endsWith(s)) ?? null;
}

/** 이 위치에서 해제·내부 탐색이 가능한지 — 원격은 서버 unzip/tar 로 풀리는 포맷만. */
export function canExtractArchive(name: string, source: SourceId): boolean {
  const suffix = archiveSuffix(name);
  if (suffix === null) return false;
  return source.kind === "local" || REMOTE.has(suffix);
}

/** 아카이브 내부 탐색 중 "Update archive"(repack) 가능 여부 — `.zip` / `.tar.gz` 만. */
export function canRepackArchive(name: string): boolean {
  const suffix = archiveSuffix(name);
  return suffix !== null && REPACK.has(suffix);
}
