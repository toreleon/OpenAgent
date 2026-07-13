"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FileText,
  Globe,
  Loader2,
  PenLine,
  Search,
  Sparkles,
  Telescope,
  X,
} from "lucide-react";
import type {
  ResearchActivity as ResearchActivityEntry,
  ResearchActivityKind,
  ResearchActivityStatus,
  ResearchState,
} from "@/lib/types";
import { cn } from "@/components/ui/cn";

export interface ResearchActivityProps {
  /** The accumulated research state (plan + live activity log). */
  research: ResearchState;
  /** True while research events are still arriving for this message. */
  isStreaming?: boolean;
}

/** Extract a compact hostname for a source URL (best-effort). */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The leading icon for an activity row, chosen by kind. */
function KindIcon({ kind }: { kind: ResearchActivityKind }) {
  const common = { size: 13, className: "shrink-0 opacity-70" } as const;
  switch (kind) {
    case "search":
      return <Search {...common} />;
    case "source":
      return <Globe {...common} />;
    case "analyze":
      return <Sparkles {...common} />;
    case "synthesize":
      return <PenLine {...common} />;
    default:
      return <FileText {...common} />;
  }
}

/** The trailing status indicator: spinner / check / x. */
function StatusIcon({ status }: { status: ResearchActivityStatus }) {
  switch (status) {
    case "active":
      return (
        <Loader2 size={13} className="shrink-0 animate-spin text-text-secondary" />
      );
    case "done":
      return <Check size={13} className="shrink-0 text-accent" />;
    case "failed":
      return <X size={13} className="shrink-0 text-red-400" />;
    default:
      return null;
  }
}

function ActivityRow({ activity }: { activity: ResearchActivityEntry }) {
  const isSourceLink = activity.kind === "source" && !!activity.url;
  return (
    <div className="flex items-center gap-2 py-0.5 text-[13px] leading-relaxed text-text-secondary">
      <KindIcon kind={activity.kind} />
      {isSourceLink ? (
        <a
          href={activity.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-text-primary underline-offset-2 hover:underline"
          title={activity.title}
        >
          {activity.title || hostnameOf(activity.url!)}
          <span className="ml-1.5 text-text-secondary opacity-70">
            {hostnameOf(activity.url!)}
          </span>
        </a>
      ) : (
        <span className="min-w-0 flex-1 truncate" title={activity.title}>
          {activity.title}
        </span>
      )}
      <StatusIcon status={activity.status} />
    </div>
  );
}

/**
 * A collapsible "Research" activity block rendered above a deep
 * research report.
 *
 * - While streaming (and not yet in the report phase): auto-expanded,
 *   auto-scrolling, with a pulsing "Researching…" header.
 * - Once finished: collapses to a clickable "Researched N sources" pill with a
 *   chevron; clicking re-expands the plan + full activity log.
 * - Renders nothing when there is no plan and no activity to show.
 */
export function ResearchActivity({ research, isStreaming }: ResearchActivityProps) {
  const activities = research.activities ?? [];
  const plan = research.plan;
  const subtopics = plan?.subtopics ?? [];

  // Sources are counted from the explicit tally when present, otherwise from
  // the completed `source` activities.
  const doneSources = activities.filter(
    (a) => a.kind === "source" && a.status === "done",
  ).length;
  const sourceCount = research.sourceCount ?? doneSources;

  // Actively researching until the report phase begins.
  const researching = !!isStreaming && research.phase !== "report";
  const hasBody = !!plan || activities.length > 0;

  // Expanded while researching; collapses by default once done. The user can
  // toggle it open again afterwards.
  const [expanded, setExpanded] = useState<boolean>(researching);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the live view expanded during research and collapse when it ends.
  useEffect(() => {
    setExpanded(researching);
  }, [researching]);

  // Auto-scroll the activity log to the newest row as events stream in.
  useEffect(() => {
    if (!researching) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activities.length, researching]);

  // Nothing to show yet.
  if (!researching && !hasBody) return null;

  const open = expanded || researching;

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => {
          // Don't allow collapsing while research is in progress.
          if (researching) return;
          setExpanded((o) => !o);
        }}
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-text-secondary transition-colors",
          researching
            ? "cursor-default"
            : "cursor-pointer hover:bg-hover hover:text-text-primary",
        )}
      >
        <Telescope
          size={14}
          className={cn("opacity-80", researching && "animate-pulse")}
        />
        {researching ? (
          <span className="animate-pulse font-medium">Researching…</span>
        ) : (
          <span className="font-medium">
            Researched {sourceCount} {sourceCount === 1 ? "source" : "sources"}
          </span>
        )}
        {!researching && hasBody && (
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
            className={cn(
              "border-l-2 border-border pl-3 text-text-secondary",
              researching && "max-h-72 overflow-y-auto",
            )}
          >
            {plan && (
              <div className="mb-2">
                {plan.title && (
                  <div className="mb-1.5 text-[13px] font-medium text-text-primary">
                    {plan.title}
                  </div>
                )}
                {subtopics.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {subtopics.map((s, i) => (
                      <li
                        key={`${i}-${s.title}`}
                        className="flex items-start gap-2 text-[13px] leading-relaxed"
                      >
                        <Check
                          size={13}
                          className="mt-0.5 shrink-0 text-accent opacity-80"
                        />
                        <span className="min-w-0">{s.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {activities.length > 0 && (
              <div
                className={cn(
                  "flex flex-col",
                  plan && "mt-2 border-t border-border pt-2",
                )}
              >
                {activities.map((a) => (
                  <ActivityRow key={a.id} activity={a} />
                ))}
              </div>
            )}

            {!plan && activities.length === 0 && researching && (
              <span className="text-[13px] italic opacity-70">
                Planning research…
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ResearchActivity;
