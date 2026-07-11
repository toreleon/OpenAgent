"use client";

import { SandboxFrame } from "./SandboxFrame";
import { buildSvgSrcDoc } from "@/components/artifacts/sandbox";

/** Renders an "svg" artifact centered on a white canvas inside an iframe. */
export interface SvgArtifactProps {
  content: string;
  language?: string;
}

export function SvgArtifact({ content }: SvgArtifactProps) {
  return <SandboxFrame srcDoc={buildSvgSrcDoc(content)} title="SVG preview" transparent />;
}

export default SvgArtifact;
