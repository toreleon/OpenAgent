"use client";

import { useState } from "react";
import {
  Check,
  Copy,
  FileText,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import type { MessageItemProps, Attachment, ChatMessage } from "@/lib/types";
import { Markdown } from "@/components/markdown/Markdown";
import { ArtifactChip } from "@/components/artifacts/ArtifactChip";
import { ThinkingBlock } from "./ThinkingBlock";
import { ResearchActivity } from "./ResearchActivity";
import { IconButton } from "@/components/ui/IconButton";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { cn } from "@/components/ui/cn";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentChips({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null;
  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind !== "image");

  return (
    <div className="mb-2 flex flex-col items-end gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {images.map((a) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={a.id}
              src={a.url}
              alt={a.name}
              className="max-h-48 rounded-xl border border-border object-cover"
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {files.map((a) => (
            <a
              key={a.id}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-xl border border-border bg-user-bubble px-3 py-2 transition-colors hover:bg-hover"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/20 text-accent">
                <FileText size={16} />
              </span>
              <span className="flex flex-col">
                <span className="max-w-[12rem] truncate text-xs font-medium text-text-primary">
                  {a.name}
                </span>
                <span className="text-[11px] text-text-secondary">
                  {formatBytes(a.size)}
                </span>
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export interface MessageItemFullProps extends MessageItemProps {
  /** Whether to show the regenerate button (last assistant message, not streaming). */
  canRegenerate?: boolean;
  onRegenerate?: () => void;
  /** True for the most recent assistant message — keeps its action bar visible. */
  isLast?: boolean;
}

export function MessageItem({
  message,
  isStreaming,
  canRegenerate,
  onRegenerate,
  isLast,
}: MessageItemFullProps) {
  const { copied, copy } = useCopyToClipboard();
  // Cosmetic thumbs toggle (matches ChatGPT's action bar; no server persistence).
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const isUser = message.role === "user";
  const attachments = message.attachments ?? [];
  const showCaret = !isUser && isStreaming;
  // `reasoningStreaming` is a transient client-only flag the store layers onto
  // the streaming assistant message; it is not part of the persisted shape.
  const reasoningStreaming = (message as ChatMessage & {
    reasoningStreaming?: boolean;
  }).reasoningStreaming;

  if (isUser) {
    return (
      <div className="group flex w-full flex-col items-end py-3">
        <AttachmentChips attachments={attachments} />
        {message.content && (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl bg-user-bubble px-5 py-2.5 text-text-primary">
            {message.content}
          </div>
        )}
        <div className="mt-1 flex h-6 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton
            label={copied ? "Copied" : "Copy"}
            size="sm"
            onClick={() => copy(message.content)}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </IconButton>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex w-full flex-col py-3">
      <ThinkingBlock
        timeline={message.timeline}
        toolCalls={message.toolCalls}
        reasoning={message.reasoning}
        reasoningStreaming={reasoningStreaming}
        reasoningMs={message.reasoningMs}
      />
      {message.research && (
        <ResearchActivity research={message.research} isStreaming={isStreaming} />
      )}
      {message.content ? (
        <Markdown content={message.content} />
      ) : showCaret ? (
        <span className="inline-flex items-center gap-1 text-text-secondary">
          <span className="h-2 w-2 animate-pulse rounded-full bg-text-secondary" />
        </span>
      ) : null}
      {showCaret && message.content && (
        <span className="ml-0.5 inline-block h-4 w-[3px] animate-pulse-cursor align-middle bg-text-primary" />
      )}
      {message.artifactRefs && message.artifactRefs.length > 0 && (
        <div className="my-2 flex flex-col gap-2">
          {message.artifactRefs.map((ref) => (
            <ArtifactChip key={ref.artifactId + ref.version} artifactRef={ref} />
          ))}
        </div>
      )}
      <div
        className={cn(
          "mt-1 flex h-7 items-center gap-0.5 transition-opacity",
          isStreaming
            ? "pointer-events-none opacity-0"
            : isLast
              ? "opacity-100"
              : "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
        )}
      >
        <IconButton
          label={copied ? "Copied" : "Copy"}
          size="sm"
          onClick={() => copy(message.content)}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </IconButton>
        <IconButton
          label="Good response"
          size="sm"
          active={feedback === "up"}
          onClick={() => setFeedback((f) => (f === "up" ? null : "up"))}
        >
          <ThumbsUp size={15} />
        </IconButton>
        <IconButton
          label="Bad response"
          size="sm"
          active={feedback === "down"}
          onClick={() => setFeedback((f) => (f === "down" ? null : "down"))}
        >
          <ThumbsDown size={15} />
        </IconButton>
        {canRegenerate && onRegenerate && (
          <IconButton label="Regenerate" size="sm" onClick={onRegenerate}>
            <RefreshCw size={15} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

export default MessageItem;
