"use client";

import { useEffect, useState } from "react";
import { FileDiff } from "lucide-react";
import { useChatStore } from "@/store/chat";
import type { WorkspaceStatus } from "@/lib/workspace/types";

/**
 * Claude-Code-Desktop entry affordance: a compact `+N −M` badge shown under an
 * assistant message that changed files. Fetches that turn's diff stats; clicking
 * opens the workspace review pane scoped to the turn. Renders nothing until it
 * confirms the turn actually changed at least one file.
 */
export function DiffStatsBadge({ messageId }: { messageId: string }) {
  const conversationId = useChatStore((s) => s.currentId);
  const openWorkspace = useChatStore((s) => s.openWorkspace);
  const workspaceView = useChatStore((s) => s.workspaceView);
  // This turn's tool calls aren't persisted until it finishes streaming, so wait
  // for it to settle before fetching (and refetch when it does).
  const streaming = useChatStore((s) => s.streamingMessageId === messageId);
  const [stats, setStats] = useState<{
    adds: number;
    dels: number;
    files: number;
  } | null>(null);

  useEffect(() => {
    if (!conversationId || streaming) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/conversations/${conversationId}/workspace?scope=lastTurn&messageId=${encodeURIComponent(
            messageId,
          )}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const s = (await res.json()) as WorkspaceStatus;
        if (cancelled || s.changes.length === 0) return;
        const adds = s.changes.reduce((n, c) => n + c.adds, 0);
        const dels = s.changes.reduce((n, c) => n + c.dels, 0);
        setStats({ adds, dels, files: s.changes.length });
      } catch {
        // ignore — badge simply won't render
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, messageId, streaming]);

  if (!stats) return null;

  const active =
    workspaceView?.scope === "lastTurn" && workspaceView.messageId === messageId;

  return (
    <button
      type="button"
      onClick={() => openWorkspace({ scope: "lastTurn", messageId })}
      className={`animate-scale-in motion-press inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-accent/50 bg-accent/10 text-text-primary"
          : "border-border text-text-secondary hover:bg-hover hover:text-text-primary"
      }`}
      title="View this turn's changes"
    >
      <FileDiff size={14} className="shrink-0" />
      <span className="tabular-nums">
        {stats.adds > 0 && <span className="text-green-500">+{stats.adds}</span>}
        {stats.adds > 0 && stats.dels > 0 && " "}
        {stats.dels > 0 && <span className="text-red-500">−{stats.dels}</span>}
      </span>
      <span>
        {stats.files} file{stats.files === 1 ? "" : "s"} changed
      </span>
    </button>
  );
}

export default DiffStatsBadge;
