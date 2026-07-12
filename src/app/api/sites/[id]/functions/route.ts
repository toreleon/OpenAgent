/**
 * OWNER management of a Site's sandboxed server functions (Phase 4). Authenticated
 * + ownership-checked. The MODEL proposes functions (disarmed); the OWNER reviews
 * the exact source here and ARMS by sending the hash of the code the panel rendered
 * (closing the arm TOCTOU). Disarm is an instant per-function live kill.
 */
import { createHash } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { siteStore } from "@/lib/sites/data-db";
import { functionsEnabled } from "@/lib/sites/fn/pool";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

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

/** GET → functions with source (the review surface) + arm state + tier flags. */
export async function GET(_req: Request, { params }: RouteParams) {
  const owner = await requireOwner(params.id);
  if (owner instanceof Response) return owner;
  const rows = await siteStore.listFunctions(params.id);
  const globalKill = await siteStore.functionsGloballyDisabled();
  return Response.json({
    flagEnabled: functionsEnabled(),
    globalKill,
    functions: rows.map((f) => {
      const hash = sha256(f.code);
      return {
        name: f.name,
        code: f.code,
        hash,
        armed: !!f.armedHash,
        upToDate: f.armedHash === hash,
        updatedAt: f.updatedAt.toISOString(),
      };
    }),
  });
}

/**
 * POST — arm { name, expectedHash } (409 on stale) OR disarm { name, action:"disarm" }.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const owner = await requireOwner(params.id);
  if (owner instanceof Response) return owner;

  let body: { name?: unknown; expectedHash?: unknown; action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name : "";
  if (!NAME_RE.test(name)) {
    return Response.json({ error: "Invalid function name" } satisfies ApiError, { status: 400 });
  }

  if (body.action === "disarm") {
    await siteStore.disarmFunction(params.id, name);
    return Response.json({ success: true });
  }

  const expectedHash = typeof body.expectedHash === "string" ? body.expectedHash : "";
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    return Response.json({ error: "Missing/invalid expectedHash" } satisfies ApiError, { status: 400 });
  }
  const res = await siteStore.armFunction(params.id, name, expectedHash);
  if (res.ok) return Response.json({ success: true });
  if (res.reason === "stale") {
    return Response.json(
      { error: "Code changed since you reviewed it — re-review and arm again." } satisfies ApiError,
      { status: 409 },
    );
  }
  return Response.json({ error: "Unknown function" } satisfies ApiError, { status: 404 });
}

/** DELETE ?name=... — remove a function. */
export async function DELETE(req: Request, { params }: RouteParams) {
  const owner = await requireOwner(params.id);
  if (owner instanceof Response) return owner;
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!NAME_RE.test(name)) {
    return Response.json({ error: "Invalid function name" } satisfies ApiError, { status: 400 });
  }
  await siteStore.deleteFunction(params.id, name);
  return Response.json({ success: true });
}
