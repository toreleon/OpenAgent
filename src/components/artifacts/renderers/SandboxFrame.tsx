"use client";

/**
 * Shared wrapper around a sandboxed <iframe>. Every "preview" renderer
 * (HTML/SVG/Mermaid/React) funnels through this so the isolation policy lives in
 * one place.
 *
 * SECURITY: the sandbox intentionally OMITS `allow-same-origin`, so the browser
 * treats the frame as an opaque, unique origin — artifact code cannot touch the
 * parent app's DOM, cookies, or storage. The srcDoc documents are built by
 * `@/components/artifacts/sandbox`.
 */
export interface SandboxFrameProps {
  /** A complete HTML document string to render inside the iframe. */
  srcDoc: string;
  /** Accessible title for the iframe. */
  title: string;
  /** Let a transparent preview inherit the surrounding app canvas. */
  transparent?: boolean;
}

export function SandboxFrame({ srcDoc, title, transparent = false }: SandboxFrameProps) {
  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      className={transparent ? "h-full w-full border-0 bg-transparent" : "h-full w-full border-0 bg-white"}
      // Note: deliberately no `allow-same-origin` — keep the frame isolated.
      sandbox="allow-scripts allow-popups allow-forms allow-modals"
    />
  );
}

export default SandboxFrame;
