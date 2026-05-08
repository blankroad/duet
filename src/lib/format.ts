/**
 * 사람-친화 포맷 헬퍼 모음.
 */

/**
 * 사이즈를 사람-친화 포맷으로.
 * 1023 B, 1.0 KB, 1.5 MB, ...
 */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let val = bytes / 1024;
  let unit = 0;
  while (val >= 1024 && unit < units.length - 1) {
    val /= 1024;
    unit++;
  }
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * Unix epoch ms를 사람-친화 시간으로.
 * 오늘이면 "14:32", 올해면 "Apr 12", 그 외 "2024-06-01"
 */
export function formatTime(ms: number | null | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toTimeString().slice(0, 5);
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toISOString().slice(0, 10);
}
