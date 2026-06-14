import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import hljs from "highlight.js/lib/common";

/**
 * 텍스트 미리보기 본문 — 마크다운은 렌더, 그 외 코드/텍스트는 구문 강조.
 *
 * 강조 색은 globals.css 의 `.hljs-*` → CSS 변수 매핑으로 light/dark 자동 전환.
 * 파일 읽기/절단은 백엔드(fs_read_preview)가 담당 — 여기서는 표시만 (CLAUDE.md §1).
 */
export interface PreviewContentProps {
  name: string;
  text: string;
  /** head 만 읽은 큰 파일이면 true — 하단에 안내. */
  truncated: boolean;
}

/** 확장자 → highlight.js 언어 id (없으면 auto-detect). */
const EXT_LANG: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", swift: "swift", kt: "kotlin", lua: "lua", r: "r", pl: "perl",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini",
  html: "xml", xml: "xml", svg: "xml", vue: "xml",
  css: "css", scss: "scss", less: "less",
  sql: "sql", diff: "diff", patch: "diff", makefile: "makefile",
};

function isMarkdown(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdown");
}

function langFor(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === "makefile" || lower === "dockerfile") return lower === "makefile" ? "makefile" : "dockerfile";
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return EXT_LANG[ext];
}

export function PreviewContent({ name, text, truncated }: PreviewContentProps) {
  const markdown = isMarkdown(name);

  const html = useMemo(() => {
    if (markdown) return null;
    const lang = langFor(name);
    try {
      const r =
        lang && hljs.getLanguage(lang)
          ? hljs.highlight(text, { language: lang })
          : hljs.highlightAuto(text);
      return r.value;
    } catch {
      return null;
    }
  }, [markdown, name, text]);

  return (
    <div className="preview-content">
      {markdown ? (
        <div className="preview-markdown p-2 text-meta">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {text}
          </ReactMarkdown>
        </div>
      ) : html !== null ? (
        <pre className="whitespace-pre-wrap break-all p-2 font-mono text-meta">
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      ) : (
        <pre className="whitespace-pre-wrap break-all p-2 font-mono text-meta">{text}</pre>
      )}
      {truncated && (
        <div className="border-t border-border px-2 py-1 text-center text-meta text-fg-muted">
          Preview truncated — file is larger
        </div>
      )}
    </div>
  );
}
