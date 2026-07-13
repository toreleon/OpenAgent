"use client";

import { memo, useMemo } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { Check, Copy } from "lucide-react";
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { cn } from "@/components/ui/cn";

/**
 * Normalize LaTeX delimiters before parsing. `remark-math` only recognizes
 * `$...$` / `$$...$$`, but models frequently emit `\(...\)` for
 * inline and `\[...\]` for display math. Convert those to the dollar forms.
 *
 * We split on fenced/inline code first and only transform the non-code
 * segments, so genuine `\[` / `\(` inside code samples are left untouched.
 */
function normalizeMath(input: string): string {
  const segments = input.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return segments
    .map((seg, i) => {
      // Odd indices are the captured code segments — leave them verbatim.
      if (i % 2 === 1) return seg;
      return seg
        // Escape currency-style dollar signs ("$50,000", "$45k") so remark-math's
        // single-dollar inline math doesn't swallow them (and everything up to the
        // next "$") as a math span. Real math reaches us as \(..\)/\[..\] and is
        // converted to $/$$ below — AFTER this escape — so it is unaffected.
        .replace(/\$(?=\d)/g, "\\$")
        .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => `\n\n$$\n${body.trim()}\n$$\n\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body) => `$${body.trim()}$`);
    })
    .join("");
}

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function languageFromClass(className?: string): string | null {
  if (!className) return null;
  const match = /language-([\w-]+)/.exec(className);
  return match ? match[1] : null;
}

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { copied, copy } = useCopyToClipboard();
  const language = languageFromClass(className);
  const code = extractText(children).replace(/\n$/, "");

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-border bg-code-bg">
      <div className="flex items-center justify-between border-b border-border bg-code-header px-4 py-1.5">
        <span className="text-xs font-medium lowercase text-text-secondary">
          {language ?? "code"}
        </span>
        <button
          type="button"
          onClick={() => copy(code)}
          className="flex items-center gap-1 text-xs text-text-secondary transition-colors hover:text-text-primary"
        >
          {copied ? (
            <>
              <Check size={13} /> Copied
            </>
          ) : (
            <>
              <Copy size={13} /> Copy code
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-relaxed">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  code(props) {
    const { className, children, node: _node, ...rest } = props as ComponentPropsWithoutRef<"code"> & {
      node?: unknown;
    };
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  // `pre` is handled inside CodeBlock; render children passthrough so we don't
  // double-wrap block code in two <pre> elements.
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="my-4 overflow-x-auto">
        <table>{children}</table>
      </div>
    );
  },
};

export interface MarkdownProps {
  content: string;
  className?: string;
}

function MarkdownImpl({ content, className }: MarkdownProps) {
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath], []);
  const rehypePlugins = useMemo(
    () => [
      [rehypeKatex, { throwOnError: false, strict: false }] as const,
      [rehypeHighlight, { detect: true, ignoreMissing: true }] as const,
    ],
    [],
  );
  const processed = useMemo(() => normalizeMath(content), [content]);

  return (
    <div className={cn("prose-chat", className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rehypePlugins={rehypePlugins as any}
        components={components}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
export default Markdown;
