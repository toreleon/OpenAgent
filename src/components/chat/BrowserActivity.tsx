"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Clock,
  FileText,
  Globe,
  Loader2,
  PenLine,
  Search,
  Wrench,
  X,
} from "lucide-react";
import type { ToolIconKey } from "@/lib/toolActivity";
import type {
  BrowserActivity as BrowserActivityEntry,
  BrowserState,
  BrowserStepStatus,
} from "@/lib/types";
import { cn } from "@/components/ui/cn";

export interface BrowserActivityProps {
  /** The accumulated browsing state (the built-in browser's live trace). */
  browser: BrowserState;
  /** True while events are still arriving for this message. */
  isStreaming?: boolean;
}

/** A "now" that ticks once a second WHILE active, then freezes (skew-free timer). */
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
  const s = (ms > 0 ? ms : 0) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/**
 * Elapsed browsing time. While an action is in flight (`ticking`) it counts up
 * against the client clock (skew-free); otherwise it freezes at the LAST completed
 * action (endedAt), so the duration reflects real browsing time and never inflates
 * during the post-browse answer-generation phase or between actions.
 */
function elapsedMs(
  a: BrowserActivityEntry,
  now: number,
  clientStart: number | undefined,
  ticking: boolean,
): number | null {
  if (!a.startedAt) return null;
  if (ticking) return Math.max(0, now - (clientStart ?? a.startedAt));
  if (a.endedAt != null) return Math.max(0, a.endedAt - a.startedAt);
  return Math.max(0, now - a.startedAt);
}

function TraceIcon({ icon }: { icon: ToolIconKey }) {
  const common = { size: 12, className: "shrink-0 opacity-70" } as const;
  switch (icon) {
    case "web":
      return <Globe {...common} />;
    case "page":
      return <FileText {...common} />;
    case "edit":
      return <PenLine {...common} />;
    case "clock":
      return <Clock {...common} />;
    case "search":
      return <Search {...common} />;
    default:
      return <Wrench {...common} />;
  }
}

function StepStatusIcon({ status }: { status: BrowserStepStatus }) {
  switch (status) {
    case "running":
      return <Loader2 size={11} className="shrink-0 animate-spin opacity-70" />;
    case "failed":
      return <X size={11} className="shrink-0 text-danger opacity-80" />;
    default:
      return <Check size={11} className="shrink-0 text-accent opacity-70" />;
  }
}

/**
 * Live "Browser" working view rendered above the assistant's answer when it used
 * the built-in browser tools. Shows the current page, the latest screenshot, a
 * live "current action" line, and the ordered action trace. Stays expanded with a
 * ticking timer through the whole browsing phase, then collapses to a "Used
 * browser · N actions · Ns" pill once the answer begins (clickable to re-expand).
 * Renders nothing when the browser did no work.
 */
export function BrowserActivity({ browser, isStreaming }: BrowserActivityProps) {
  const activities = useMemo(() => browser.activities ?? [], [browser.activities]);
  const primary = activities[0];

  // "browsing" spans the whole browsing phase (including model-thinking gaps
  // between actions); it ends when the card settles (answer begins / turn ends).
  const browsing = !!isStreaming && !!primary && primary.status === "running";
  const now = useNow(browsing);
  const [expanded, setExpanded] = useState<boolean>(browsing);

  // Client-clock moment we first observed the card running (skew-free timer).
  const clientStartRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (primary?.startedAt && clientStartRef.current == null) {
      clientStartRef.current = Date.now();
    }
  }, [primary?.startedAt]);

  // Pin-to-bottom autoscroll for the (scrollable, while-active) trace, yielding
  // when the user scrolls up to read an earlier step.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useEffect(() => {
    setExpanded(browsing);
  }, [browsing]);

  const stepSignature = primary?.trace?.length ?? 0;
  useEffect(() => {
    if (!browsing || !pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [browsing, stepSignature]);

  if (!primary) return null;

  const trace = primary.trace ?? [];
  const stepCount = primary.steps ?? trace.length;
  // An action is genuinely in flight only when a trace step is still running.
  const actionInFlight = browsing && trace.some((s) => s.status === "running");
  const elapsed = elapsedMs(primary, now, clientStartRef.current, actionInFlight);
  const open = expanded || browsing;
  // Nothing sets the card-level status to "failed", so derive the failed header
  // from the trace: browsing settled and every action failed.
  const failed = !browsing && trace.length > 0 && trace.every((s) => s.status === "failed");
  const runningStep = actionInFlight ? trace.find((s) => s.status === "running") : undefined;
  const actionLabel = runningStep?.label ?? primary.action;

  const meta = [
    `${stepCount} ${stepCount === 1 ? "action" : "actions"}`,
    elapsed != null ? formatDuration(elapsed) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => {
          if (browsing) return;
          setExpanded((o) => !o);
        }}
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-text-secondary transition-colors",
          browsing ? "cursor-default" : "cursor-pointer hover:bg-hover hover:text-text-primary",
        )}
      >
        <Globe size={14} className={cn("opacity-80", browsing && "animate-pulse")} />
        <span className="font-medium">
          <span className={cn(browsing && "animate-pulse")}>
            {browsing ? "Browsing" : failed ? "Browser failed" : "Used browser"}
          </span>
          {meta && <span className="ml-1 tabular-nums opacity-70">· {meta}</span>}
        </span>
        {!browsing && (
          <ChevronDown
            size={14}
            className={cn("opacity-60 transition-transform", expanded && "rotate-180")}
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
          <div className="rounded-lg border border-border bg-hover/40 p-2">
            {(primary.title || primary.url) && (
              <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[12px] text-text-secondary">
                <Globe size={12} className="shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate" title={primary.url}>
                  {primary.title || primary.url}
                </span>
              </div>
            )}

            {primary.thumbnailDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={primary.thumbnailDataUrl}
                alt="Screenshot of the current page"
                className="mb-2 max-h-64 w-full rounded border border-border object-cover object-top"
              />
            )}

            {/* Live current-action line while an action is in flight. */}
            {actionInFlight && actionLabel && (
              <div className="mb-1 flex items-center gap-1.5 px-1 text-[12px] leading-relaxed text-text-secondary">
                {runningStep ? (
                  <TraceIcon icon={runningStep.icon} />
                ) : (
                  <Loader2 size={12} className="shrink-0 animate-spin opacity-70" />
                )}
                <span className="min-w-0 flex-1 animate-pulse truncate" title={actionLabel}>
                  {actionLabel}
                </span>
              </div>
            )}

            {trace.length > 0 && (
              <div
                ref={scrollRef}
                onScroll={onScroll}
                className={cn("px-1", browsing && "max-h-48 overflow-y-auto")}
              >
                <ul className="flex flex-col gap-0.5">
                  {trace.map((step, i) => (
                    <li
                      key={i}
                      className="flex items-center gap-1.5 py-0.5 text-[12px] leading-relaxed text-text-secondary"
                    >
                      <TraceIcon icon={step.icon} />
                      <span className="min-w-0 flex-1 truncate" title={step.label}>
                        {step.label}
                      </span>
                      <StepStatusIcon status={step.status} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default BrowserActivity;
