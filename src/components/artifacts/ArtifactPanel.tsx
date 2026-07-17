"use client";

import { useEffect, useState } from "react";
import {
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  Code,
  Copy,
  Download,
  Eye,
  FileCode,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Monitor,
  Smartphone,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Artifact, ArtifactType } from "@/lib/types";
import { artifactHasPreview } from "@/lib/types";
import { useChatStore } from "@/store/chat";
import { IconButton } from "@/components/ui/IconButton";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { cn } from "@/components/ui/cn";
import { ArtifactRenderer } from "./ArtifactRenderer";
import { DeviceFrame } from "./DeviceFrame";
import { PublishSiteButton } from "@/components/sites/PublishSiteButton";

/** lucide icon shown next to the title for each artifact type. */
const TYPE_ICONS: Record<ArtifactType, LucideIcon> = {
  code: FileCode,
  markdown: FileText,
  html: Code,
  svg: ImageIcon,
  image: ImageIcon,
  mermaid: GitBranch,
  react: Boxes,
  mobile: Smartphone,
};

/**
 * File extension used for the Download action, keyed by artifact type. For
 * "code" artifacts the extension is derived from the model-provided `language`.
 */
function extensionFor(artifact: Artifact): string {
  switch (artifact.type) {
    case "code": {
      const lang = (artifact.language ?? "").toLowerCase();
      switch (lang) {
        case "ts":
        case "typescript":
          return ".ts";
        case "tsx":
          return ".tsx";
        case "js":
        case "javascript":
          return ".js";
        case "jsx":
          return ".jsx";
        case "python":
        case "py":
          return ".py";
        default:
          return ".txt";
      }
    }
    case "markdown":
      return ".md";
    case "html":
      return ".html";
    case "svg":
      return ".svg";
    case "image":
      return ".png";
    case "mermaid":
      return ".mmd";
    case "react":
      return ".jsx";
    case "mobile":
      return ".tsx";
    default:
      return ".txt";
  }
}

/**
 * Artifact types that make sense to preview inside a phone frame: the app-like
 * types. A static image / SVG / diagram / prose doc gains nothing from a bezel, so
 * the viewport toggle is hidden for them.
 */
function supportsPhoneFrame(type: ArtifactType): boolean {
  return type === "mobile" || type === "react" || type === "html";
}

/** Trigger a browser download of `blob` as `filename` (shared by the actions). */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * The right-hand artifact side panel (Claude-Desktop style). Reads all of its
 * state from the chat store; renders nothing when no artifact is open. Fills its
 * container: header (title + Preview/Code toggle + close), an optional version
 * navigator, the renderer body, and a footer with Copy / Download.
 */
