"use client";

import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import type { DraftComment } from "@/lib/workspace/types";

/**
 * Inline editor for one draft review comment, rendered directly beneath its diff
 * line. Autofocuses when empty. Submitting the whole batch (⌘/Ctrl+Enter) is
 * handled by the panel; this box just edits text and can remove itself.
 */
export function CommentBox({
  comment,
  onChange,
  onRemove,
}: {
  comment: DraftComment;
  onChange: (text: string) => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (comment.text === "") ref.current?.focus();
    // Only on first mount for a fresh comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex items-start gap-2">
      <span className="mt-1 shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
        {comment.lineLabel}
      </span>
      <textarea
        ref={ref}
        value={comment.text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Leave a comment for the agent…"
        rows={2}
        className="min-h-[2.25rem] flex-1 resize-y rounded-md border border-border bg-main px-2 py-1.5 font-sans text-xs text-text-primary outline-none placeholder:text-text-secondary focus:border-accent"
      />
      <IconButton label="Remove comment" size="sm" onClick={onRemove}>
        <Trash2 size={14} />
      </IconButton>
    </div>
  );
}

export default CommentBox;
