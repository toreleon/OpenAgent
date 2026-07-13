"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Clock,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import type { ScheduleSummary } from "@/lib/types";
import { useScheduleStore } from "@/store/schedules";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { describeCronFriendly, nextRunLabel } from "@/lib/schedule/friendly";

export interface ScheduleRowProps {
  schedule: ScheduleSummary;
  onEdit: (schedule: ScheduleSummary) => void;
}

/** One task in the Scheduled-tasks list. */
export function ScheduleRow({ schedule, onEdit }: ScheduleRowProps) {
  const update = useScheduleStore((s) => s.update);
  const remove = useScheduleStore((s) => s.remove);
  const runNow = useScheduleStore((s) => s.runNow);
  const [running, setRunning] = useState(false);

  const { enabled, nextRunAt, timezone, lastRun } = schedule;
  const scheduleText = describeCronFriendly(schedule.cron) ?? schedule.description;
  const nextText = enabled && nextRunAt ? nextRunLabel(nextRunAt, timezone) : null;

  async function handleRunNow() {
    if (running) return;
    setRunning(true);
    await runNow(schedule.id);
    setRunning(false);
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-hover",
        !enabled && "opacity-55",
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-hover text-text-secondary">
        {running ? (
          <Spinner size={15} className="text-amber-400" />
        ) : lastRun?.status === "error" ? (
          <AlertCircle size={16} className="text-red-400" />
        ) : (
          <Clock size={16} />
        )}
      </span>

      <button
        type="button"
        onClick={() => onEdit(schedule)}
        className="flex min-w-0 flex-1 flex-col text-left"
        title={schedule.title}
      >
        <span className="truncate text-sm font-medium text-text-primary">
          {schedule.title}
        </span>
        <span className="truncate text-xs text-text-secondary">
          {scheduleText}
          {nextText ? ` · Next run ${nextText}` : !enabled ? " · Paused" : ""}
        </span>
      </button>

      {lastRun?.conversationId && (
        <Link
          href={`/c/${lastRun.conversationId}`}
          className="hidden shrink-0 text-xs text-text-secondary transition-colors hover:text-text-primary group-hover:inline"
        >
          View last run
        </Link>
      )}

      <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          onClick={() => onEdit(schedule)}
          aria-label={`Edit ${schedule.title}`}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-border/50 hover:text-text-primary"
        >
          <Pencil size={15} />
        </button>
        <Dropdown
          align="end"
          menuClassName="min-w-[11rem]"
          trigger={
            <span className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-border/50 hover:text-text-primary">
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
                  void update(schedule.id, { enabled: !enabled });
                  close();
                }}
              >
                {enabled ? <Pause size={15} /> : <Play size={15} />}
                {enabled ? "Pause" : "Resume"}
              </DropdownItem>
              <DropdownItem
                danger
                onClick={() => {
                  if (window.confirm(`Delete “${schedule.title}”? This can’t be undone.`)) {
                    void remove(schedule.id);
                  }
                  close();
                }}
              >
                <Trash2 size={15} /> Delete
              </DropdownItem>
            </>
          )}
        </Dropdown>
      </div>
    </div>
  );
}

export default ScheduleRow;
