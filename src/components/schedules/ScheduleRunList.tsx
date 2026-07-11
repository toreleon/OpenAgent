"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import type {
  ScheduleDetail,
  ScheduleRunStatus,
  ScheduleRunSummary,
} from "@/lib/types";
import { Spinner } from "@/components/ui/Spinner";

/** Format an ISO instant in the viewer's local zone with a tz label. */
function formatLocal(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export interface ScheduleRunListProps {
  scheduleId: string;
}

/**
 * Compact run history. Fetches the schedule detail on mount (so it only loads
 * when the parent row is expanded) and lists recent fire attempts with their
 * status and a link to the conversation each produced.
 */
export function ScheduleRunList({ scheduleId }: ScheduleRunListProps) {
  const [runs, setRuns] = useState<ScheduleRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRuns(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/schedules/${scheduleId}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error("Failed to load run history");
        const data = (await res.json()) as ScheduleDetail;
        if (!cancelled) setRuns(data.runs);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load run history");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scheduleId]);

  if (error) {
    return <p className="text-xs text-red-400">{error}</p>;
  }

  if (runs === null) {
    return (
      <div className="flex items-center justify-center py-4 text-text-secondary">
        <Spinner size={16} />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <p className="py-2 text-xs text-text-secondary">
        No runs yet. Trigger one with “Run now”.
      </p>
    );
  }

  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
        Recent runs
      </p>
      <ul className="flex flex-col gap-1">
        {runs.map((run) => (
          <li
            key={run.id}
            className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-hover"
          >
            <RunStatusDot status={run.status} />
            <span className="w-16 shrink-0 text-xs capitalize text-text-secondary">
              {run.trigger}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-text-secondary tabular-nums">
              {formatLocal(run.startedAt)}
              {run.status === "error" && run.error ? ` — ${run.error}` : ""}
            </span>
            {run.conversationId && (
              <Link
                href={`/c/${run.conversationId}`}
                className="inline-flex shrink-0 items-center gap-1 text-xs text-accent hover:underline"
              >
                Open <ExternalLink size={11} />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunStatusDot({ status }: { status: ScheduleRunStatus }) {
  if (status === "success") {
    return <CheckCircle2 size={14} className="shrink-0 text-green-400" />;
  }
  if (status === "error") {
    return <AlertCircle size={14} className="shrink-0 text-red-400" />;
  }
  return <Spinner size={12} className="shrink-0 text-amber-400" />;
}

export default ScheduleRunList;
