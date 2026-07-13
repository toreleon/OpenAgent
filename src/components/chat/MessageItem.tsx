"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Pencil,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import type {
  MessageItemProps,
  Attachment,
  ChatMessage,
  ToolCallRecord,
} from "@/lib/types";
import { Markdown } from "@/components/markdown/Markdown";
import { ArtifactChip } from "@/components/artifacts/ArtifactChip";
import { SiteChip } from "@/components/sites/SiteChip";
import { DiffStatsBadge } from "@/components/workspace/DiffStatsBadge";
import { RewindButton } from "@/components/workspace/RewindButton";
import { ThinkingBlock } from "./ThinkingBlock";
import { ResearchActivity } from "./ResearchActivity";
import { SubagentActivity } from "./SubagentActivity";
import { BrowserActivity } from "./BrowserActivity";
import { IconButton } from "@/components/ui/IconButton";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { cn } from "@/components/ui/cn";

const MAX_EDIT_TEXTAREA_HEIGHT = 320;

/** True when a message's tool calls include a file-writing tool, so we should
 *  offer a diff-stats badge for that turn (the badge self-hides if the turn
 *  produced no net change). */
function touchedFiles(toolCalls: ToolCallRecord[] | undefined): boolean {
  return (
    !!toolCalls &&
    toolCalls.some((t) => t.name === "write_file" || t.name === "edit_file")
  );
}

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

