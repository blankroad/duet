import { useMemo, type ComponentPropsWithoutRef, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
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

/** 링크 기본 동작(앱 창 이동) 차단 — 창 장식이 없는 앱이라 돌아올 방법이 없다. */
function stopNavigation(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
}

/**
 * 마크다운 링크는 표시만 하고 따라가지 않는다. 앱 webview 안에서 `<a href>` 를
 * 그대로 두면 클릭 한 번에 앱 화면 자체가 그 주소로 바뀐다. 외부 브라우저로
 * 여는 백엔드 명령이 아직 없어 클릭은 무시하고, 주소는 툴팁으로 보여 준다.
 */
function MarkdownLink({
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  return (
    <a
      {...props}
      title={props.title ?? props.href}
      onClick={stopNavigation}
      onAuxClick={stopNavigation}
    />
  );
}

const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink };

/** 확장자 → highlight.js 언어 id (없으면 auto-detect). */
const EXT_LANG: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  lua: "lua",
  r: "r",
  pl: "perl",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  html: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  makefile: "makefile",
};

function isMarkdown(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mdown")
  );
}

function langFor(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === "makefile" || lower === "dockerfile")
    return lower === "makefile" ? "makefile" : "dockerfile";
  const ext = lower.includes(".")
    ? lower.slice(lower.lastIndexOf(".") + 1)
    : "";
  return EXT_LANG[ext];
}

export function PreviewContent({ name, text, truncated }: PreviewContentProps) {
  const { t } = useTranslation();
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
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={MARKDOWN_COMPONENTS}
          >
            {text}
          </ReactMarkdown>
        </div>
      ) : html !== null ? (
        <pre className="whitespace-pre-wrap break-all p-2 font-mono text-meta">
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      ) : (
        <pre className="whitespace-pre-wrap break-all p-2 font-mono text-meta">
          {text}
        </pre>
      )}
      {truncated && (
        <div className="border-t border-border px-2 py-1 text-center text-meta text-fg-muted">
          {t("preview.truncated")}
        </div>
      )}
    </div>
  );
}