export function ArtifactPanel() {
  const openArtifactId = useChatStore((s) => s.openArtifactId);
  const artifacts = useChatStore((s) => s.artifacts);
  const openArtifactVersion = useChatStore((s) => s.openArtifactVersion);
  const closeArtifact = useChatStore((s) => s.closeArtifact);
  const setArtifactVersion = useChatStore((s) => s.setArtifactVersion);

  const artifact = artifacts.find((a) => a.id === openArtifactId) ?? null;

  // View mode is local UI state; default to Preview for previewable types.
  const [mode, setMode] = useState<"preview" | "code">("preview");
  // Preview viewport chrome: "phone" wraps the renderer in a device frame.
  const [viewport, setViewport] = useState<"desktop" | "phone">("desktop");
  // Non-null while the last Capacitor export failed, shown to the user.
  const [exportError, setExportError] = useState<string | null>(null);
  const { copied, copy } = useCopyToClipboard();

  // Reset the view mode whenever the open artifact (or its type) changes, so a
  // freshly-opened code-only artifact doesn't get stuck on a hidden Preview tab.
  // "mobile" artifacts default to the phone frame; everything else to desktop.
  useEffect(() => {
    if (artifact) {
      setMode(artifactHasPreview(artifact.type) ? "preview" : "code");
      setViewport(artifact.type === "mobile" ? "phone" : "desktop");
      setExportError(null);
    }
  }, [artifact?.id, artifact?.type]);

  // Nothing to show: panel closed, artifact gone, or (defensively) no versions.
  if (!openArtifactId || !artifact || artifact.versions.length === 0) {
    return null;
  }

  const versions = artifact.versions; // sorted ascending; last = latest
  const latest = versions[versions.length - 1];
  // openArtifactVersion === null means "follow latest"; a number pins a version.
  const shownVersion =
    openArtifactVersion !== null
      ? versions.find((v) => v.version === openArtifactVersion) ?? latest
      : latest;

  const hasPreview = artifactHasPreview(artifact.type);
  const TypeIcon = TYPE_ICONS[artifact.type];

  // Version navigation over the ordered version list.
  const idx = versions.findIndex((v) => v.version === shownVersion.version);
  const atFirst = idx <= 0;
  const atLast = idx >= versions.length - 1;

  const goPrev = () => {
    if (idx > 0) setArtifactVersion(versions[idx - 1].version);
  };
  const goNext = () => {
    if (idx < versions.length - 1) {
      const nextIdx = idx + 1;
      // Landing on the newest version follows-latest (null) so subsequent
      // streamed versions keep auto-advancing the panel.
      if (nextIdx === versions.length - 1) setArtifactVersion(null);
      else setArtifactVersion(versions[nextIdx].version);
    }
  };

  const handleDownload = () => {
    const filename = `${artifact.identifier}${extensionFor(artifact)}`;
    const blob = new Blob([shownVersion.content], {
      type: "text/plain;charset=utf-8",
    });
    triggerDownload(blob, filename);
  };

  // Download a ready-to-build Capacitor project (mobile artifacts) that wraps the
  // app as an installable iOS/Android shell. Surfaces failures instead of silently
  // no-op'ing (the endpoint 4xx's on e.g. an artifact with no content yet).
  const handleExportCapacitor = async () => {
    setExportError(null);
    try {
      const res = await fetch(`/api/artifacts/${artifact.id}/capacitor`);
      if (!res.ok) {
        setExportError("Couldn't export the app project. Please try again.");
        return;
      }
      const blob = await res.blob();
      triggerDownload(blob, `${artifact.identifier || "app"}-capacitor.zip`);
    } catch {
      setExportError("Couldn't export the app project. Please try again.");
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-main text-text-primary animate-slide-in-right">
      {/* Header: type icon + title + identifier, view toggle, close */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <TypeIcon size={16} className="shrink-0 text-text-secondary" />
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-text-primary">
            {artifact.title}
          </span>
          <span className="hidden truncate text-xs text-text-secondary sm:inline">
            {artifact.identifier}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {hasPreview && (
            <div className="flex items-center rounded-lg border border-border p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setMode("preview")}
                aria-pressed={mode === "preview"}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
                  mode === "preview"
                    ? "bg-hover text-text-primary"
                    : "text-text-secondary hover:text-text-primary",
                )}
              >
                <Eye size={13} />
                Preview
              </button>
              <button
                type="button"
                onClick={() => setMode("code")}
                aria-pressed={mode === "code"}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
                  mode === "code"
                    ? "bg-hover text-text-primary"
                    : "text-text-secondary hover:text-text-primary",
                )}
              >
                <Code size={13} />
                Code
              </button>
            </div>
          )}
          {hasPreview && mode === "preview" && supportsPhoneFrame(artifact.type) && (
            <div className="flex items-center rounded-lg border border-border p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setViewport("desktop")}
                aria-pressed={viewport === "desktop"}
                aria-label="Desktop viewport"
                title="Desktop viewport"
                className={cn(
                  "inline-flex items-center rounded-md px-2 py-1 transition-colors",
                  viewport === "desktop"
                    ? "bg-hover text-text-primary"
                    : "text-text-secondary hover:text-text-primary",
                )}
              >
                <Monitor size={13} />
              </button>
              <button
                type="button"
                onClick={() => setViewport("phone")}
                aria-pressed={viewport === "phone"}
                aria-label="Phone viewport"
                title="Phone viewport"
                className={cn(
                  "inline-flex items-center rounded-md px-2 py-1 transition-colors",
                  viewport === "phone"
                    ? "bg-hover text-text-primary"
                    : "text-text-secondary hover:text-text-primary",
                )}
              >
                <Smartphone size={13} />
              </button>
            </div>
          )}
          <IconButton label="Close artifact" size="sm" onClick={closeArtifact}>
            <X size={16} />
          </IconButton>
        </div>
      </div>

      {/* Version navigator (only when there is history to move through) */}
      {versions.length > 1 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-text-secondary">
          <IconButton
            label="Previous version"
            size="sm"
            onClick={goPrev}
            disabled={atFirst}
          >
            <ChevronLeft size={15} />
          </IconButton>
          <span className="tabular-nums">
            v{shownVersion.version} / {versions.length}
          </span>
          <IconButton
            label="Next version"
            size="sm"
            onClick={goNext}
            disabled={atLast}
          >
            <ChevronRight size={15} />
          </IconButton>
          <button
            type="button"
            onClick={() => setArtifactVersion(null)}
            disabled={atLast}
            className="ml-1 rounded px-1.5 py-0.5 text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-text-secondary"
          >
            Latest
          </button>
        </div>
      )}

      {/* Body: the renderer paints its own (often white) canvas here. DeviceFrame
          always wraps it (so the preview iframe keeps its identity across viewport
          toggles) and draws the phone bezel only when `enabled`. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <DeviceFrame
          enabled={
            viewport === "phone" &&
            mode === "preview" &&
            supportsPhoneFrame(artifact.type)
          }
        >
          <ArtifactRenderer
            artifact={artifact}
            version={shownVersion}
            mode={mode}
          />
        </DeviceFrame>
      </div>

      {exportError && (
        <div className="shrink-0 border-t border-border px-4 py-1.5 text-xs text-danger">
          {exportError}
        </div>
      )}

      {/* Footer: Publish-as-Site (preview types) + Copy + Download */}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-2">
        {hasPreview && (
          <PublishSiteButton
            artifactId={artifact.id}
            title={artifact.title}
            className="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          />
        )}
        {artifact.type === "mobile" && (
          <button
            type="button"
            onClick={handleExportCapacitor}
            title="Download a ready-to-build Capacitor (iOS/Android) project"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          >
            <Smartphone size={14} />
            Export app
          </button>
        )}
        <button
          type="button"
          onClick={() => copy(shownVersion.content)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
        >
          <Download size={14} />
          Download
        </button>
      </div>
    </div>
  );
}

export default ArtifactPanel;
