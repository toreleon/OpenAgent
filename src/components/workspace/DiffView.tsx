"use client";

import { MessageSquarePlus } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { highlightLine } from "./diffHighlight";
import { CommentBox } from "./CommentBox";
import type { DiffHunk, DiffLine, DraftComment } from "@/lib/workspace/types";

export interface DiffCommentApi {
  /** Comments for THIS file, keyed by anchor id. */
  byId: Map<string, DraftComment>;
  add: (anchor: { id: string; lineLabel: string; lineContent: string }) => void;
  update: (id: string, text: string) => void;
  remove: (id: string) => void;
}

/**
 * Unified (inline) diff renderer for one file's hunks — Claude-Code-Desktop
 * style: dual old/new line-number gutters, green added rows, red removed rows,
 * neutral context, `@@` hunk-header separators, syntax-highlighted code. When a
 * `comments` API is supplied, hovering a line reveals a "+" to attach an inline
 * review comment (which batches + round-trips to the agent).
 */
export function DiffView({
  hunks,
  language,
  path,
  comments,
}: {
  hunks: DiffHunk[];
  language?: string;
  path?: string;
  comments?: DiffCommentApi;
}) {
  if (hunks.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-text-secondary">
        No textual changes.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto font-mono text-xs leading-relaxed">
      <div className="min-w-full">
        {hunks.map((hunk, hi) => (
          <div key={hi}>
            <div className="flex w-max min-w-full bg-hover/60 text-text-secondary">
              <span className="select-none px-3 py-0.5 tabular-nums">
                {hunk.header}
              </span>
            </div>
            {hunk.lines.map((line, li) => {
              const id = `${path ?? ""}::${hi}::${li}`;
              const comment = comments?.byId.get(id);
              return (
                <div key={`${hi}-${li}`}>
                  <Row
                    line={line}
                    language={language}
                    canComment={!!comments}
                    onAddComment={
                      comments
                        ? () =>
                            comments.add({
                              id,
                              lineLabel: `L${line.newNo ?? line.oldNo ?? "?"}`,
                              lineContent: line.content,
                            })
                        : undefined
                    }
                  />
                  {comment && comments && (
                    <div className="border-y border-border bg-hover/30 px-3 py-2">
                      <CommentBox
                        comment={comment}
                        onChange={(t) => comments.update(id, t)}
                        onRemove={() => comments.remove(id)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({
  line,
  language,
  canComment,
  onAddComment,
}: {
  line: DiffLine;
  language?: string;
  canComment: boolean;
  onAddComment?: () => void;
}) {
  const isAdd = line.type === "add";
  const isDel = line.type === "del";
  const html =
    line.content === "" ? " " : highlightLine(line.content, language);
  return (
    <div
      className={cn(
        "group flex w-max min-w-full",
        isAdd && "bg-green-500/15",
        isDel && "bg-red-500/15",
      )}
    >
      {canComment && (
        <button
          type="button"
          onClick={onAddComment}
          aria-label="Comment on this line"
          className="flex w-5 shrink-0 items-center justify-center text-accent opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
        >
          <MessageSquarePlus size={12} />
        </button>
      )}
      <Gutter n={line.oldNo} />
      <Gutter n={line.newNo} />
      <span
        aria-hidden
        className={cn(
          "w-4 shrink-0 select-none text-center",
          isAdd && "text-green-500",
          isDel && "text-red-500",
          !isAdd && !isDel && "text-transparent",
        )}
      >
        {isAdd ? "+" : isDel ? "-" : " "}
      </span>
      <code
        className="whitespace-pre pr-4 text-text-primary"
        // highlightLine returns hljs-escaped HTML (or an nbsp); safe to inject.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function Gutter({ n }: { n: number | null }) {
  return (
    <span className="w-10 shrink-0 select-none px-2 text-right tabular-nums text-text-secondary/50">
      {n ?? ""}
    </span>
  );
}

export default DiffView;
