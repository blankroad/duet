/**
 * 경로 표시용 헬퍼. 구분자는 POSIX(`/`)·Windows(`\`) 둘 다 인식한다 —
 * Windows 역슬래시 경로에서 basename 이 전체 경로로 새지 않게 하기 위함.
 *
 * 주의(CLAUDE.md §7): 여기 함수들은 **화면 표시용**(라벨/탭 제목/기본 이름)
 * 전용이다. 실제 경로 결합/조작/검증은 백엔드(Rust `Path`)가 권위를 가지며,
 * 프론트는 절대 경로를 직접 만들지 않는다.
 */

/** 경로를 세그먼트 배열로 분해 (빈 조각 제거). 구분자 `/`·`\` 모두 인식. */
export function pathSegments(path: string): string[] {
  return String(path)
    .split(/[/\\]/)
    .filter(Boolean);
}

/**
 * 경로의 마지막 세그먼트(파일/폴더 표시 이름).
 * 세그먼트가 없으면(루트 등) `fallback` 을 반환한다 (기본값 `"/"`).
 */
export function basename(path: string, fallback = "/"): string {
  return pathSegments(path).pop() ?? fallback;
}
