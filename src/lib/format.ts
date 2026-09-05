/**
 * 사람-친화 포맷 헬퍼 모음. 표기 규칙은 설정(size_units / date_format)을 따른다.
 */

/** 크기 표기 방식 — backend `size_units` 미러. */
export type SizeUnits = "binary" | "decimal" | "bytes";
/** 날짜 표기 방식 — backend `date_format` 미러. */
export type DateFormat = "relative" | "locale" | "iso";

/**
 * 모듈 지역 설정 — 목록의 모든 행이 매 렌더 store 를 읽지 않도록 값만 캐시한다.
 * `syncAppSettings` 가 부팅·저장 시 갱신.
 */
let sizeUnits: SizeUnits = "binary";
let dateFormat: DateFormat = "relative";

export function setFormatOptions(units: SizeUnits, date: DateFormat): void {
  sizeUnits = units;
  dateFormat = date;
}

const BINARY_UNITS = ["KiB", "MiB", "GiB", "TiB", "PiB"];
const DECIMAL_UNITS = ["kB", "MB", "GB", "TB", "PB"];

/**
 * 사이즈를 사람-친화 포맷으로.
 *
 * 예전에는 1024 로 나누면서 라벨은 KB/MB 로 붙여 파인더·탐색기 값과 어긋났다
 * ("왜 duet 은 더 작게 나오지?"). 이제 나누는 값과 라벨이 항상 일치한다.
 */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (sizeUnits === "bytes") return `${bytes.toLocaleString()} B`;
  const base = sizeUnits === "decimal" ? 1000 : 1024;
  const units = sizeUnits === "decimal" ? DECIMAL_UNITS : BINARY_UNITS;
  if (bytes < base) return `${bytes} B`;
  let val = bytes / base;
  let unit = 0;
  while (val >= base && unit < units.length - 1) {
    val /= base;
    unit++;
  }
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * Unix epoch ms를 사람-친화 시간으로.
 * relative: 오늘이면 "14:32", 올해면 "Apr 12", 그 외 "2024-06-01"
 * locale: OS 형식 / iso: "2024-06-01 14:32"
 */
export function formatTime(ms: number | null | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  if (dateFormat === "iso") {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (dateFormat === "locale") {
    return d.toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  }
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toTimeString().slice(0, 5);
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toISOString().slice(0, 10);
}
