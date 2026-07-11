import { getServerSession } from "next-auth";
import { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { validateCron, computeNextRun, normalizeTimeZone } from "@/lib/schedule/cron";
import { toScheduleDetail, toScheduleRunSummary, toScheduleSummary } from "@/lib/schedule/dto";
import {
  MODELS,
  DEFAULT_MODEL,
  REASONING_EFFORTS,
  DEFAULT_EFFORT,
  type ApiError,
  type ReasoningEffort,
  type UpdateScheduleRequest,
} from "@/lib/types";

export const runtime = "nodejs";

/** How many recent runs the detail endpoint returns (newest first). */
const DETAIL_RUN_LIMIT = 20;

interface RouteParams {
  params: { id: string };
}

/** Normalize a client model id to a known MODELS id, falling back to default. */
function normalizeModel(model: string): string {
  return MODELS.some((m) => m.id === model) ? model : DEFAULT_MODEL;
}

/** Coerce an effort to a supported REASONING_EFFORTS id, else the default. */
function normalizeEffort(effort: string): ReasoningEffort {
  return REASONING_EFFORTS.some((e) => e.id === effort && e.supported)
    ? (effort as ReasoningEffort)
    : DEFAULT_EFFORT;
}

/** GET /api/schedules/[id] — full schedule with its recent run history. */
export async function GET(_req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  const schedule = await prisma.schedule.findFirst({
    where: { id: params.id, userId },
    include: {
      runs: { orderBy: { startedAt: "desc" }, take: DETAIL_RUN_LIMIT },
    },
  });

  if (!schedule) {
    return Response.json({ error: "Not found" } satisfies ApiError, {
      status: 404,
    });
  }

  return Response.json(toScheduleDetail(schedule, schedule.runs));
}

/**
 * PATCH /api/schedules/[id] — edit in place. Any subset of fields may be sent.
 * When cron, timezone, or enabled changes we recompute nextRunAt (null while
 * disabled) so the cadence stays consistent with the new settings.
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  let body: UpdateScheduleRequest;
  try {
    body = (await req.json()) as UpdateScheduleRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, {
      status: 400,
    });
  }

  // Ownership check; also load the fields we need to recompute nextRunAt.
  const existing = await prisma.schedule.findFirst({
    where: { id: params.id, userId },
    select: { id: true, cron: true, timezone: true, enabled: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" } satisfies ApiError, {
      status: 404,
    });
  }

  const data: Prisma.ScheduleUpdateInput = {};

  if (typeof body.title === "string") {
    const title = body.title.trim();
    if (!title) {
      return Response.json(
        { error: "Title must be a non-empty string" } satisfies ApiError,
        { status: 400 },
      );
    }
    data.title = title;
  }

  if (typeof body.prompt === "string") {
    const prompt = body.prompt.trim();
    if (!prompt) {
      return Response.json(
        { error: "Prompt must be a non-empty string" } satisfies ApiError,
        { status: 400 },
      );
    }
    data.prompt = prompt;
  }

  const cronProvided = typeof body.cron === "string";
  const tzProvided = typeof body.timezone === "string";
  const enabledProvided = typeof body.enabled === "boolean";

  let nextCron = existing.cron;
  if (cronProvided) {
    const cron = (body.cron as string).trim();
    const cronCheck = validateCron(cron);
    if (!cronCheck.valid) {
      return Response.json(
        {
          error: cronCheck.error ?? "Invalid cron expression",
        } satisfies ApiError,
        { status: 400 },
      );
    }
    data.cron = cron;
    nextCron = cron;
  }

  let nextTimezone = existing.timezone;
  if (tzProvided) {
    nextTimezone = normalizeTimeZone(body.timezone);
    data.timezone = nextTimezone;
  }

  if (typeof body.model === "string") {
    data.model = normalizeModel(body.model);
  }

  if (typeof body.effort === "string") {
    data.effort = normalizeEffort(body.effort);
  }

  let nextEnabled = existing.enabled;
  if (enabledProvided) {
    nextEnabled = body.enabled as boolean;
    data.enabled = nextEnabled;
  }

  // Recompute the claim token whenever the cadence-affecting fields change.
  if (cronProvided || tzProvided || enabledProvided) {
    data.nextRunAt = nextEnabled
      ? computeNextRun(nextCron, nextTimezone)
      : null;
  }

  const updated = await prisma.schedule.update({
    where: { id: params.id },
    data,
    include: { runs: { orderBy: { startedAt: "desc" }, take: 1 } },
  });

  const latest = updated.runs[0] ? toScheduleRunSummary(updated.runs[0]) : null;
  return Response.json(toScheduleSummary(updated, latest));
}

/**
 * DELETE /api/schedules/[id]. There is no DB-level FK from Conversation.scheduleId
 * to Schedule (SQLite couldn't ALTER one in), so we manually null the link on
 * this schedule's conversations FIRST, then delete the schedule. ScheduleRun
 * rows cascade via their real FK.
 */
export async function DELETE(_req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  const existing = await prisma.schedule.findFirst({
    where: { id: params.id, userId },
    select: { id: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" } satisfies ApiError, {
      status: 404,
    });
  }

  // Preserve past run chats: detach them before removing the schedule. Run both
  // statements in one transaction so we never leave conversations detached while
  // the schedule still exists (there is no DB-level FK to cascade this for us).
  await prisma.$transaction([
    prisma.conversation.updateMany({
      where: { scheduleId: params.id },
      data: { scheduleId: null },
    }),
    prisma.schedule.delete({ where: { id: params.id } }),
  ]);

  return Response.json({ success: true });
}
