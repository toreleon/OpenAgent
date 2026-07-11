"use client";

import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import { useSearchParams } from "next/navigation";
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

const COLLAPSED_SIDEBAR_WIDTH = 52;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 420;
const ARTIFACT_MIN_WIDTH = 320;
const ARTIFACT_MAX_WIDTH = 900;
const CHAT_MIN_WIDTH = 320;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Top-level client app: wires sidebar + message list + composer to the store. */
export function ChatApp({ conversationId }: ChatAppProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [artifactWidth, setArtifactWidth] = useState(560);
  const [draft, setDraft] = useState<string | undefined>();
  const searchParams = useSearchParams();
  const requestedArtifactId = searchParams.get("artifact");

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
  const openArtifact = useChatStore((s) => s.openArtifact);

  // Initial sidebar list.
  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // Load or reset the active conversation based on the route.
  useEffect(() => {
    let cancelled = false;

    async function syncConversation() {
      if (!conversationId) {
        newChat();
        return;
      }

      await loadConversation(conversationId);
      if (!cancelled && requestedArtifactId) {
        const loadedArtifact = useChatStore
          .getState()
          .artifacts.some((artifact) => artifact.id === requestedArtifactId);
        if (loadedArtifact) openArtifact(requestedArtifactId);
      }
    }

    void syncConversation();
    return () => {
      cancelled = true;
    };
  }, [conversationId, loadConversation, newChat, openArtifact, requestedArtifactId]);

  // Keep the panes usable after a viewport resize or when an artifact is opened.
  useEffect(() => {
    const constrainWidths = () => {
      const viewportWidth = window.innerWidth;
      const artifactSpace = openArtifactId ? artifactWidth : 0;
      setSidebarWidth((width) =>
        clamp(
          width,
          SIDEBAR_MIN_WIDTH,
          Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - artifactSpace - CHAT_MIN_WIDTH),
        ),
      );
      if (openArtifactId) {
        setArtifactWidth((width) =>
          clamp(
            width,
            ARTIFACT_MIN_WIDTH,
            Math.min(
              ARTIFACT_MAX_WIDTH,
              viewportWidth - (sidebarOpen ? sidebarWidth : COLLAPSED_SIDEBAR_WIDTH) - CHAT_MIN_WIDTH,
            ),
          ),
        );
      }
    };

    constrainWidths();
    window.addEventListener("resize", constrainWidths);
    return () => window.removeEventListener("resize", constrainWidths);
  }, [artifactWidth, openArtifactId, sidebarOpen, sidebarWidth]);

  const hasMessages = messages.length > 0;

  function handleSend(text: string, attachments: Attachment[]) {
    void sendMessage(text, attachments);
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.classList.add("select-none");

    const onMove = (moveEvent: PointerEvent) => {
      const artifactSpace = openArtifactId ? artifactWidth : 0;
      setSidebarWidth(
        clamp(
          startWidth + moveEvent.clientX - startX,
          SIDEBAR_MIN_WIDTH,
          Math.min(
            SIDEBAR_MAX_WIDTH,
            window.innerWidth - artifactSpace - CHAT_MIN_WIDTH,
          ),
        ),
      );
    };
    const onEnd = () => {
      document.body.style.cursor = previousCursor;
      document.body.classList.remove("select-none");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
  }

  function startArtifactResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = artifactWidth;
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.classList.add("select-none");

    const onMove = (moveEvent: PointerEvent) => {
      setArtifactWidth(
        clamp(
          startWidth - (moveEvent.clientX - startX),
          ARTIFACT_MIN_WIDTH,
          Math.min(
            ARTIFACT_MAX_WIDTH,
            window.innerWidth - (sidebarOpen ? sidebarWidth : COLLAPSED_SIDEBAR_WIDTH) - CHAT_MIN_WIDTH,
          ),
        ),
      );
    };
    const onEnd = () => {
      document.body.style.cursor = previousCursor;
      document.body.classList.remove("select-none");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-main">
      <div
        className={cn(
          "relative h-full shrink-0 overflow-visible border-r border-border/60 transition-[width] duration-200",
        )}
        style={{ width: sidebarOpen ? sidebarWidth : COLLAPSED_SIDEBAR_WIDTH }}
      >
        <div className="h-full overflow-hidden">
          <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen((o) => !o)} />
        </div>
        {sidebarOpen && (
          <div
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            onPointerDown={startSidebarResize}
            className="absolute -right-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none hover:bg-accent/20 lg:block"
          />
        )}
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

      {/* Artifact panel: responsive side-by-side pane on larger screens; full-screen on small ones. */}
      {openArtifactId && (
        <div
          className="relative hidden h-full shrink-0 border-l border-border/60 lg:flex"
          style={{ width: artifactWidth }}
        >
          <div
            role="separator"
            aria-label="Resize artifact panel"
            aria-orientation="vertical"
            onPointerDown={startArtifactResize}
            className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize touch-none hover:bg-accent/20"
          />
          <ArtifactPanel />
        </div>
      )}
      {openArtifactId && (
        <div className="fixed inset-0 z-40 bg-main lg:hidden">
          <ArtifactPanel />
        </div>
      )}
    </div>
  );
}

export default ChatApp;
