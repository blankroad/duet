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
import { platform } from "@tauri-apps/plugin-os";
import type { Entry } from "@/types/bindings";
import { paletteIcon } from "@/lib/iconPalette";
import { extOf } from "@/lib/fileInfo";
import { useAppSettings } from "@/stores/settings";
import { useOsFileIcon } from "@/stores/fileIcons";

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
  "ps1",
  "psm1",
  "bat",
  "cmd",
  "zig",
  "nim",
  "hs",
  "elm",
  "erl",
  "asm",
  "s",
  "ipynb",
  "sol",
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
  "conf",
  "cfg",
  "properties",
  "plist",
  "reg",
  "hcl",
  "tfvars",
  "lock",
  "pcap",
  "pcapng",
  "cap",
  "db",
  "sqlite",
  "sqlite3",
  "dump",
  "har",
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
  "srt",
  "vtt",
  "sub",
  "nfo",
  "readme",
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
  "vhd",
  "vmdk",
  "img",
  "qcow2",
  "ova",
  "vdi",
  "sys",
  "ko",
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
  "jks",
  "keystore",
  "der",
  "p7b",
  "ovpn",
  "kdbx",
]);
register({ Icon: FileType, className: "text-icon-font" }, [
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
]);

/**
 * 확장자가 없는(또는 점으로 시작하는) 잘 알려진 파일명 → 아이콘. 소문자 전체 이름 기준.
 * Makefile / Dockerfile / .gitignore / README 처럼 extOf 가 빈 문자열을 주는 것들.
 */
const NAME_ICON: Record<string, IconDesc> = {};
const registerName = (desc: IconDesc, names: string[]) => {
  for (const n of names) NAME_ICON[n.toLowerCase()] = desc;
};

registerName({ Icon: FileCode, className: "text-icon-code" }, [
  "makefile",
  "gnumakefile",
  "dockerfile",
  "containerfile",
  "rakefile",
  "gemfile",
  "procfile",
  "vagrantfile",
  "jenkinsfile",
  "brewfile",
  "justfile",
  "cmakelists.txt",
  "build",
  "workspace",
  ".bashrc",
  ".zshrc",
  ".bash_profile",
  ".zprofile",
  ".profile",
  ".vimrc",
]);
registerName({ Icon: FileJson, className: "text-icon-data" }, [
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".gitconfig",
  ".dockerignore",
  ".npmrc",
  ".nvmrc",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".babelrc",
  ".env",
  ".netrc",
  ".bazelrc",
  ".npmignore",
  ".eslintignore",
  ".prettierignore",
]);
registerName({ Icon: FileText, className: "text-icon-doc" }, [
  "readme",
  "license",
  "licence",
  "copying",
  "copyright",
  "authors",
  "changelog",
  "contributing",
  "notice",
  "todo",
  "news",
  "install",
  "codeowners",
  "maintainers",
]);

/**
 * entry 종류에 맞는 lucide 아이콘 컴포넌트 + 색 토큰 클래스.
 *
 * 우선순위: 디렉토리/심볼릭 → 유저 지정 override(설정) → 내장 확장자 매핑 → 기본 File.
 * `overrides` 는 확장자(소문자, 점 없음) → 팔레트 아이콘 이름.
 */
export function iconForEntry(
  entry: Entry,
  overrides?: Record<string, string>,
): IconDesc {
  if (entry.kind === "dir") return { Icon: Folder, className: "text-accent" };
  if (entry.kind === "symlink")
    return { Icon: LinkIcon, className: "text-fg-muted" };
  const ext = extOf(entry.name);
  const overrideName = overrides?.[ext];
  if (overrideName) {
    const desc = paletteIcon(overrideName);
    if (desc) return desc;
  }
  // 확장자 없는 잘 알려진 파일명 (Makefile, Dockerfile, .gitignore, README 등).
  const named = NAME_ICON[entry.name.toLowerCase()];
  if (named) return named;
  return EXT_ICON[ext] ?? { Icon: File, className: "text-fg-muted" };
}

/** platform() 은 tauri 런타임 필요 — 1회 lazy 판정, 테스트/비-tauri 환경은 false. */
let winCached: boolean | null = null;
export function isWindows(): boolean {
  if (winCached === null) {
    try {
      winCached = platform() === "windows";
    } catch {
      winCached = false;
    }
  }
  return winCached;
}

/**
 * 바로 렌더 가능한 아이콘 엘리먼트. flex 안에서 긴 파일명이 밀어 줄어들지 않게 shrink-0.
 *
 * `localPath` (로컬 절대경로) 가 오고 설정(osFileIcons)이 켜져 있으면 Windows 로컬
 * 파일은 OS 네이티브 아이콘(탐색기 동일)을 표시. 유저 확장자 override 는 명시 의도라
 * OS 아이콘보다 우선. 원격/폴더/로딩 전/실패는 내장 글리프.
 */
export function EntryIcon({
  entry,
  size,
  localPath,
}: {
  entry: Entry;
  size: number;
  /** OS 아이콘 조회용 로컬 절대경로 — 원격/미상이면 생략(글리프). */
  localPath?: string | null;
}) {
  // 유저 지정 확장자 아이콘은 설정 캐시에서 — 변경 시 가상 스크롤의 보이는 행만 리렌더.
  const overrides = useAppSettings((s) => s.extIconOverrides);
  const osIcons = useAppSettings((s) => s.osFileIcons);
  const wantOs =
    osIcons &&
    entry.kind === "file" &&
    !!localPath &&
    !overrides?.[extOf(entry.name)] &&
    isWindows();
  const osUrl = useOsFileIcon(
    wantOs ? (localPath ?? null) : null,
    entry.name,
    size,
  );
  if (osUrl) {
    return (
      <img
        src={osUrl}
        alt=""
        draggable={false}
        className="shrink-0 object-contain"
        style={{ width: size, height: size }}
      />
    );
  }
  const { Icon, className } = iconForEntry(entry, overrides);
  return <Icon size={size} className={`shrink-0 ${className}`} />;
}
