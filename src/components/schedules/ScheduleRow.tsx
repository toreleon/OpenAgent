"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import type { ScheduleRunStatus, ScheduleSummary } from "@/lib/types";
import { useScheduleStore } from "@/store/schedules";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/components/ui/cn";
import { ScheduleRunList } from "./ScheduleRunList";

/** Format an ISO instant in a specific time zone, with an explicit tz label. */
function formatInZone(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: "short",
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

export interface ScheduleRowProps {
  schedule: ScheduleSummary;
  onEdit: (schedule: ScheduleSummary) => void;
}

export function ScheduleRow({ schedule, onEdit }: ScheduleRowProps) {
  const update = useScheduleStore((s) => s.update);
  const remove = useScheduleStore((s) => s.remove);
  const runNow = useScheduleStore((s) => s.runNow);

  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);

  const { enabled, nextRunAt, timezone, lastRun } = schedule;

  async function handleRunNow() {
    if (running) return;
    setRunning(true);
    await runNow(schedule.id);
    setRunning(false);
  }

  return (
    <div className="rounded-xl border border-border bg-sidebar/40">
      <div className="flex items-start gap-3 px-4 py-3.5">
        {/* Expand runs */}
        <button
          type="button"
          aria-label={expanded ? "Collapse run history" : "Show run history"}
          onClick={() => setExpanded((e) => !e)}
          className="mt-0.5 shrink-0 text-text-secondary transition-colors hover:text-text-primary"
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        {/* Main info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "truncate text-sm font-semibold",
                enabled ? "text-text-primary" : "text-text-secondary",
              )}
            >
              {schedule.title}
            </span>
            {running ? (
              <StatusChip status="running" />
            ) : (
              lastRun && <StatusChip status={lastRun.status} error={lastRun.error} />
            )}
          </div>

          <p className="mt-0.5 truncate text-xs text-text-secondary">
            {schedule.description || schedule.cron}
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
            <span className="inline-flex items-center gap-1">
              <Clock size={12} />
              {enabled && nextRunAt
                ? `Next: ${formatInZone(nextRunAt, timezone)}`
                : "Paused"}
            </span>
            {lastRun?.conversationId && (
              <Link
                href={`/c/${lastRun.conversationId}`}
                className="inline-flex items-center gap-1 text-accent hover:underline"
              >
                <MessageSquare size={12} /> Last conversation
              </Link>
            )}
          </div>
        </div>

        {/* Enable toggle */}
        <Toggle
          checked={enabled}
          onChange={(next) => void update(schedule.id, { enabled: next })}
          label={`${enabled ? "Disable" : "Enable"} ${schedule.title}`}
        />

        {/* Menu */}
        <Dropdown
          align="end"
          menuClassName="min-w-[11rem]"
          trigger={
            <span className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-border/50 hover:text-text-primary">
              <MoreHorizontal size={16} />
            </span>
          }
        >
          {(close) => (
            <>
              <DropdownItem
                onClick={() => {
                  void handleRunNow();
                  close();
                }}
              >
                <Play size={15} /> Run now
              </DropdownItem>
              <DropdownItem
                onClick={() => {
                  onEdit(schedule);
                  close();
                }}
              >
                <Pencil size={15} /> Edit
              </DropdownItem>
              <DropdownItem
                danger
                onClick={() => {
                  void remove(schedule.id);
                  close();
                }}
              >
                <Trash2 size={15} /> Delete
              </DropdownItem>
            </>
          )}
        </Dropdown>
      </div>

      {expanded && (
        <div className="border-t border-border/60 px-4 py-3">
          <ScheduleRunList scheduleId={schedule.id} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

function StatusChip({
  status,
  error,
}: {
  status: ScheduleRunStatus;
  error?: string | null;
}) {
  if (status === "success") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-green-500/15 px-2.5 py-0.5 text-xs font-medium text-green-400">
        <CheckCircle2 size={12} /> Success
      </span>
    );
  }
  if (status === "error") {
    return (
      <Tooltip label={error || "Run failed"}>
        <span className="inline-flex shrink-0 cursor-default items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 py-0.5 text-xs font-medium text-red-400">
          <AlertCircle size={12} /> Failed
        </span>
      </Tooltip>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-400">
      <Spinner size={11} className="text-amber-400" /> Running
    </span>
  );
}

// ---------------------------------------------------------------------------
// Toggle switch (mirrors the SettingsModal connector toggle)
// ---------------------------------------------------------------------------

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-text-secondary/50",
        checked ? "bg-accent" : "bg-border",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export default ScheduleRow;
