import {
  Folder,
  FileText,
  FileCode,
  FileJson,
  FileImage,
  FileAudio,
  FileVideo,
  FileArchive,
  FileSpreadsheet,
  FileCog,
  FileKey,
  FileType,
  File,
  Link as LinkIcon,
  type LucideIcon,
} from "lucide-react";
import type { Entry } from "@/types/bindings";

/**
 * 파일 종류별 아이콘 매핑 — EntryRow / EntryGrid / 미리보기 헤더 공유.
 *
 * 색은 테마 토큰만 사용 (CLAUDE.md: 색상 하드코딩 금지). 종류 구분은 *글리프 모양*
 * 으로 — 강조색 ≤ 토큰 규칙을 유지하면서도 디렉토리=accent, 그 외=muted.
 */

/** 확장자 그룹 → lucide 아이콘. 소문자 확장자 기준. */
const EXT_ICON: Record<string, LucideIcon> = {};
const register = (icon: LucideIcon, exts: string[]) => {
  for (const e of exts) EXT_ICON[e] = icon;
};

register(FileCode, [
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "cc",
  "hpp",
  "rb",
  "php",
  "swift",
  "scala",
  "sh",
  "bash",
  "zsh",
  "fish",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "lua",
  "dart",
]);
register(FileJson, [
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "xml",
  "ini",
  "env",
]);
register(FileText, [
  "txt",
  "md",
  "markdown",
  "rst",
  "rtf",
  "doc",
  "docx",
  "odt",
  "pdf",
  "log",
  "tex",
]);
register(FileImage, [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "tiff",
  "tif",
  "heic",
  "avif",
]);
register(FileAudio, ["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus"]);
register(FileVideo, [
  "mp4",
  "mkv",
  "mov",
  "avi",
  "webm",
  "flv",
  "wmv",
  "m4v",
  "mpg",
  "mpeg",
]);
register(FileArchive, [
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "zst",
  "7z",
  "rar",
  "lz4",
]);
register(FileSpreadsheet, ["csv", "tsv", "xls", "xlsx", "ods"]);
register(FileCog, [
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "app",
  "deb",
  "rpm",
  "dmg",
  "msi",
  "appimage",
  "o",
  "wasm",
]);
register(FileKey, [
  "pem",
  "key",
  "crt",
  "cert",
  "cer",
  "pub",
  "gpg",
  "asc",
  "p12",
  "pfx",
]);
register(FileType, ["ttf", "otf", "woff", "woff2", "eot"]);

/** name 에서 소문자 확장자 추출 (표시 전용 — 경로 조작 아님). */
function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** entry 종류에 맞는 lucide 아이콘 컴포넌트 + 색 토큰 클래스. */
export function iconForEntry(entry: Entry): {
  Icon: LucideIcon;
  className: string;
} {
  if (entry.kind === "dir") return { Icon: Folder, className: "text-accent" };
  if (entry.kind === "symlink")
    return { Icon: LinkIcon, className: "text-fg-muted" };
  const Icon = EXT_ICON[extOf(entry.name)] ?? File;
  return { Icon, className: "text-fg-muted" };
}

/** 바로 렌더 가능한 아이콘 엘리먼트. flex 안에서 긴 파일명이 밀어 줄어들지 않게 shrink-0. */
export function EntryIcon({ entry, size }: { entry: Entry; size: number }) {
  const { Icon, className } = iconForEntry(entry);
  return <Icon size={size} className={`shrink-0 ${className}`} />;
}
