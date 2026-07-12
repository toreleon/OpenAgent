"use client";

import { useMemo } from "react";
import { buildSiteSrcDoc } from "@/components/artifacts/sandbox";
import { SandboxFrame } from "@/components/artifacts/renderers/SandboxFrame";
import type { SiteType } from "@/lib/types";

export interface SitePreviewFrameProps {
  type: SiteType;
  content: string;
  title: string;
}

/**
 * In-app preview of a Site's content, rendered through the SAME opaque-origin
 * sandboxed iframe + srcdoc builders used to serve the published site — so the
 * draft preview matches the live page exactly. Isolation comes from SandboxFrame
 * (no `allow-same-origin`); this is the owner previewing their own content, i.e.
 * no new risk class beyond the app's existing artifact previews.
 */
export function SitePreviewFrame({ type, content, title }: SitePreviewFrameProps) {
  const srcDoc = useMemo(() => buildSiteSrcDoc(type, content), [type, content]);
  return <SandboxFrame srcDoc={srcDoc} title={title} />;
}

export default SitePreviewFrame;
