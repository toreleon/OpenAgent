"use client";

import { SandboxFrame } from "./SandboxFrame";
import { buildHtmlSrcDoc } from "@/components/artifacts/sandbox";

/** Renders an "html" artifact inside an isolated iframe on a white canvas. */
export interface HtmlArtifactProps {
  content: string;
  language?: string;
}

export function HtmlArtifact({ content }: HtmlArtifactProps) {
  return <SandboxFrame srcDoc={buildHtmlSrcDoc(content)} title="HTML preview" />;
}

export default HtmlArtifact;
