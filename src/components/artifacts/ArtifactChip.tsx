"use client";

import {
  Boxes,
  Code,
  FileCode,
  FileText,
  GitBranch,
  Image,
  type LucideIcon,
} from "lucide-react";
import type { ArtifactCommand, ArtifactRef, ArtifactType } from "@/lib/types";
import { useChatStore } from "@/store/chat";

/** lucide icon per artifact type, mirroring the panel/header iconography. */
const TYPE_ICONS: Record<ArtifactType, LucideIcon> = {
  code: FileCode,
  markdown: FileText,
  html: Code,
  svg: Image,
  mermaid: GitBranch,
  react: Boxes,
};

/** Past-tense verb describing what this message did to the artifact. */
const COMMAND_VERBS: Record<ArtifactCommand, string> = {
  create: "Created",
  update: "Updated",
  rewrite: "Rewrote",
};

export interface ArtifactChipProps {
  artifactRef: ArtifactRef;
}

/**
 * Inline, clickable card rendered inside an assistant message. Clicking it opens
 * the artifact side panel at the version this message produced. Styled after the
 * attachment file chips in MessageItem.tsx.
 */
export function ArtifactChip({ artifactRef }: ArtifactChipProps) {
  // Select the action individually so the chip doesn't re-render on unrelated
  // store changes.
  const openArtifact = useChatStore((s) => s.openArtifact);

  const Icon = TYPE_ICONS[artifactRef.type];
  const verb = COMMAND_VERBS[artifactRef.command];

  return (
    <button
      type="button"
      onClick={() => openArtifact(artifactRef.artifactId, artifactRef.version)}
      className="flex w-full max-w-sm cursor-pointer items-center gap-3 rounded-xl border border-border bg-sidebar/60 px-3 py-2 text-left transition-colors hover:bg-hover"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/20 text-accent">
        <Icon size={18} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-text-primary">
          {artifactRef.title}
        </span>
        <span className="truncate text-[11px] text-text-secondary">
          {verb} · Click to open · v{artifactRef.version}
        </span>
      </span>
    </button>
  );
}

export default ArtifactChip;
