/**
 * Scheduler engine: the single funnel every trigger (the in-process ticker and
 * the external /api/cron endpoint) calls into. It claims due schedules atomically
 * (compare-and-swap on `nextRunAt`, the claim token) so the two triggers never
 * double-fire, then, per fire, seeds a brand-new conversation, runs the agent as
 * the owning user, and logs the attempt as a ScheduleRun.
 *
 * SERVER-ONLY: pulls in Prisma + the agent engine. Never import from client code.
 */
import prisma from "@/lib/db";
import { runChatCompletion } from "@/lib/agent";
import { computeNextRun } from "@/lib/schedule/cron";
import type { ChatMessage, ReasoningEffort, ScheduleTrigger } from "@/lib/types";

/**
 * Stringify an array for a JSON DB column, or null when empty/absent. Mirrors
 * the encoder used by /api/chat so scheduled runs persist tool calls identically.
 */
function encodeJsonArray(value: unknown[] | undefined | null): string | null {
  if (!value || value.length === 0) return null;
  return JSON.stringify(value);
}

/** The Schedule fields a single fire needs. Matches a full prisma.schedule row. */
interface ScheduleForRun {
  id: string;
  userId: string;
  title: string;
  prompt: string;
  model: string;
  effort: string;
}

/**
 * Execute one fire of a schedule end-to-end: create the run log, seed a new
 * conversation with the prompt, run the agent to completion, persist the reply,
 * and finalize the run status. Never throws — any failure is captured on the
 * ScheduleRun as status "error" so one schedule's failure never aborts a batch.
 */
