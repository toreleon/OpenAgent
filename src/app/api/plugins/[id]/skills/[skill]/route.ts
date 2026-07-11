import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { setSkillEnabled } from "@/lib/plugins";
import type { ApiError, UpdateSkillRequest } from "@/lib/types";

export const runtime = "nodejs";

interface RouteParams {
  params: { id: string; skill: string };
}

/** PATCH /api/plugins/[id]/skills/[skill] — enable/disable one skill. `[skill]`
 *  is the skill's name; the App Router already URL-decodes route params, so we
 *  use `params.skill` as-is (decoding it again would corrupt names containing
 *  '%'). */
export async function PATCH(req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const userId = session.user.id;

  let body: UpdateSkillRequest;
  try {
    body = (await req.json()) as UpdateSkillRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, { status: 400 });
  }
  if (typeof body?.enabled !== "boolean") {
    return Response.json(
      { error: "enabled (boolean) is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  const updated = await setSkillEnabled(userId, params.id, params.skill, body.enabled);
  if (!updated) {
    return Response.json({ error: "Not found" } satisfies ApiError, { status: 404 });
  }
  return Response.json(updated);
}
