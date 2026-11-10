import type { Location } from "@/types/bindings";

/**
 * 원격(SSH)이 낀 비교의 최소 mtime 허용오차.
 *
 * SFTP 는 수정 시각을 초 단위로만 주고 로컬은 ms 까지 준다. 허용오차 0 이면 같은 파일도
 * 1초 미만 차이로 "더 최신"이 되어 기본 방향이 덮어쓰기로 잡힌다(SC-11).
 * 2초는 FAT/zip 의 2초 정밀도까지 흡수한다.
 */
export const REMOTE_MIN_TOLERANCE_MS = 2000;

/** 두 쪽 중 하나라도 원격(SSH)인가. */
export function hasRemoteSide(left: Location, right: Location): boolean {
  return left.source.kind === "ssh" || right.source.kind === "ssh";
}

/**
 * 비교를 시작할 때 쓸 허용오차. 원격이 끼면 저장값이 2초보다 작아도 2초로 올린다.
 * 로컬↔로컬은 저장값 그대로(기본 0).
 */
export function initialTolerance(saved: number, remote: boolean): number {
  return remote ? Math.max(saved, REMOTE_MIN_TOLERANCE_MS) : saved;
}
