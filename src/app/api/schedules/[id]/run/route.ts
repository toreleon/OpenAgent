import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { runScheduleNow } from "@/lib/schedule/runner";
import { toScheduleRunSummary } from "@/lib/schedule/dto";
import { type ApiError } from "@/lib/types";

export const runtime = "nodejs";

interface RouteParams {
  params: { id: string };
}

/**
 * POST /api/schedules/[id]/run — fire this schedule now (trigger = "manual").
 * A manual run never shifts the cron cadence. Returns the created ScheduleRun
 * summary; 404 when the schedule is missing or not owned by the caller.
 */
export async function POST(_req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  const result = await runScheduleNow(params.id, userId);
  if (!result) {
    return Response.json({ error: "Not found" } satisfies ApiError, {
      status: 404,
    });
  }

  const run = await prisma.scheduleRun.findUnique({
    where: { id: result.runId },
  });
  if (!run) {
    return Response.json(
      { error: "Run record not found" } satisfies ApiError,
      { status: 500 },
    );
  }

  return Response.json(toScheduleRunSummary(run));
}
