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
  Presentation,
  File,
  Link as LinkIcon,
  type LucideIcon,
} from "lucide-react";
import type { Entry } from "@/types/bindings";

/**
 * 파일 종류별 아이콘 + 색 매핑 — EntryRow / EntryGrid / 미리보기 헤더 공유.
 *
 * 종류 구분은 *글리프 모양*(lucide) + *색역*(globals.css `--icon-*`) 둘 다로 —
 * 윈도우 탐색기처럼 한눈에 종류를 구분. 색은 테마 토큰만 사용 (CLAUDE.md:
 * 색상 하드코딩 금지). `--icon-*` 는 UI 강조색(≤4)과 분리된 "파일 종류 구분
 * 전용 색역" (구문 강조 `--syntax-*` 와 동급의 스코프 팔레트 — DESIGN.md 색상 절).
 *
 * 디렉토리=accent. 시스템/바이너리·심볼릭·미지 확장자는 muted 로 차분하게 둔다.
 */

type IconDesc = { Icon: LucideIcon; className: string };

/** 확장자 그룹 → 아이콘 + 색 토큰. 소문자 확장자 기준. */
const EXT_ICON: Record<string, IconDesc> = {};
const register = (desc: IconDesc, exts: string[]) => {
  for (const e of exts) EXT_ICON[e] = desc;
};

register({ Icon: FileCode, className: "text-icon-code" }, [
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
  "sql",
  "r",
  "jl",
  "ex",
  "exs",
  "clj",
  "groovy",
  "gradle",
  "cmake",
  "mk",
  "mak",
  "proto",
  "graphql",
  "gql",
  "tf",
  "vim",
  "el",
]);
register({ Icon: Presentation, className: "text-icon-slides" }, [
  "ppt",
  "pptx",
  "pptm",
  "odp",
]);
register({ Icon: FileJson, className: "text-icon-data" }, [
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "xml",
  "ini",
  "env",
]);
register({ Icon: FileText, className: "text-icon-doc" }, [
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
  "epub",
  "mobi",
  "pages",
  "org",
]);
register({ Icon: FileImage, className: "text-icon-image" }, [
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
  "psd",
  "ai",
  "raw",
  "jfif",
]);
register({ Icon: FileAudio, className: "text-icon-audio" }, [
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "aac",
  "wma",
  "opus",
  "aiff",
  "mid",
  "midi",
]);
register({ Icon: FileVideo, className: "text-icon-video" }, [
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
  "3gp",
  "ogv",
  "m2ts",
]);
register({ Icon: FileArchive, className: "text-icon-archive" }, [
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
  "iso",
  "jar",
  "cab",
  "lz",
  "lzma",
]);
register({ Icon: FileSpreadsheet, className: "text-icon-sheet" }, [
  "csv",
  "tsv",
  "xls",
  "xlsx",
  "xlsm",
  "ods",
  "numbers",
]);
// 시스템/바이너리는 색을 빼고 muted — 클릭 빈도 낮고 시각 노이즈 줄임.
register({ Icon: FileCog, className: "text-fg-muted" }, [
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
register({ Icon: FileKey, className: "text-icon-key" }, [
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
register({ Icon: FileType, className: "text-icon-font" }, [
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
]);

/** name 에서 소문자 확장자 추출 (표시 전용 — 경로 조작 아님). */
function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** entry 종류에 맞는 lucide 아이콘 컴포넌트 + 색 토큰 클래스. */
export function iconForEntry(entry: Entry): IconDesc {
  if (entry.kind === "dir") return { Icon: Folder, className: "text-accent" };
  if (entry.kind === "symlink")
    return { Icon: LinkIcon, className: "text-fg-muted" };
  return (
    EXT_ICON[extOf(entry.name)] ?? { Icon: File, className: "text-fg-muted" }
  );
}

/** 바로 렌더 가능한 아이콘 엘리먼트. flex 안에서 긴 파일명이 밀어 줄어들지 않게 shrink-0. */
export function EntryIcon({ entry, size }: { entry: Entry; size: number }) {
  const { Icon, className } = iconForEntry(entry);
  return <Icon size={size} className={`shrink-0 ${className}`} />;
}
