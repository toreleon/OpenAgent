"use client";

import { Check, Copy, FileText, RefreshCw, Sparkles, Wrench } from "lucide-react";
import type {
  MessageItemProps,
  Attachment,
  ToolCallRecord,
  ChatMessage,
} from "@/lib/types";
import { Markdown } from "@/components/markdown/Markdown";
import { ArtifactChip } from "@/components/artifacts/ArtifactChip";
import { ThinkingBlock } from "./ThinkingBlock";
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

function ToolCalls({ toolCalls }: { toolCalls: ToolCallRecord[] }) {
  if (!toolCalls.length) return null;
  return (
    <div className="mb-3 flex flex-col gap-2">
      {toolCalls.map((tc) => (
        <details
          key={tc.id}
          className="rounded-lg border border-border bg-sidebar/60 text-xs"
        >
          <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-text-secondary">
            <Wrench size={13} />
            <span className="font-medium text-text-primary">{tc.name}</span>
            <span className="text-text-secondary">
              {tc.output === undefined ? "running…" : "completed"}
            </span>
          </summary>
          <div className="space-y-2 border-t border-border px-3 py-2">
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-text-secondary">
                Arguments
              </div>
              <pre className="overflow-x-auto rounded bg-[#0d0d0d] p-2 text-[11px]">
                {safeJson(tc.args)}
              </pre>
            </div>
            {tc.output !== undefined && (
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-text-secondary">
                  Result
                </div>
                <pre className="overflow-x-auto rounded bg-[#0d0d0d] p-2 text-[11px]">
                  {safeJson(tc.output)}
                </pre>
              </div>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface MessageItemFullProps extends MessageItemProps {
  /** Whether to show the regenerate button (last assistant message, not streaming). */
  canRegenerate?: boolean;
  onRegenerate?: () => void;
}

export function MessageItem({
  message,
  isStreaming,
  canRegenerate,
  onRegenerate,
}: MessageItemFullProps) {
  const { copied, copy } = useCopyToClipboard();
  const isUser = message.role === "user";
  const attachments = message.attachments ?? [];
  const toolCalls = message.toolCalls ?? [];
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
    <div className="group flex w-full gap-4 py-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-main text-text-primary">
        <Sparkles size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <ThinkingBlock
          reasoning={message.reasoning}
          reasoningStreaming={reasoningStreaming}
          reasoningMs={message.reasoningMs}
        />
        <ToolCalls toolCalls={toolCalls} />
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
              <ArtifactChip
                key={ref.artifactId + ref.version}
                artifactRef={ref}
              />
            ))}
          </div>
        )}
        <div
          className={cn(
            "mt-1 flex h-7 items-center gap-1 transition-opacity",
            isStreaming ? "opacity-0" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <IconButton
            label={copied ? "Copied" : "Copy"}
            size="sm"
            onClick={() => copy(message.content)}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </IconButton>
          {canRegenerate && onRegenerate && (
            <IconButton label="Regenerate" size="sm" onClick={onRegenerate}>
              <RefreshCw size={15} />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}

export default MessageItem;
