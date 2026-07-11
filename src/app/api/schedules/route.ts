import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { validateCron, computeNextRun, normalizeTimeZone } from "@/lib/schedule/cron";
import { toScheduleRunSummary, toScheduleSummary } from "@/lib/schedule/dto";
import {
  MODELS,
  DEFAULT_MODEL,
  REASONING_EFFORTS,
  DEFAULT_EFFORT,
  type ApiError,
  type CreateScheduleRequest,
  type ReasoningEffort,
  type ScheduleSummary,
} from "@/lib/types";

export const runtime = "nodejs";

/** Normalize a client model id to a known MODELS id, falling back to default. */
function normalizeModel(model: unknown): string {
  return typeof model === "string" && MODELS.some((m) => m.id === model)
    ? model
    : DEFAULT_MODEL;
}

/** Coerce an effort to a supported REASONING_EFFORTS id, else the default. */
function normalizeEffort(effort: unknown): ReasoningEffort {
  return typeof effort === "string" &&
    REASONING_EFFORTS.some((e) => e.id === effort && e.supported)
    ? (effort as ReasoningEffort)
    : DEFAULT_EFFORT;
}

/** GET /api/schedules — this user's schedules, newest first, with latest run. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  // One query enriches every schedule with its most recent run (take 1, desc).
  const schedules = await prisma.schedule.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { runs: { orderBy: { startedAt: "desc" }, take: 1 } },
  });

  const summaries: ScheduleSummary[] = schedules.map((schedule) => {
    const latest = schedule.runs[0]
      ? toScheduleRunSummary(schedule.runs[0])
      : null;
    return toScheduleSummary(schedule, latest);
  });

  return Response.json(summaries);
}

/** POST /api/schedules — create a schedule. Validates cron (400 on invalid). */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  let body: CreateScheduleRequest;
  try {
    body = (await req.json()) as CreateScheduleRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, {
      status: 400,
    });
  }

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) {
    return Response.json(
      { error: "Title must be a non-empty string" } satisfies ApiError,
      { status: 400 },
    );
  }

  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return Response.json(
      { error: "Prompt must be a non-empty string" } satisfies ApiError,
      { status: 400 },
    );
  }

  const cron = typeof body?.cron === "string" ? body.cron.trim() : "";
  const cronCheck = validateCron(cron);
  if (!cronCheck.valid) {
    return Response.json(
      { error: cronCheck.error ?? "Invalid cron expression" } satisfies ApiError,
      { status: 400 },
    );
  }

  const timezone = normalizeTimeZone(body.timezone);
  const model = normalizeModel(body.model);
  const effort = normalizeEffort(body.effort);
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
  const nextRunAt = enabled ? computeNextRun(cron, timezone) : null;

  const schedule = await prisma.schedule.create({
    data: {
      userId,
      title,
      prompt,
      model,
      effort,
      cron,
      timezone,
      enabled,
      nextRunAt,
    },
  });

  // A freshly created schedule has no runs yet.
  const summary = toScheduleSummary(schedule, null);
  return Response.json(summary, { status: 201 });
}
