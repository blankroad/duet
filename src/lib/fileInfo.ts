import type { Entry } from "@/types/bindings";

/** 확장자 → 사람-친화 종류 라벨. 없으면 "<EXT> file" / "File". */
const EXT_LABEL: Record<string, string> = {
  pdf: "PDF document",
  png: "PNG image",
  jpg: "JPEG image",
  jpeg: "JPEG image",
  gif: "GIF image",
  webp: "WebP image",
  avif: "AVIF image",
  svg: "SVG image",
  bmp: "Bitmap image",
  ico: "Icon",
  mp4: "MP4 video",
  m4v: "MP4 video",
  webm: "WebM video",
  mov: "QuickTime video",
  mkv: "Matroska video",
  mp3: "MP3 audio",
  m4a: "AAC audio",
  aac: "AAC audio",
  wav: "WAV audio",
  ogg: "Ogg audio",
  opus: "Opus audio",
  flac: "FLAC audio",
  zip: "ZIP archive",
  tar: "Tar archive",
  gz: "Gzip archive",
  tgz: "Tar.gz archive",
  md: "Markdown",
  markdown: "Markdown",
  txt: "Plain text",
  log: "Log",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  csv: "CSV",
  js: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  jsx: "JavaScript",
  rs: "Rust source",
  py: "Python source",
  go: "Go source",
  c: "C source",
  h: "C header",
  cpp: "C++ source",
  java: "Java source",
  sh: "Shell script",
  html: "HTML",
  css: "CSS",
};

/**
 * 파일명을 stem + 확장자로 분리 (TC 식 확장자 컬럼용). 디렉토리/도트파일/확장자없음은
 * ext="" 로 (이름 전체가 stem). 예: "a.tar.gz" → {stem:"a.tar", ext:"gz"},
 * ".bashrc" → {stem:".bashrc", ext:""}, "Makefile" → {stem:"Makefile", ext:""}.
 */
export function splitNameExt(
  name: string,
  isDir: boolean,
): { stem: string; ext: string } {
  if (isDir) return { stem: name, ext: "" };
  const dot = name.lastIndexOf(".");
  // dot<=0: 확장자 없음 또는 선두 도트(.bashrc) → 분리 안 함. 끝 도트도 분리 안 함.
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

/** entry 의 종류 라벨 (Folder / 확장자 기반 / Symlink 등). */
export function kindLabel(entry: Entry): string {
  if (entry.kind === "dir") return "Folder";
  if (entry.kind === "symlink") return "Alias (symlink)";
  if (entry.kind === "other") return "Special file";
  const dot = entry.name.lastIndexOf(".");
  const ext = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
  if (EXT_LABEL[ext]) return EXT_LABEL[ext];
  return ext ? `${ext.toUpperCase()} file` : "File";
}

/** Unix mode(8진) → `rw-r--r-- · 644`. null(예: Windows)이면 "—". */
export function formatPerms(mode: number | null): string {
  if (mode == null) return "—";
  const m = mode & 0o777;
  const part = (n: number) =>
    `${n & 4 ? "r" : "-"}${n & 2 ? "w" : "-"}${n & 1 ? "x" : "-"}`;
  return `${part((m >> 6) & 7)}${part((m >> 3) & 7)}${part(m & 7)} · ${m.toString(8).padStart(3, "0")}`;
}

/** 항목 목록 → {files, folders, totalSize}. 폴더는 size 가 없어 합산에서 제외(파일만). */
export function summarizeEntries(entries: Entry[]): {
  files: number;
  folders: number;
  totalSize: number;
} {
  let files = 0;
  let folders = 0;
  let totalSize = 0;
  for (const e of entries) {
    if (e.kind === "dir") folders++;
    else files++;
    if (e.size != null) totalSize += e.size;
  }
  return { files, folders, totalSize };
}

/** {files, folders} → "12 files, 3 folders" / "12 files" / "3 folders" / "empty". */
export function countLabel(files: number, folders: number): string {
  const parts: string[] = [];
  if (files) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "empty";
}

/** epoch ms → 전체 날짜시간 (인스펙터용). null 이면 "—". */
export function formatFullDate(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
