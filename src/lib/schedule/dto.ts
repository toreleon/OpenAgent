/**
 * Pure serializers that map Prisma rows to the wire DTOs consumed by the
 * schedules UI. No database access and no cron-parser here — the only cron
 * dependency is `describeCron`, which turns the stored 5-field expression into
 * the human-readable `description` field. Keeping these functions side-effect-
 * free lets every route reuse them and keeps date/enum coercion in one place.
 */
import type { Schedule, ScheduleRun } from "@prisma/client";
import { describeCron } from "@/lib/schedule/cron";
import type {
  ReasoningEffort,
  ScheduleDetail,
  ScheduleRunStatus,
  ScheduleRunSummary,
  ScheduleSummary,
  ScheduleTrigger,
} from "@/lib/types";

/** Serialize one ScheduleRun row to its API summary. */
export function toScheduleRunSummary(run: ScheduleRun): ScheduleRunSummary {
  return {
    id: run.id,
    status: run.status as ScheduleRunStatus,
    trigger: run.trigger as ScheduleTrigger,
    conversationId: run.conversationId,
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}

/**
 * Serialize a Schedule row to its list/summary DTO. `lastRun` is the schedule's
 * most recent run (already serialized), or null when it has never fired. The
 * `description` field is derived from `cron` via cronstrue.
 */
export function toScheduleSummary(
  schedule: Schedule,
  lastRun: ScheduleRunSummary | null,
): ScheduleSummary {
  return {
    id: schedule.id,
    title: schedule.title,
    prompt: schedule.prompt,
    model: schedule.model,
    effort: schedule.effort as ReasoningEffort,
    cron: schedule.cron,
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    description: describeCron(schedule.cron),
    nextRunAt: schedule.nextRunAt ? schedule.nextRunAt.toISOString() : null,
    lastRunAt: schedule.lastRunAt ? schedule.lastRunAt.toISOString() : null,
    lastRun,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

/**
 * Serialize a Schedule plus its recent run history (newest first). The newest
 * run doubles as `lastRun` on the embedded summary, so callers only need to
 * pass the ordered run list once.
 */
export function toScheduleDetail(
  schedule: Schedule,
  runs: ScheduleRun[],
): ScheduleDetail {
  const runSummaries = runs.map(toScheduleRunSummary);
  const lastRun = runSummaries.length > 0 ? runSummaries[0] : null;
  return {
    ...toScheduleSummary(schedule, lastRun),
    runs: runSummaries,
  };
}
