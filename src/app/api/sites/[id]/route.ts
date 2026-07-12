import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { deleteSite, loadSiteDetail, updateSiteMeta } from "@/lib/sites";
import {
  type ApiError,
  isSiteType,
  SITE_VISIBILITIES,
  type UpdateSiteRequest,
} from "@/lib/types";

export const runtime = "nodejs";

interface RouteParams {
  params: { id: string };
}

/** GET /api/sites/[id] — full Site detail (draft + version history). */
export async function GET(_req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const detail = await loadSiteDetail(prisma, session.user.id, params.id);
  if (!detail) {
    return Response.json({ error: "Not found" } satisfies ApiError, { status: 404 });
  }
  return Response.json(detail);
}

/**
 * PATCH /api/sites/[id] — edit in place (rename, description, visibility, or the
 * draft buffer from the editor). At least one field required.
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }

  let body: UpdateSiteRequest;
  try {
    body = (await req.json()) as UpdateSiteRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, { status: 400 });
  }

  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
    return Response.json(
      { error: "Name must be a non-empty string" } satisfies ApiError,
      { status: 400 },
    );
  }
  if (body.visibility !== undefined && !(SITE_VISIBILITIES as string[]).includes(body.visibility)) {
    return Response.json({ error: "Invalid visibility" } satisfies ApiError, { status: 400 });
  }
  if (body.draftType !== undefined && !isSiteType(body.draftType)) {
    return Response.json({ error: "Invalid draft type" } satisfies ApiError, { status: 400 });
  }

  const detail = await updateSiteMeta(prisma, session.user.id, params.id, {
    name: body.name,
    description: body.description,
    visibility: body.visibility,
    draftContent: body.draftContent,
    draftType: body.draftType,
    draftLanguage: body.draftLanguage,
  });
  if (!detail) {
    return Response.json({ error: "Not found" } satisfies ApiError, { status: 404 });
  }
  return Response.json(detail);
}

/** DELETE /api/sites/[id] — delete the Site and all its versions. */
export async function DELETE(_req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const ok = await deleteSite(prisma, session.user.id, params.id);
  if (!ok) {
    return Response.json({ error: "Not found" } satisfies ApiError, { status: 404 });
  }
  return Response.json({ success: true });
}
