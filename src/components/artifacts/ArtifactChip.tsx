"use client";

import { useState } from "react";
import {
  Boxes,
  Code,
  Eye,
  FileCode,
  FileText,
  GitBranch,
  Image,
  Maximize2,
  type LucideIcon,
} from "lucide-react";
import type { ArtifactCommand, ArtifactRef, ArtifactType } from "@/lib/types";
import { useChatStore } from "@/store/chat";
import { ArtifactRenderer } from "./ArtifactRenderer";

/** lucide icon per artifact type, mirroring the panel/header iconography. */
const TYPE_ICONS: Record<ArtifactType, LucideIcon> = {
  code: FileCode,
  markdown: FileText,
  html: Code,
  svg: Image,
  image: Image,
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
  const artifact = useChatStore((s) =>
    s.artifacts.find((item) => item.id === artifactRef.artifactId),
  );
  const [mode, setMode] = useState<"preview" | "code">("preview");

  const Icon = TYPE_ICONS[artifactRef.type];
  const verb = COMMAND_VERBS[artifactRef.command];
  const version = artifact?.versions.find((item) => item.version === artifactRef.version);
  const showInlineArtifact =
    !!artifact &&
    !!version &&
    (artifactRef.type === "svg" ||
      artifactRef.type === "mermaid" ||
      artifactRef.type === "image");
  const previewHeight =
    artifactRef.type === "mermaid"
      ? "h-[clamp(8rem,18vw,12rem)]"
      : "h-[clamp(14rem,36vw,20rem)]";

  if (showInlineArtifact && artifact && version) {
    return (
      <div className="w-full max-w-xl">
        <div className="mb-1.5 flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => openArtifact(artifactRef.artifactId, artifactRef.version)}
            className="inline-flex min-w-0 items-center gap-1.5 text-text-secondary transition-colors hover:text-text-primary"
          >
            <Icon size={14} className="shrink-0 text-accent" />
            <span className="truncate font-medium text-text-primary">{artifactRef.title}</span>
            <span className="shrink-0 text-text-secondary">v{artifactRef.version}</span>
          </button>

          <div className="ml-auto flex items-center rounded-md border border-border p-0.5">
            <button
              type="button"
              aria-label="Preview artifact"
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors ${
                mode === "preview"
                  ? "bg-hover text-text-primary"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              <Eye size={12} /> Preview
            </button>
            <button
              type="button"
              aria-label="View artifact code"
              aria-pressed={mode === "code"}
              onClick={() => setMode("code")}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors ${
                mode === "code"
                  ? "bg-hover text-text-primary"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              <Code size={12} /> Code
            </button>
          </div>

          <button
            type="button"
            aria-label="Open artifact in full view"
            onClick={() => openArtifact(artifactRef.artifactId, artifactRef.version)}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          >
            <Maximize2 size={14} />
          </button>
        </div>
        <div className={`${previewHeight} overflow-hidden rounded-lg bg-main`}>
          <ArtifactRenderer artifact={artifact} version={version} mode={mode} />
        </div>
      </div>
    );
  }

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
