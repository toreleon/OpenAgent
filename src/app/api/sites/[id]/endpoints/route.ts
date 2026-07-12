/**
 * OWNER-ONLY management of a Site's proxied endpoints (Phase 3). Authenticated +
 * ownership-checked. The model PROPOSES endpoints (unarmed) via create_site; the
 * owner ARMS one here by approving the exact destination host + which secrets it
 * may inject. An endpoint is un-invocable until armed — this is the human gate
 * that stops a prompt-injected model from exfiltrating a secret to its own host.
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { siteStore } from "@/lib/sites/data-db";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

interface RouteParams {
  params: { id: string };
}

async function requireOwner(siteId: string): Promise<string | Response> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const owned = await prisma.site.findFirst({
    where: { id: siteId, userId: session.user.id },
    select: { id: true },
  });
  if (!owned) return Response.json({ error: "Not found" } satisfies ApiError, { status: 404 });
  return session.user.id;
}

/** GET /api/sites/[id]/endpoints — list endpoints (proposed + armed) for the UI. */
export async function GET(_req: Request, { params }: RouteParams) {
  const owner = await requireOwner(params.id);
  if (owner instanceof Response) return owner;
  const endpoints = (await siteStore.listEndpoints(params.id)).map((e) => ({
    ...e,
    secretRefs: safeParseStrings(e.secretRefs),
  }));
  return Response.json({ endpoints });
}

/**
 * POST /api/sites/[id]/endpoints — ARM an endpoint:
 * { name, approvedHost, secretRefs?, dailyBudget? }.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const owner = await requireOwner(params.id);
  if (owner instanceof Response) return owner;

  let body: { name?: unknown; approvedHost?: unknown; secretRefs?: unknown; dailyBudget?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name : "";
  const approvedHost = typeof body.approvedHost === "string" ? body.approvedHost.trim().toLowerCase() : "";
  const secretRefs = Array.isArray(body.secretRefs)
    ? body.secretRefs.filter((x): x is string => typeof x === "string" && NAME_RE.test(x))
    : [];
  const dailyBudget = typeof body.dailyBudget === "number" ? Math.max(0, Math.floor(body.dailyBudget)) : undefined;

  if (!NAME_RE.test(name)) {
    return Response.json({ error: "Invalid endpoint name" } satisfies ApiError, { status: 400 });
  }
  // approvedHost must be a bare host[:port], no scheme/path/spaces.
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(approvedHost)) {
    return Response.json({ error: "Invalid approved host" } satisfies ApiError, { status: 400 });
  }
  const ok = await siteStore.armEndpoint(params.id, name, { approvedHost, secretRefs, dailyBudget });
  if (!ok) {
    return Response.json({ error: "Unknown endpoint" } satisfies ApiError, { status: 404 });
  }
  return Response.json({ success: true });
}

function safeParseStrings(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
