"use client";

import { Markdown } from "@/components/markdown/Markdown";

/**
 * Renders a "markdown" artifact as rich text (the Preview mode). The raw source
 * is shown via CodeArtifact when the panel is in Code mode.
 */
export interface MarkdownArtifactProps {
  content: string;
  /** Present for signature parity with other renderers; unused here. */
  language?: string;
}

export function MarkdownArtifact({ content }: MarkdownArtifactProps) {
  return (
    <div className="h-full w-full overflow-auto bg-main">
      <div className="mx-auto max-w-chat px-6 py-6">
        <Markdown content={content} />
      </div>
    </div>
  );
}

export default MarkdownArtifact;
