import { timingSafeEqual } from "node:crypto";
import { runDueSchedules } from "@/lib/schedule/runner";
import type { ApiError, CronTriggerResult } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Constant-time secret comparison. Length is compared first (an unavoidable,
 * non-sensitive leak) so `timingSafeEqual` only ever sees equal-length buffers;
 * the byte comparison itself doesn't short-circuit, so response time doesn't
 * correlate with how long a prefix matched.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Read the presented cron secret from either accepted header form:
 *   Authorization: Bearer <CRON_SECRET>
 *   X-Cron-Secret: <CRON_SECRET>
 */
function readPresentedSecret(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const header = req.headers.get("x-cron-secret");
  if (header && header.trim()) return header.trim();
  return null;
}

/**
 * Shared handler for the public, CRON_SECRET-guarded cron endpoint. Drives the
 * same runDueSchedules() funnel as the in-process ticker, but with wait:true so a
 * serverless invocation finishes the work before responding.
 */
async function handle(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { error: "CRON_SECRET is not configured" } satisfies ApiError,
      { status: 503 },
    );
  }

  const presented = readPresentedSecret(req);
  if (!presented || !secretsMatch(presented, secret)) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }

  const { started } = await runDueSchedules({ wait: true });
  return Response.json({
    started,
    at: new Date().toISOString(),
  } satisfies CronTriggerResult);
}

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}

export async function GET(req: Request): Promise<Response> {
  return handle(req);
}
