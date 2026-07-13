import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { publishArtifact } from "@/lib/sites";
import { type ApiError } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/artifacts/publish — the human "Publish" action for the unified
 * Artifacts feature. Given `{ artifactId }`, it create-or-reuses the artifact's
 * shadow Site, makes it link-visible, and deploys it to its live public URL,
 * returning the SiteDetail (with `publicPath`). Unlike the model path this is NOT
 * gated by auto-publish — the user explicitly clicked Publish.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }

  let artifactId = "";
  try {
    const body = (await req.json()) as { artifactId?: unknown };
    if (typeof body?.artifactId === "string") artifactId = body.artifactId;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, { status: 400 });
  }
  if (!artifactId) {
    return Response.json({ error: "`artifactId` is required" } satisfies ApiError, { status: 400 });
  }

  const result = await publishArtifact(prisma, {
    userId: session.user.id,
    artifactId,
    makePublic: true,
  });
  if (!result.ok) {
    return Response.json({ error: result.error } satisfies ApiError, { status: 400 });
  }
  return Response.json(result.detail, { status: 200 });
}