async function executeScheduleRun(
  schedule: ScheduleForRun,
  trigger: ScheduleTrigger,
): Promise<{ runId: string; conversationId: string | null }> {
  // 1) Log the attempt up front so an early failure is still recorded.
  const runRecord = await prisma.scheduleRun.create({
    data: { scheduleId: schedule.id, status: "running", trigger },
  });

  let conversationId: string | null = null;

  try {
    // 2) Seed a brand-new conversation for this fire, linked back to the schedule.
    const conversation = await prisma.conversation.create({
      data: {
        userId: schedule.userId,
        title: schedule.title,
        model: schedule.model,
        scheduleId: schedule.id,
      },
    });
    conversationId = conversation.id;

    // 3) Link the run to its conversation.
    await prisma.scheduleRun.update({
      where: { id: runRecord.id },
      data: { conversationId },
    });

    // 4) Persist the schedule prompt as the seed user message.
    const userMsg = await prisma.message.create({
      data: {
        conversationId,
        role: "user",
        content: schedule.prompt,
        attachments: null,
        toolCalls: null,
      },
    });

    const userMessage: ChatMessage = {
      id: userMsg.id,
      role: "user",
      content: schedule.prompt,
      createdAt: userMsg.createdAt.toISOString(),
    };

    // 5) Run the agent to completion. runChatCompletion never throws; a failure
    //    is surfaced on result.error alongside whatever was assembled.
    const result = await runChatCompletion({
      model: schedule.model,
      history: [],
      userMessage,
      effort: schedule.effort as ReasoningEffort,
      userId: schedule.userId,
    });

    // 6) Persist the assistant reply (JSON columns mirror the chat route).
    await prisma.message.create({
      data: {
        conversationId,
        role: "assistant",
        content: result.content,
        attachments: null,
        toolCalls: encodeJsonArray(result.toolCalls),
        reasoning: result.reasoning ?? null,
        reasoningMs: result.reasoningMs ?? null,
      },
    });

    // 7) Bump the conversation so it sorts to the top of the user's list.
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    // 8) Finalize run health from the agent result.
    await prisma.scheduleRun.update({
      where: { id: runRecord.id },
      data: {
        status: result.error ? "error" : "success",
        error: result.error ?? null,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    console.error("[scheduler] run failed for schedule", schedule.id, err);
    // Best-effort: mark the run errored so the batch continues and the failure
    // is visible in the run log.
    try {
      await prisma.scheduleRun.update({
        where: { id: runRecord.id },
        data: {
          status: "error",
          error: err instanceof Error ? err.message : "Scheduled run failed",
          finishedAt: new Date(),
        },
      });
    } catch (updateErr) {
      console.error(
        "[scheduler] failed to mark run errored",
        runRecord.id,
        updateErr,
      );
    }
  }

  return { runId: runRecord.id, conversationId };
}

/**
 * Find every enabled schedule whose `nextRunAt` is due (<= now), claim each one
 * atomically, and run it.
 *
 * The claim is a compare-and-swap: updateMany matches on the exact `nextRunAt`
 * value we just read and rolls it forward to the next fire time. Only the trigger
 * whose update touches exactly one row proceeds — this is what stops the ticker
 * and /api/cron from double-firing the same schedule.
 *
 * - wait === true  → await every claimed run (used by /api/cron so a serverless
 *   invocation finishes the work before the response returns).
 * - wait === false → fire-and-forget each run and return the claimed count
 *   immediately (used by the 60s ticker so its callback returns promptly).
 *
 * Returns the number of schedules claimed this tick.
 */
export async function runDueSchedules(opts?: {
  now?: Date;
  wait?: boolean;
}): Promise<{ started: number }> {
  const now = opts?.now ?? new Date();
  const wait = opts?.wait ?? false;

  const due = await prisma.schedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
  });

  let started = 0;

  for (const schedule of due) {
    // Roll the claim token forward to the next fire time in the schedule's tz.
    // Base this on a FRESH timestamp captured at claim time, not the batch-start
    // `now`: in the wait:true path runs are awaited sequentially, so a schedule
    // claimed after a slow earlier run would otherwise advance from a stale `now`
    // that may already be in the past — causing an immediate duplicate fire on
    // the next tick for fast-cadence schedules. `claimAt` is always >= `now`.
    const claimAt = new Date();
    const claimNextRun = computeNextRun(
      schedule.cron,
      schedule.timezone,
      claimAt,
    );

    let claimed = 0;
    try {
      const res = await prisma.schedule.updateMany({
        where: {
          id: schedule.id,
          nextRunAt: schedule.nextRunAt,
          enabled: true,
        },
        data: { nextRunAt: claimNextRun, lastRunAt: claimAt },
      });
      claimed = res.count;
    } catch (err) {
      console.error("[scheduler] failed to claim schedule", schedule.id, err);
      continue;
    }

    // Lost the race (another trigger claimed it) or the schedule changed under
    // us — skip without running.
    if (claimed !== 1) continue;

    started += 1;

    if (wait) {
      // Serverless/cron path: run to completion before returning. Guarded so one
      // schedule's failure never aborts the loop.
      try {
        await executeScheduleRun(schedule, "cron");
      } catch (err) {
        console.error(
          "[scheduler] unexpected run error for schedule",
          schedule.id,
          err,
        );
      }
    } else {
      // Ticker path: fire-and-forget so the tick returns promptly.
      void executeScheduleRun(schedule, "cron").catch((err) => {
        console.error(
          "[scheduler] unexpected run error for schedule",
          schedule.id,
          err,
        );
      });
    }
  }

  return { started };
}

/** Default age after which a still-"running" run is considered orphaned (30 min). */
const STUCK_RUN_MAX_AGE_MS = 30 * 60_000;

/**
 * Reconcile ScheduleRun rows left in "running" by a crash or restart mid-run.
 * A run that started longer than `maxAgeMs` ago and never finished can never
 * complete (the process that owned it is gone), so mark it "error" so the run
 * history/UI never shows a perpetual spinner. Called once when the ticker boots.
 * The generous default age (30 min) sits well beyond any single agent turn, so a
 * legitimately in-flight run is never mislabeled.
 */
export async function reconcileStuckRuns(
  maxAgeMs: number = STUCK_RUN_MAX_AGE_MS,
): Promise<{ reconciled: number }> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  try {
    const res = await prisma.scheduleRun.updateMany({
      where: { status: "running", startedAt: { lt: cutoff } },
      data: {
        status: "error",
        error: "Interrupted (server restarted or crashed mid-run)",
        finishedAt: new Date(),
      },
    });
    if (res.count > 0) {
      console.log("[scheduler] reconciled", res.count, "stuck run(s)");
    }
    return { reconciled: res.count };
  } catch (err) {
    console.error("[scheduler] failed to reconcile stuck runs", err);
    return { reconciled: 0 };
  }
}

/**
 * Run a schedule immediately as a manual trigger. Verifies ownership and returns
 * null when the schedule is missing or owned by another user. Manual runs never
 * shift the cadence, so `nextRunAt`/`lastRunAt` are left untouched. Awaits the
 * run to completion so the caller receives a finished ScheduleRun.
 */
export async function runScheduleNow(
  scheduleId: string,
  userId: string,
): Promise<{ runId: string; conversationId: string | null } | null> {
  const schedule = await prisma.schedule.findFirst({
    where: { id: scheduleId, userId },
  });
  if (!schedule) return null;

  return executeScheduleRun(schedule, "manual");
}
