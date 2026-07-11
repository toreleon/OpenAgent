"use client";

import { ArrowDown } from "lucide-react";
import type { ChatMessage } from "@/lib/types";
import { MessageItem } from "./MessageItem";
import { useAutoScroll } from "@/hooks/useAutoScroll";

export interface MessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingMessageId: string | null;
  onRegenerate: () => void;
}

/** Scrollable, centered column of chat messages with auto-scroll behavior. */
export function MessageList({
  messages,
  isStreaming,
  streamingMessageId,
  onRegenerate,
}: MessageListProps) {
  // Recompute scroll when message count or the streaming message's length changes.
  const streamingLen =
    messages.find((m) => m.id === streamingMessageId)?.content.length ?? 0;
  const { containerRef, bottomRef, isPinnedToBottom, scrollToBottom } =
    useAutoScroll<HTMLDivElement>([messages.length, streamingLen]);

  const lastAssistantId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id;
    }
    return null;
  })();

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={containerRef} className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-chat px-4 pb-10 pt-6">
          {messages.map((m) => {
            const isStreamingThis = m.id === streamingMessageId && isStreaming;
            const isLastAssistant =
              m.role === "assistant" && m.id === lastAssistantId;
            const canRegenerate = isLastAssistant && !isStreaming;
            return (
              <MessageItem
                key={m.id}
                message={m}
                isStreaming={isStreamingThis}
                canRegenerate={canRegenerate}
                onRegenerate={onRegenerate}
                isLast={isLastAssistant}
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
