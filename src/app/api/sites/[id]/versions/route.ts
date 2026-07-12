import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { saveSiteVersion } from "@/lib/sites";
import { type ApiError, type SaveSiteVersionRequest } from "@/lib/types";

export const runtime = "nodejs";

interface RouteParams {
  params: { id: string };
}

/**
 * POST /api/sites/[id]/versions — "Save a Version": snapshot the current draft
 * into a new immutable SiteVersion (a deployable candidate). Does NOT change the
 * live site. Deduplicated: an unchanged draft returns the existing latest version.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }

  let label: string | null = null;
  try {
    const body = (await req.json()) as SaveSiteVersionRequest;
    if (typeof body?.label === "string" && body.label.trim()) label = body.label.trim();
  } catch {
    // Body is optional for this endpoint.
  }

  const detail = await saveSiteVersion(prisma, session.user.id, params.id, { label });
  if (!detail) {
    return Response.json({ error: "Not found" } satisfies ApiError, { status: 404 });
  }
  return Response.json(detail);
}
