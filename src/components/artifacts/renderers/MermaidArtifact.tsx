"use client";

import { SandboxFrame } from "./SandboxFrame";
import { buildMermaidSrcDoc } from "@/components/artifacts/sandbox";

/** Renders a "mermaid" artifact as a diagram (Mermaid CDN) inside an iframe. */
export interface MermaidArtifactProps {
  content: string;
  language?: string;
}

export function MermaidArtifact({ content }: MermaidArtifactProps) {
  return (
    <SandboxFrame srcDoc={buildMermaidSrcDoc(content)} title="Mermaid diagram" transparent />
  );
}

export default MermaidArtifact;
