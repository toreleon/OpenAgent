"use client";

import { useMemo } from "react";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";

/**
 * Syntax-highlighted, scrollable source view. Used both for "code" artifacts and
 * as the "Code" tab of every previewable artifact type.
 */
export interface CodeArtifactProps {
  content: string;
  /** highlight.js language hint (e.g. "python", "tsx"). Optional. */
  language?: string;
}

export function CodeArtifact({ content, language }: CodeArtifactProps) {
  // Highlight once per (content, language). Unknown/absent languages fall back
  // to highlight.js auto-detection instead of throwing.
  const highlighted = useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(content, { language, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(content).value;
    } catch {
      // Last-resort: render as-is (the browser escapes it via textContent).
      return null;
    }
  }, [content, language]);

  return (
    <div className="h-full w-full overflow-auto bg-[#0d0d0d]">
      <pre className="min-h-full p-4 text-sm leading-relaxed">
        {highlighted !== null ? (
          <code
            className="hljs bg-transparent"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code className="hljs bg-transparent">{content}</code>
        )}
      </pre>
    </div>
  );
}

export default CodeArtifact;
