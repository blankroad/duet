import {
  FileCode,
  FileJson,
  FileText,
  FileImage,
  FileAudio,
  FileVideo,
  FileArchive,
  FileSpreadsheet,
  FileCog,
  FileKey,
  FileType,
  File,
  Presentation,
  Terminal,
  Database,
  BookOpen,
  Package,
  Globe,
  Lock,
  Star,
  Heart,
  Music,
  Film,
  Camera,
  Box,
  Cpu,
  HardDrive,
  Cog,
  Binary,
  Image as ImageIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * 유저가 "확장자 → 아이콘" 을 지정할 때 고르는 팔레트.
 *
 * 각 항목은 *모양*(lucide) + 어울리는 *색 토큰*(text-icon-*)을 함께 가진다 — 유저는
 * 모양만 고르면 색이 따라온다. `name` 은 설정(settings.ext_icon_overrides)에 저장되는
 * 안정 키이므로 **절대 바꾸지 말 것**(바꾸면 기존 매핑이 깨짐). 추가는 자유.
 */
export interface PaletteEntry {
  /** 저장되는 안정 키. */
  name: string;
  Icon: LucideIcon;
  /** text-icon-* 색 토큰 클래스. */
  className: string;
}

export const ICON_PALETTE: PaletteEntry[] = [
  { name: "code", Icon: FileCode, className: "text-icon-code" },
  { name: "terminal", Icon: Terminal, className: "text-icon-code" },
  { name: "binary", Icon: Binary, className: "text-fg-muted" },
  { name: "data", Icon: FileJson, className: "text-icon-data" },
  { name: "database", Icon: Database, className: "text-icon-data" },
  { name: "doc", Icon: FileText, className: "text-icon-doc" },
  { name: "book", Icon: BookOpen, className: "text-icon-doc" },
  { name: "web", Icon: Globe, className: "text-icon-data" },
  { name: "image", Icon: FileImage, className: "text-icon-image" },
  { name: "photo", Icon: ImageIcon, className: "text-icon-image" },
  { name: "camera", Icon: Camera, className: "text-icon-image" },
  { name: "audio", Icon: FileAudio, className: "text-icon-audio" },
  { name: "music", Icon: Music, className: "text-icon-audio" },
  { name: "video", Icon: FileVideo, className: "text-icon-video" },
  { name: "film", Icon: Film, className: "text-icon-video" },
  { name: "archive", Icon: FileArchive, className: "text-icon-archive" },
  { name: "package", Icon: Package, className: "text-icon-archive" },
  { name: "box", Icon: Box, className: "text-icon-archive" },
  { name: "sheet", Icon: FileSpreadsheet, className: "text-icon-sheet" },
  { name: "slides", Icon: Presentation, className: "text-icon-slides" },
  { name: "star", Icon: Star, className: "text-icon-slides" },
  { name: "key", Icon: FileKey, className: "text-icon-key" },
  { name: "lock", Icon: Lock, className: "text-icon-key" },
  { name: "heart", Icon: Heart, className: "text-icon-key" },
  { name: "font", Icon: FileType, className: "text-icon-font" },
  { name: "exec", Icon: FileCog, className: "text-fg-muted" },
  { name: "cog", Icon: Cog, className: "text-fg-muted" },
  { name: "cpu", Icon: Cpu, className: "text-fg-muted" },
  { name: "disk", Icon: HardDrive, className: "text-fg-muted" },
  { name: "file", Icon: File, className: "text-fg-muted" },
];

const BY_NAME = new Map(ICON_PALETTE.map((e) => [e.name, e]));

/** 팔레트 이름 → {Icon, className}. 없으면 undefined (유저가 지운 아이콘 등). */
export function paletteIcon(
  name: string,
): { Icon: LucideIcon; className: string } | undefined {
  const e = BY_NAME.get(name);
  return e ? { Icon: e.Icon, className: e.className } : undefined;
}
