import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { createSite, createSiteFromArtifact, loadUserSites } from "@/lib/sites";
import {
  type ApiError,
  type CreateSiteRequest,
  isSiteType,
  type SiteSummary,
  SITE_VISIBILITIES,
  type SiteVisibility,
} from "@/lib/types";

export const runtime = "nodejs";

/** GET /api/sites — this user's Sites, newest-updated first. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const sites: SiteSummary[] = await loadUserSites(prisma, session.user.id);
  return Response.json(sites);
}

/**
 * POST /api/sites — create a Site. Two modes:
 *  - `{ fromArtifactId }` seeds the draft from an existing artifact, or
 *  - `{ type, content }` creates a fresh Site.
 * New Sites start `private` and undeployed; the user reviews then deploys.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const userId = session.user.id;

  let body: CreateSiteRequest;
  try {
    body = (await req.json()) as CreateSiteRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, { status: 400 });
  }

  const visibility: SiteVisibility | undefined =
    body.visibility && (SITE_VISIBILITIES as string[]).includes(body.visibility)
      ? body.visibility
      : undefined;

  // Mode 1: publish an existing artifact as a Site.
  if (typeof body.fromArtifactId === "string" && body.fromArtifactId) {
    const result = await createSiteFromArtifact(prisma, userId, {
      artifactId: body.fromArtifactId,
      name: body.name,
      visibility,
    });
    if ("error" in result) {
      return Response.json({ error: result.error } satisfies ApiError, { status: 400 });
    }
    return Response.json(result, { status: 201 });
  }

  // Mode 2: fresh Site.
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return Response.json(
      { error: "Name must be a non-empty string" } satisfies ApiError,
      { status: 400 },
    );
  }
  if (!body.type || !isSiteType(body.type)) {
    return Response.json(
      { error: "A valid `type` (html, react, markdown, svg, mermaid) is required" } satisfies ApiError,
      { status: 400 },
    );
  }
  const detail = await createSite(prisma, userId, {
    name,
    draftType: body.type,
    draftContent: typeof body.content === "string" ? body.content : "",
    draftLanguage: typeof body.language === "string" ? body.language : null,
    description: typeof body.description === "string" ? body.description.trim() || null : null,
    visibility: visibility ?? "private",
    sourceType: "manual",
  });
  return Response.json(detail, { status: 201 });
}
