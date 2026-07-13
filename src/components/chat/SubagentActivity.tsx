"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Code,
  File,
  FilePlus,
  FileText,
  FolderOpen,
  Globe,
  Loader2,
  PenLine,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { ToolIconKey } from "@/lib/toolActivity";
import type {
  SubagentActivity as SubagentActivityEntry,
  SubagentState,
  SubagentStatus,
} from "@/lib/types";
import { cn } from "@/components/ui/cn";

export interface SubagentActivityProps {
  /** The accumulated parallel-subagent state (one entry per dispatched worker). */
  subagents: SubagentState;
  /** True while events are still arriving for this message. */
  isStreaming?: boolean;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * A monotonically-updating "now" (epoch-ms) that ticks once a second WHILE
 * `active`, then freezes. Drives the live per-agent + overall elapsed timers
 * without re-rendering the tree when nothing is running.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Compact duration: "0.8s", "12s", "1m 04s". */
function formatDuration(ms: number): string {
  const clamped = ms > 0 ? ms : 0;
  const s = clamped / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${String(rem).padStart(2, "0")}s`;
}

/**
 * Live/final elapsed for one worker, or null while it is still queued.
 *
 * Once SETTLED, both endpoints are server-stamped, so `endedAt - startedAt` is
 * the accurate, reload-stable duration. While RUNNING we measure against the
 * client clock (`now - clientStart`) instead of the server `startedAt` so the
 * live timer never shows a skewed value when the browser clock differs from the
 * server's. `clientStart` is the moment this browser first observed the worker
 * running; it falls back to the server `startedAt` for the one frame before the
 * ref is stamped.
 */
function elapsedMs(
  agent: SubagentActivityEntry,
  now: number,
  clientStart?: number,
): number | null {
  if (!agent.startedAt) return null;
  if (agent.endedAt != null) return Math.max(0, agent.endedAt - agent.startedAt);
  return Math.max(0, now - (clientStart ?? agent.startedAt));
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/** Resolve a tool-activity icon key to a concrete glyph for a trace row. */
function TraceIcon({ icon }: { icon: ToolIconKey }) {
  const common = { size: 12, className: "shrink-0 opacity-70" } as const;
  switch (icon) {
    case "web":
      return <Globe {...common} />;
    case "page":
      return <FileText {...common} />;
    case "code":
      return <Code {...common} />;
    case "terminal":
      return <Terminal {...common} />;
    case "file":
      return <File {...common} />;
    case "edit":
      return <PenLine {...common} />;
    case "new-file":
      return <FilePlus {...common} />;
    case "folder":
      return <FolderOpen {...common} />;
    case "search":
      return <Search {...common} />;
    case "clock":
      return <Clock {...common} />;
    case "skill":
      return <Sparkles {...common} />;
    default:
      return <Wrench {...common} />;
  }
}

/** The trailing status indicator for one worker: spinner / check / x. */
function StatusIcon({ status }: { status: SubagentStatus }) {
  switch (status) {
    case "running":
      return <Loader2 size={14} className="shrink-0 animate-spin text-accent" />;
    case "done":
      return <Check size={14} className="shrink-0 text-accent" />;
    case "failed":
      return <X size={14} className="shrink-0 text-danger" />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// One worker card
// ---------------------------------------------------------------------------

function AgentCard({
  agent,
  now,
  clientStart,
}: {
  agent: SubagentActivityEntry;
  now: number;
  /** Client-clock moment this browser first saw the worker running (skew-free timer). */
  clientStart?: number;
}) {
  const trace = agent.trace ?? [];
  const hasTrace = trace.length > 0;
  const running = agent.status === "running";
  const started = !!agent.startedAt;
  const queued = running && !started;

  // Expand the full trace on demand. Collapsed by default so a batch of workers
  // stays compact; the live "current action" line still shows what each is doing.
  const [open, setOpen] = useState(false);

  const elapsed = elapsedMs(agent, now, clientStart);
  const stepCount = agent.steps ?? trace.length;

  // The single live line under the header: the in-flight tool while running, or
  // the settled one-line result/error once done.
  const current = hasTrace ? trace[trace.length - 1] : undefined;
  const actionLabel = running ? current?.label ?? agent.detail : agent.detail;
  const actionIcon = running && current ? current.icon : undefined;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-hover/40 px-3 py-2 transition-colors",
        hasTrace && "hover:bg-hover/70",
      )}
    >
      <button
        type="button"
        disabled={!hasTrace}
        onClick={() => hasTrace && setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 text-left",
          hasTrace ? "cursor-pointer" : "cursor-default",
        )}
      >
        <StatusIcon status={agent.status} />
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary"
          title={agent.title}
        >
          {agent.title}
        </span>
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-text-secondary opacity-70">
          {queued
            ? "Queued"
            : `${stepCount} ${stepCount === 1 ? "tool" : "tools"}${
                elapsed != null ? ` · ${formatDuration(elapsed)}` : ""
              }`}
        </span>
        {hasTrace ? (
          <ChevronRight
            size={13}
            className={cn(
              "shrink-0 text-text-secondary opacity-60 transition-transform",
              open && "rotate-90",
            )}
          />
        ) : (
          <span className="w-[13px] shrink-0" aria-hidden />
        )}
      </button>

      {/* The single live/final action line (hidden once the trace is expanded to
          avoid duplicating the last row). */}
      {!open && actionLabel && (
        <div className="mt-1 flex items-center gap-1.5 pl-6 text-[12px] leading-relaxed text-text-secondary">
          {actionIcon ? (
            <TraceIcon icon={actionIcon} />
          ) : (
            <span className="w-3 shrink-0" aria-hidden />
          )}
          <span
            className={cn("min-w-0 flex-1 truncate", running && "animate-pulse")}
            title={actionLabel}
          >
            {actionLabel}
          </span>
        </div>
      )}

      {/* The full tool timeline. */}
      {open && hasTrace && (
        <ul className="mt-1.5 flex flex-col gap-0.5 border-l border-border pl-3 ml-[7px]">
          {trace.map((step, i) => (
            <li
              key={i}
              className="flex items-center gap-1.5 py-0.5 text-[12px] leading-relaxed text-text-secondary"
            >
              <TraceIcon icon={step.icon} />
              <span className="min-w-0 flex-1 truncate" title={step.label}>
                {step.label}
              </span>
              {step.status === "running" ? (
                <Loader2 size={11} className="shrink-0 animate-spin opacity-70" />
              ) : (
                <Check size={11} className="shrink-0 text-accent opacity-70" />
              )}
            </li>
          ))}
          {/* The settled worker's one-line result, appended below its trace. */}
          {!running && agent.detail && (
            <li className="flex items-start gap-1.5 py-0.5 pt-1 text-[12px] italic leading-relaxed text-text-secondary opacity-80">
              <span className="min-w-0 flex-1" title={agent.detail}>
                {agent.detail}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The working view
// ---------------------------------------------------------------------------

/**
 * Claude-Code-style "Subagents" WORKING VIEW rendered above an orchestrator's
 * synthesized answer, showing the parallel workers dispatched by `run_subagents`
 * as live cards.
 *
 * - While any worker is still running: auto-expanded, with a pulsing header that
 *   tallies running/done counts and an overall elapsed timer. Each card shows the
 *   worker's live current action and can be expanded to reveal its full tool
 *   timeline.
 * - Once every worker has settled: collapses to a clickable "Used N subagents ·
 *   Ns" pill; clicking re-expands the per-worker cards with their final durations,
 *   traces, and result lines.
 * - Renders nothing when there are no workers.
 */
export function SubagentActivity({ subagents, isStreaming }: SubagentActivityProps) {
  // Memoized so its identity is stable across the per-second timer re-renders —
  // otherwise the `?? []` fallback would make the effects below re-run each tick.
  const agents = useMemo(() => subagents.agents ?? [], [subagents.agents]);
  const count = agents.length;

  // "Active" while streaming AND at least one worker is still running. Once all
  // workers settle, the lead agent is synthesizing — collapse to the pill.
  const active = !!isStreaming && agents.some((a) => a.status === "running");
  const now = useNow(active);

  // Expanded while active; collapses by default once done. The user can toggle
  // it open again afterwards.
  const [expanded, setExpanded] = useState<boolean>(active);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The client-clock moment this browser first observed each worker running, so
  // the live timers stay in one clock domain (skew-free). Server timestamps are
  // still used for the settled/reloaded durations (accurate + reload-stable).
  const clientStartRef = useRef<Record<string, number>>({});
  useEffect(() => {
    for (const a of agents) {
      if (a.startedAt && clientStartRef.current[a.id] == null) {
        clientStartRef.current[a.id] = Date.now();
      }
    }
  }, [agents]);

  // Whether the user is pinned to the bottom of the (scrollable, while-active)
  // card list. Starts pinned and follows new activity; flips off the moment the
  // user scrolls up (e.g. to read an earlier worker's expanded trace) so the
  // per-second re-render never yanks them back down.
  const pinnedRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // Keep the live view expanded during the run and collapse when it ends.
  useEffect(() => {
    setExpanded(active);
  }, [active]);

  // Follow the newest activity ONLY while pinned to the bottom. Driven by a
  // content signature (total tool steps) so it reacts to real progress rather
  // than the every-second timer tick.
  const stepSignature = agents.reduce((n, a) => n + (a.steps ?? 0), 0);
  useEffect(() => {
    if (!active || !pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active, stepSignature]);

  if (count === 0) return null;

  const open = expanded || active;

  // A worker seeded past the concurrency cap is "running" but has no startedAt —
  // it is genuinely QUEUED, and its card shows "Queued". Count it separately so
  // the header's "N running" never contradicts the cards.
  const runningCount = agents.filter(
    (a) => a.status === "running" && a.startedAt,
  ).length;
  const queuedCount = agents.filter(
    (a) => a.status === "running" && !a.startedAt,
  ).length;
  const doneCount = agents.filter((a) => a.status === "done").length;
  const failedCount = agents.filter((a) => a.status === "failed").length;

  // Overall elapsed spans the earliest start to the latest settle. While active
  // it counts up in the client clock domain (skew-free, anchored to the earliest
  // client-observed start); once settled it uses the accurate server endpoints.
  const overallStart = Math.min(
    ...agents
      .map((a) => a.startedAt)
      .filter((t): t is number => typeof t === "number"),
  );
  const hasStart = Number.isFinite(overallStart);
  let overallMs: number | null = null;
  if (active) {
    const clientStarts = agents
      .filter((a) => a.startedAt)
      .map((a) => clientStartRef.current[a.id])
      .filter((t): t is number => typeof t === "number");
    const anchor = clientStarts.length
      ? Math.min(...clientStarts)
      : hasStart
        ? overallStart
        : null;
    overallMs = anchor != null ? Math.max(0, now - anchor) : null;
  } else if (hasStart) {
    const ends = agents
      .map((a) => a.endedAt)
      .filter((t): t is number => typeof t === "number");
    if (ends.length) overallMs = Math.max(0, Math.max(...ends) - overallStart);
  }

  // The live sub-header tally: running / queued / done / failed counts + overall
  // elapsed, joined cleanly so it never renders a stray "· ·" or empty fragment.
  const liveMeta = [
    runningCount > 0 ? `${runningCount} running` : null,
    queuedCount > 0 ? `${queuedCount} queued` : null,
    doneCount > 0 ? `${doneCount} done` : null,
    failedCount > 0 ? `${failedCount} failed` : null,
    overallMs != null ? formatDuration(overallMs) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // The collapsed pill keeps the failure signal visible at rest — a subagent
  // that failed must not vanish just because the block collapsed — plus the
  // final duration.
  const pillMeta = [
    failedCount > 0 ? `${failedCount} failed` : null,
    overallMs != null ? formatDuration(overallMs) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => {
          // Don't allow collapsing while workers are still running.
          if (active) return;
          setExpanded((o) => !o);
        }}
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-text-secondary transition-colors",
          active
            ? "cursor-default"
            : "cursor-pointer hover:bg-hover hover:text-text-primary",
        )}
      >
        <Boxes size={14} className={cn("opacity-80", active && "animate-pulse")} />
        {active ? (
          <span className="font-medium">
            <span className="animate-pulse">
              Working with {count} {count === 1 ? "subagent" : "subagents"}…
            </span>
            {liveMeta && (
              <span className="ml-1 tabular-nums opacity-70">{liveMeta}</span>
            )}
          </span>
        ) : (
          <span className="font-medium">
            Used {count} {count === 1 ? "subagent" : "subagents"}
            {pillMeta && (
              <span className="ml-1 tabular-nums opacity-70">· {pillMeta}</span>
            )}
          </span>
        )}
        {!active && (
          <ChevronDown
            size={14}
            className={cn(
              "opacity-60 transition-transform",
              expanded && "rotate-180",
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
            onScroll={onScroll}
            className={cn(
              "flex flex-col gap-1.5 stagger-children",
              active && "max-h-96 overflow-y-auto pr-0.5",
            )}
          >
            {agents.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                now={now}
                clientStart={clientStartRef.current[a.id]}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SubagentActivity;
