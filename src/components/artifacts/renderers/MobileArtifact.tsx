"use client";

import { SandboxFrame } from "./SandboxFrame";
import { buildMobileSrcDoc } from "@/components/artifacts/sandbox";

/**
 * Renders a "mobile" artifact: a single-file React Native app. The source is
 * compiled in-browser (Babel-standalone) and mounted with react-native-web's
 * AppRegistry inside the same isolated iframe every preview uses. The phone bezel
 * is supplied by the surrounding panel chrome (see ArtifactPanel's DeviceFrame),
 * so this renderer just fills its container like every other preview.
 */
export interface MobileArtifactProps {
  content: string;
}

export function MobileArtifact({ content }: MobileArtifactProps) {
  return (
    <SandboxFrame srcDoc={buildMobileSrcDoc(content)} title="Mobile app preview" />
  );
}

export default MobileArtifact;
