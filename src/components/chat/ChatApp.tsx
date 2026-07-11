"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Attachment } from "@/lib/types";
import { useChatStore } from "@/store/chat";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { ModelPicker } from "./ModelPicker";
import { ArtifactPanel } from "@/components/artifacts/ArtifactPanel";
import { cn } from "@/components/ui/cn";

export interface ChatAppProps {
  /** Conversation id to load on mount (from /c/[id]). Omit for a fresh chat. */
  conversationId?: string;
}

/** Top-level client app: wires sidebar + message list + composer to the store. */
export function ChatApp({ conversationId }: ChatAppProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [draft, setDraft] = useState<string | undefined>();

  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingMessageId = useChatStore((s) => s.streamingMessageId);
  const model = useChatStore((s) => s.model);
  const error = useChatStore((s) => s.error);
  const messagesLoading = useChatStore((s) => s.messagesLoading);
  const openArtifactId = useChatStore((s) => s.openArtifactId);

  const setModel = useChatStore((s) => s.setModel);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stop = useChatStore((s) => s.stop);
  const regenerate = useChatStore((s) => s.regenerate);
  const loadConversations = useChatStore((s) => s.loadConversations);
  const loadConversation = useChatStore((s) => s.loadConversation);
  const newChat = useChatStore((s) => s.newChat);
  const clearError = useChatStore((s) => s.clearError);

  // Initial sidebar list.
  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // Load or reset the active conversation based on the route.
  useEffect(() => {
    if (conversationId) {
      void loadConversation(conversationId);
    } else {
      newChat();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const hasMessages = messages.length > 0;

  function handleSend(text: string, attachments: Attachment[]) {
    void sendMessage(text, attachments);
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-main">
      <div
        className={cn(
          "h-full shrink-0 overflow-hidden border-r border-border/60 transition-[width] duration-200",
          sidebarOpen ? "w-[260px]" : "w-[52px]",
        )}
      >
        <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen((o) => !o)} />
      </div>

      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex h-12 shrink-0 items-center gap-2 px-4">
          <ModelPicker
            value={model}
            onChange={setModel}
            disabled={isStreaming}
            side="bottom"
            align="start"
          />
        </header>

        {error && (
          <div className="mx-auto mt-1 flex w-full max-w-chat items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            <span className="truncate">{error}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={clearError}
              className="shrink-0 text-red-300 hover:text-red-200"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Main area */}
        {hasMessages || messagesLoading ? (
          <MessageList
            messages={messages}
            isStreaming={isStreaming}
            streamingMessageId={streamingMessageId}
            onRegenerate={regenerate}
          />
        ) : (
          <div className="flex-1 overflow-y-auto">
            <EmptyState onPick={(p) => setDraft(p)} />
          </div>
        )}

        {/* Composer */}
        <Composer
          onSend={handleSend}
          isStreaming={isStreaming}
          onStop={stop}
          model={model}
          onModelChange={setModel}
          draft={draft}
          onDraftConsumed={() => setDraft(undefined)}
        />
      </div>

      {/* Artifact panel: side-by-side on md+, full-screen overlay on small screens. */}
      {openArtifactId && (
        <div className="hidden h-full w-[45%] min-w-[380px] max-w-[760px] shrink-0 border-l border-border/60 md:flex">
          <ArtifactPanel />
        </div>
      )}
      {openArtifactId && (
        <div className="fixed inset-0 z-40 bg-main md:hidden">
          <ArtifactPanel />
        </div>
      )}
    </div>
  );
}

export default ChatApp;
