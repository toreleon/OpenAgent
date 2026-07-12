/**
 * OWNER-ONLY management of a Site's fetch-proxy secrets (Phase 3). Authenticated
 * + ownership-checked. Values are write-only: they are encrypted on write and
 * NEVER returned (GET lists names only). This is the out-of-band surface the
 * model can't reach — the human owner sets the secret a proxy endpoint injects.
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { siteStore } from "@/lib/sites/data-db";
import { secretsEnabled } from "@/lib/sites/secrets";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

interface RouteParams {
  params: { id: string };
}

/** Verify the session owns the site; return the userId or a 401/404 Response. */
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

/** GET /api/sites/[id]/secrets — secret NAMES + whether the vault is configured. */
export async function GET(_req: Request, { params }: RouteParams) {
  const owner = await requireOwner(params.id);
  if (owner instanceof Response) return owner;
  return Response.json({ enabled: secretsEnabled(), names: await siteStore.listSecretNames(params.id) });
}

/** POST /api/sites/[id]/secrets — set a secret { name, value } (write-only). */
export async function POST(req: Request, { params }: RouteParams) {
  const owner = await requireOwner(params.id);
  if (owner instanceof Response) return owner;

  let body: { name?: unknown; value?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name : "";
  const value = typeof body.value === "string" ? body.value : "";
  if (!NAME_RE.test(name)) {
    return Response.json({ error: "Invalid secret name" } satisfies ApiError, { status: 400 });
  }
  if (!value || value.length > 4096) {
    return Response.json({ error: "Value required (max 4096 chars)" } satisfies ApiError, { status: 400 });
  }
  const ok = await siteStore.setSecret(params.id, name, value);
  if (!ok) {
    return Response.json(
      { error: "Secret vault disabled (set SITES_SECRETS_KEK)" } satisfies ApiError,
      { status: 400 },
    );
  }
  return Response.json({ success: true });
}

/** DELETE /api/sites/[id]/secrets?name=... — remove a secret. */
export async function DELETE(req: Request, { params }: RouteParams) {
  const owner = await requireOwner(params.id);
  if (owner instanceof Response) return owner;
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!NAME_RE.test(name)) {
    return Response.json({ error: "Invalid secret name" } satisfies ApiError, { status: 400 });
  }
  await siteStore.deleteSecret(params.id, name);
  return Response.json({ success: true });
}