/** A `‹ 2/3 ›` pager for stepping between sibling branch versions. */
function VersionNav({
  index,
  count,
  onPrev,
  onNext,
  disabled,
}: {
  index: number;
  count: number;
  onPrev?: () => void;
  onNext?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-0.5 text-text-secondary">
      <button
        type="button"
        aria-label="Previous version"
        title="Previous version"
        disabled={disabled || index <= 0}
        onClick={onPrev}
        className="flex h-6 w-5 items-center justify-center rounded transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-text-secondary"
      >
        <ChevronLeft size={16} />
      </button>
      <span className="min-w-[2.2rem] text-center text-xs tabular-nums">
        {index + 1}/{count}
      </span>
      <button
        type="button"
        aria-label="Next version"
        title="Next version"
        disabled={disabled || index >= count - 1}
        onClick={onNext}
        className="flex h-6 w-5 items-center justify-center rounded transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-text-secondary"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

export interface MessageItemFullProps extends MessageItemProps {
  /** Whether to show the regenerate button (last assistant message, not streaming). */
  canRegenerate?: boolean;
  onRegenerate?: () => void;
  /** True for the most recent assistant message — keeps its action bar visible. */
  isLast?: boolean;
  /** Version position among sibling branches; arrows show when count > 1. */
  version?: { index: number; count: number };
  onPrevVersion?: () => void;
  onNextVersion?: () => void;
  /** Save an edited user message (creates a new version). Enables the pencil. */
  onEdit?: (text: string) => void;
  /** Disable edit + version controls (e.g. while any response is streaming). */
  controlsDisabled?: boolean;
}

export function MessageItem({
  message,
  isStreaming,
  canRegenerate,
  onRegenerate,
  isLast,
  version,
  onPrevVersion,
  onNextVersion,
  onEdit,
  controlsDisabled,
}: MessageItemFullProps) {
  const { copied, copy } = useCopyToClipboard();
  // Cosmetic thumbs toggle (action bar; no server persistence).
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const [editing, setEditing] = useState(false);
  const isUser = message.role === "user";
  const attachments = message.attachments ?? [];
  const showCaret = !isUser && isStreaming;
  const hasVersions = !!version && version.count > 1;
  // `reasoningStreaming` is a transient client-only flag the store layers onto
  // the streaming assistant message; it is not part of the persisted shape.
  const reasoningStreaming = (message as ChatMessage & {
    reasoningStreaming?: boolean;
  }).reasoningStreaming;

  if (isUser) {
    if (editing) {
      return (
        <UserEditor
          message={message}
          attachments={attachments}
          disabled={controlsDisabled}
          onCancel={() => setEditing(false)}
          onSave={(text) => {
            setEditing(false);
            onEdit?.(text);
          }}
        />
      );
    }

    return (
      <div className="group flex w-full flex-col items-end py-3">
        <AttachmentChips attachments={attachments} />
        {message.content && (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl bg-user-bubble px-5 py-2.5 text-text-primary">
            {message.content}
          </div>
        )}
        <div
          className={cn(
            "mt-1 flex h-6 items-center gap-1 transition-opacity",
            hasVersions ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          {hasVersions && version && (
            <VersionNav
              index={version.index}
              count={version.count}
              onPrev={onPrevVersion}
              onNext={onNextVersion}
              disabled={controlsDisabled}
            />
          )}
          <span
            className={cn(
              "flex items-center gap-1",
              hasVersions && "opacity-0 group-hover:opacity-100",
            )}
          >
            <IconButton
              label={copied ? "Copied" : "Copy"}
              size="sm"
              onClick={() => copy(message.content)}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </IconButton>
            {onEdit && (
              <IconButton
                label="Edit message"
                size="sm"
                disabled={controlsDisabled}
                onClick={() => setEditing(true)}
              >
                <Pencil size={15} />
              </IconButton>
            )}
          </span>
        </div>
      </div>
    );
  }

  const barVisible = isLast || hasVersions;

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
      {message.subagents && (
        <SubagentActivity subagents={message.subagents} isStreaming={isStreaming} />
      )}
      {message.browser && (
        <BrowserActivity browser={message.browser} isStreaming={isStreaming} />
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
      {message.siteRefs && message.siteRefs.length > 0 && (
        <div className="my-2 flex flex-col gap-2">
          {message.siteRefs.map((ref, i) => (
            <SiteChip key={`${ref.siteId}-${ref.command}-${i}`} siteRef={ref} />
          ))}
        </div>
      )}
      {!isUser && touchedFiles(message.toolCalls) && (
        <div className="my-2 flex flex-wrap items-center gap-2">
          <DiffStatsBadge messageId={message.id} />
          <RewindButton messageId={message.id} />
        </div>
      )}
      <div
        className={cn(
          "mt-1 flex h-7 items-center gap-0.5 transition-opacity",
          isStreaming
            ? "pointer-events-none opacity-0"
            : barVisible
              ? "opacity-100"
              : "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
        )}
      >
        {hasVersions && version && (
          <VersionNav
            index={version.index}
            count={version.count}
            onPrev={onPrevVersion}
            onNext={onNextVersion}
            disabled={controlsDisabled}
          />
        )}
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
          <IconButton
            label="Regenerate"
            size="sm"
            disabled={controlsDisabled}
            onClick={onRegenerate}
          >
            <RefreshCw size={15} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

/**
 * Inline editor shown in place of a user bubble: the bubble
 * becomes an auto-growing textarea with Cancel / Send; Enter saves, Escape
 * cancels. Attachments are preserved (shown read-only) and carried by the store.
 */
function UserEditor({
  message,
  attachments,
  disabled,
  onCancel,
  onSave,
}: {
  message: ChatMessage;
  attachments: Attachment[];
  /** True while a response is streaming — Send/Enter are blocked so the edit
   * isn't silently dropped by the store's streaming guard. */
  disabled?: boolean;
  onCancel: () => void;
  onSave: (text: string) => void;
}) {
  const [value, setValue] = useState(message.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Auto-grow the textarea to fit its content, up to a cap.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_EDIT_TEXTAREA_HEIGHT)}px`;
  }, [value]);

  const canSave = value.trim().length > 0 && !disabled;

  function save() {
    if (!canSave) return;
    onSave(value.trim());
  }

  return (
    <div className="flex w-full flex-col items-end py-3">
      <AttachmentChips attachments={attachments} />
      <div className="w-full max-w-[85%] rounded-3xl bg-user-bubble px-4 py-3">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          rows={1}
          className="max-h-[320px] w-full resize-none bg-transparent text-text-primary placeholder:text-text-secondary focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-border px-4 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            title={disabled ? "Wait for the current response to finish" : "Send"}
            className="rounded-full bg-text-primary px-4 py-1.5 text-sm font-medium text-main transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

export default MessageItem;
