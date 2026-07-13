"use client";

import { History } from "lucide-react";
import { useChatStore } from "@/store/chat";

/**
 * "Rewind to here" affordance shown under an assistant turn that changed files.
 * Opens the RewindDialog to restore the workspace (and/or conversation) to this
 * turn's checkpoint. Self-contained — reads the store like DiffStatsBadge.
 */
export function RewindButton({ messageId }: { messageId: string }) {
  const openRewind = useChatStore((s) => s.openRewind);
  const isStreaming = useChatStore((s) => s.isStreaming);

  return (
    <button
      type="button"
      onClick={() => openRewind(messageId)}
      disabled={isStreaming}
      title="Rewind code state to this turn"
      className="motion-press inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
    >
      <History size={14} className="shrink-0" />
      Rewind
    </button>
  );
}

export default RewindButton;
