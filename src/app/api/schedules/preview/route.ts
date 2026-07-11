import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  validateCron,
  nextRuns,
  normalizeTimeZone,
  PREVIEW_RUN_COUNT,
} from "@/lib/schedule/cron";
import { type ApiError, type CronPreviewResponse } from "@/lib/types";

export const runtime = "nodejs";

/**
 * GET /api/schedules/preview?cron=..&tz=.. — live validation + next fire times
 * for the schedule form. Auth-required (it exercises the same cron engine as
 * create/update) but touches no user data. Invalid crons return valid:false
 * with the reason in both `error` and `description`.
 */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }

  const url = new URL(req.url);
  const cron = (url.searchParams.get("cron") ?? "").trim();
  const timezone = normalizeTimeZone(url.searchParams.get("tz"));

  const check = validateCron(cron);
  if (!check.valid) {
    const message = check.error ?? "Invalid schedule";
    return Response.json({
      valid: false,
      description: message,
      nextRuns: [],
      error: message,
    } satisfies CronPreviewResponse);
  }

  const runs = nextRuns(cron, timezone, PREVIEW_RUN_COUNT).map((d) =>
    d.toISOString(),
  );

  return Response.json({
    valid: true,
    description: check.description ?? "",
    nextRuns: runs,
  } satisfies CronPreviewResponse);
}
