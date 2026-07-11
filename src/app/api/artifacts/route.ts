import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadUserArtifacts } from "@/lib/artifacts";
import prisma from "@/lib/db";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";

/** GET /api/artifacts — every artifact owned by the signed-in user. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }

  return Response.json(await loadUserArtifacts(prisma, session.user.id));
}
