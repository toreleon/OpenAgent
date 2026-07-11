"use client";

import type { Artifact, ArtifactType, ArtifactVersion } from "@/lib/types";
import { CodeArtifact } from "./renderers/CodeArtifact";
import { MarkdownArtifact } from "./renderers/MarkdownArtifact";
import { HtmlArtifact } from "./renderers/HtmlArtifact";
import { SvgArtifact } from "./renderers/SvgArtifact";
import { ImageArtifact } from "./renderers/ImageArtifact";
import { MermaidArtifact } from "./renderers/MermaidArtifact";
import { ReactArtifact } from "./renderers/ReactArtifact";

/**
 * Chooses the correct renderer for an artifact + view mode.
 *
 * - `mode === "code"` always shows the raw source (syntax-highlighted), with a
 *   highlight.js language derived from the artifact type.
 * - `mode === "preview"` shows the rendered form for previewable types; "code"
 *   artifacts have no distinct preview so they fall back to the source view.
 */
export interface ArtifactRendererProps {
  artifact: Artifact;
  /** The specific version to render (its `content` is what gets shown). */
  version: ArtifactVersion;
  mode: "preview" | "code";
}

/**
 * highlight.js language used when showing an artifact's raw source. For "code"
 * artifacts we honor the model-provided `language`; otherwise we map the type to
 * the closest highlight.js grammar. "mermaid" has no built-in grammar, so
 * CodeArtifact falls back to auto-detection for it.
 */
function codeLanguageFor(artifact: Artifact): string | undefined {
  switch (artifact.type) {
    case "code":
      return artifact.language;
    case "html":
      return "xml";
    case "svg":
      return "xml";
    case "image":
      return undefined;
    case "mermaid":
      return "mermaid";
    case "markdown":
      return "markdown";
    case "react":
      return "jsx";
    default:
      return undefined;
  }
}

export function ArtifactRenderer({
  artifact,
  version,
  mode,
}: ArtifactRendererProps) {
  const content = version.content;

  const body =
    mode === "code" ? (
      <CodeArtifact content={content} language={codeLanguageFor(artifact)} />
    ) : (
      renderPreview(artifact.type, content, artifact.language)
    );

  return (
    <div className="h-full w-full min-h-0 overflow-hidden">{body}</div>
  );
}

/** Preview-mode dispatch by artifact type. */
function renderPreview(
  type: ArtifactType,
  content: string,
  language?: string,
) {
  switch (type) {
    case "markdown":
      return <MarkdownArtifact content={content} />;
    case "html":
      return <HtmlArtifact content={content} />;
    case "svg":
      return <SvgArtifact content={content} />;
    case "image":
      return <ImageArtifact content={content} />;
    case "mermaid":
      return <MermaidArtifact content={content} />;
    case "react":
      return <ReactArtifact content={content} />;
    case "code":
    default:
      // "code" artifacts have no separate preview — show the source.
      return <CodeArtifact content={content} language={language} />;
  }
}

export default ArtifactRenderer;
