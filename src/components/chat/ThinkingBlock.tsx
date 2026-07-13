"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import type { ToolCallRecord, TraceItem } from "@/lib/types";
import { extractToolArg } from "@/lib/toolActivity";
import { Markdown } from "@/components/markdown/Markdown";
import { ActivityRow } from "./ActivityRow";
import { cn } from "@/components/ui/cn";

export interface ThinkingBlockProps {
  /** Ordered, interleaved reasoning + tool timeline. Preferred source. */
  timeline?: TraceItem[];
  /** Legacy tool calls, used to synthesize a timeline when `timeline` is absent. */
  toolCalls?: ToolCallRecord[];
  /** Legacy reasoning summary text, used as a fallback when `timeline` is absent. */
  reasoning?: string;
  /** True while the thinking phase (reasoning and/or tools) is still live. */
  reasoningStreaming?: boolean;
  /** Total thinking wall-clock in ms (reasoning + tools), frozen at answer start. */
  reasoningMs?: number;
}

/** Format the collapsed pill: "Thought for Ns" (or "Worked for Ns" with tools). */
function formatThinking(ms: number | undefined, hasTools: boolean): string {
  const verb = hasTools ? "Worked" : "Thought";
  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    return `${verb} for a few seconds`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds <= 0) return `${verb} for a few seconds`;
  if (seconds < 60) {
    return `${verb} for ${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${verb} for ${minutes}m${rem ? ` ${rem}s` : ""}`;
}

/**
 * Build a best-effort timeline for a legacy message persisted before the
 * interleaved `timeline` existed: the reasoning summary as one segment, then its
 * tool calls appended in order. New messages always carry a real `timeline`.
 */
function synthesizeTimeline(
  reasoning: string | undefined,
  toolCalls: ToolCallRecord[] | undefined,
): TraceItem[] {
  const items: TraceItem[] = [];
  if (reasoning && reasoning.length > 0) {
    items.push({ type: "reasoning", text: reasoning });
  }
  for (const tc of toolCalls ?? []) {
    items.push({
      type: "tool",
      id: tc.id,
      tool: tc.name,
      arg: extractToolArg(tc.name, tc.args),
      status: tc.output === undefined ? "running" : "done",
    });
  }
  return items;
}

/**
 * A collapsible "Thinking" trace rendered above an assistant answer.
 * Reasoning segments and tool-activity rows are shown as ONE chronological
 * timeline (never all-reasoning-then-all-tools).
 *
 * - While live: auto-expanded, auto-scrolling, with a shimmering "Thinking…"
 *   header and a top fade so older lines dissolve upward.
 * - Once finished: collapses to a clickable "Thought for Ns" / "Worked for Ns"
 *   pill with a chevron; clicking re-expands the full timeline.
 * - Renders nothing when there is no trace and none is in progress.
 */
export function ThinkingBlock({
  timeline,
  toolCalls,
  reasoning,
  reasoningStreaming,
  reasoningMs,
}: ThinkingBlockProps) {
  const items = useMemo<TraceItem[]>(
    () =>
      timeline && timeline.length > 0
        ? timeline
        : synthesizeTimeline(reasoning, toolCalls),
    [timeline, reasoning, toolCalls],
  );

  const hasBody = items.length > 0;
  const hasTools = items.some((it) => it.type === "tool");

  // Expanded while live; collapses by default once done. The user can toggle it
  // open again afterwards.
  const [expanded, setExpanded] = useState<boolean>(!!reasoningStreaming);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the live view expanded while thinking and collapse when it ends.
  useEffect(() => {
    setExpanded(!!reasoningStreaming);
  }, [reasoningStreaming]);

  // Auto-scroll the live trace to the newest line as it streams.
  useEffect(() => {
    if (!reasoningStreaming) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, reasoningStreaming]);

  if (!reasoningStreaming && !hasBody) return null;

  const open = expanded || !!reasoningStreaming;

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => {
          // Don't allow collapsing while the trace is still live.
          if (reasoningStreaming) return;
          setExpanded((o) => !o);
        }}
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-text-secondary transition-colors",
          reasoningStreaming
            ? "cursor-default"
            : "cursor-pointer hover:bg-hover hover:text-text-primary",
        )}
      >
        <Brain
          size={14}
          className={cn("shrink-0 opacity-80", reasoningStreaming && "animate-pulse")}
        />
        {reasoningStreaming ? (
          <span
            className="animate-shimmer bg-clip-text font-medium text-transparent"
            style={{
              // Theme-aware: base = muted secondary text, highlight = primary
              // text. Flips with the theme so the sweep reads in light + dark.
              backgroundImage:
                "linear-gradient(90deg,rgb(var(--color-text-secondary)) 0%,rgb(var(--color-text-secondary)) 35%,rgb(var(--color-text-primary)) 50%,rgb(var(--color-text-secondary)) 65%,rgb(var(--color-text-secondary)) 100%)",
              backgroundSize: "200% 100%",
              WebkitTextFillColor: "transparent",
            }}
          >
            Thinking…
          </span>
        ) : (
          <span className="font-medium">{formatThinking(reasoningMs, hasTools)}</span>
        )}
        {!reasoningStreaming && hasBody && (
          <ChevronRight
            size={14}
            className={cn(
              "shrink-0 opacity-60 transition-transform",
              expanded && "rotate-90",
            )}
          />
        )}
      </button>

      <div
        className={cn(
          "grid transition-all duration-300 ease-out",
          open ? "mt-1.5 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            ref={scrollRef}
            className={cn(
              "border-l-2 border-border pl-3",
              reasoningStreaming && "max-h-56 overflow-y-auto",
            )}
            style={
              reasoningStreaming
                ? {
                    WebkitMaskImage:
                      "linear-gradient(to bottom, transparent 0, black 24px)",
                    maskImage:
                      "linear-gradient(to bottom, transparent 0, black 24px)",
                  }
                : undefined
            }
          >
            {hasBody ? (
              items.map((it, i) =>
                it.type === "reasoning" ? (
                  <Markdown
                    key={`r-${i}`}
                    content={it.text}
                    className={cn(
                      "prose-sm text-[13px] leading-relaxed text-text-secondary opacity-90",
                      i > 0 && "mt-2",
                    )}
                  />
                ) : (
                  <div key={`${it.id}-${i}`} className={cn(i > 0 && "mt-0.5")}>
                    <ActivityRow item={it} />
                  </div>
                ),
              )
            ) : (
              <span className="text-[13px] italic text-text-secondary opacity-70">
                Thinking…
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ThinkingBlock;
