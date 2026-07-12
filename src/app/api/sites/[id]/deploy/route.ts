import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { deploySite, unpublishSite } from "@/lib/sites";
import { type ApiError, type DeploySiteRequest } from "@/lib/types";

export const runtime = "nodejs";

interface RouteParams {
  params: { id: string };
}

/**
 * POST /api/sites/[id]/deploy — "Deploy a Version": publish a saved version to
 * the live public URL. With no `versionId` the current draft is snapshotted and
 * that snapshot is deployed. This is the ONLY place the live pointer moves for a
 * human action (the model can also deploy iff User.sitesAutoDeploy is on).
 */
export async function POST(req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }

  let versionId: string | undefined;
  try {
    const body = (await req.json()) as DeploySiteRequest;
    if (typeof body?.versionId === "string" && body.versionId) versionId = body.versionId;
  } catch {
    // Body is optional (deploy the current draft).
  }

  const detail = await deploySite(prisma, session.user.id, params.id, { versionId });
  if (!detail) {
    return Response.json(
      { error: "Not found or version does not belong to this site" } satisfies ApiError,
      { status: 404 },
    );
  }
  return Response.json(detail);
}

/** DELETE /api/sites/[id]/deploy — take the Site offline (null the live pointer). */
export async function DELETE(_req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const detail = await unpublishSite(prisma, session.user.id, params.id);
  if (!detail) {
    return Response.json({ error: "Not found" } satisfies ApiError, { status: 404 });
  }
  return Response.json(detail);
}
