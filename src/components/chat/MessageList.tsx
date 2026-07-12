"use client";

import { useMemo } from "react";
import { ArrowDown } from "lucide-react";
import type { ChatMessage } from "@/lib/types";
import { MessageItem } from "./MessageItem";
import { computeVisiblePath, computeVersionInfo } from "@/store/chat";
import { useAutoScroll } from "@/hooks/useAutoScroll";

export interface MessageListProps {
  /** The full message TREE (every branch); the visible path is derived here. */
  messages: ChatMessage[];
  /** Leaf of the visible branch (drives which path + versions are shown). */
  activeLeafId: string | null;
  isStreaming: boolean;
  streamingMessageId: string | null;
  /** Regenerate a specific assistant reply (defaults to the last when omitted). */
  onRegenerate: (assistantMessageId?: string) => void;
  /** Save an edited user message as a new version. */
  onEditMessage: (messageId: string, text: string) => void;
  /** Page between sibling versions of a message. */
  onSwitchVersion: (messageId: string, direction: "prev" | "next") => void;
}

/** Scrollable, centered column of chat messages with auto-scroll behavior. */
export function MessageList({
  messages,
  activeLeafId,
  isStreaming,
  streamingMessageId,
  onRegenerate,
  onEditMessage,
  onSwitchVersion,
}: MessageListProps) {
  // Derive the visible conversation (root→leaf) and per-message version info
  // from the full tree. Memoized so branch switches / streaming stay cheap.
  const visible = useMemo(
    () => computeVisiblePath(messages, activeLeafId),
    [messages, activeLeafId],
  );
  const versionInfo = useMemo(() => computeVersionInfo(messages), [messages]);

  // Recompute scroll when the visible length or the streaming message's length
  // changes (and when the branch itself changes).
  const streamingLen =
    visible.find((m) => m.id === streamingMessageId)?.content.length ?? 0;
  const { containerRef, bottomRef, isPinnedToBottom, scrollToBottom } =
    useAutoScroll<HTMLDivElement>([visible.length, streamingLen, activeLeafId]);

  const lastAssistantId = (() => {
    for (let i = visible.length - 1; i >= 0; i--) {
      if (visible[i].role === "assistant") return visible[i].id;
    }
    return null;
  })();

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={containerRef} className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-chat px-4 pb-10 pt-6">
          {visible.map((m) => {
            const isStreamingThis = m.id === streamingMessageId && isStreaming;
            const isLastAssistant =
              m.role === "assistant" && m.id === lastAssistantId;
            // Regenerating a Deep Research turn can't reproduce the research
            // pipeline (it would yield a plain reply as a sibling of a cited
            // report), so don't offer it on research messages — the version
            // history would otherwise mix inconsistent answer kinds.
            const canRegenerate = isLastAssistant && !isStreaming && !m.research;
            const info = versionInfo.get(m.id);
            const version =
              info && info.count > 1
                ? { index: info.index, count: info.count }
                : undefined;
            return (
              <MessageItem
                key={m.id}
                message={m}
                isStreaming={isStreamingThis}
                canRegenerate={canRegenerate}
                onRegenerate={() => onRegenerate(m.id)}
                isLast={isLastAssistant}
                version={version}
                onPrevVersion={() => onSwitchVersion(m.id, "prev")}
                onNextVersion={() => onSwitchVersion(m.id, "next")}
                onEdit={
                  m.role === "user"
                    ? (text) => onEditMessage(m.id, text)
                    : undefined
                }
                controlsDisabled={isStreaming}
              />
            );
          })}
          <div ref={bottomRef} className="h-px w-full" />
        </div>
      </div>

      {!isPinnedToBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          aria-label="Scroll to bottom"
          className="absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-main text-text-primary shadow-lg transition-colors hover:bg-hover"
        >
          <ArrowDown size={18} />
        </button>
      )}
    </div>
  );
}

export default MessageList;
