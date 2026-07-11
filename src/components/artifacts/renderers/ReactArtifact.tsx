"use client";

import { SandboxFrame } from "./SandboxFrame";
import { buildReactSrcDoc } from "@/components/artifacts/sandbox";

/**
 * Renders a "react" artifact: the component source is compiled in-browser
 * (Babel-standalone) and mounted inside an isolated iframe.
 */
export interface ReactArtifactProps {
  content: string;
  language?: string;
}

export function ReactArtifact({ content }: ReactArtifactProps) {
  return (
    <SandboxFrame srcDoc={buildReactSrcDoc(content)} title="React preview" />
  );
}

export default ReactArtifact;
