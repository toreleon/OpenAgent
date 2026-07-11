import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { setPluginEnabled, deletePlugin } from "@/lib/plugins";
import type { ApiError, UpdatePluginRequest } from "@/lib/types";

export const runtime = "nodejs";

interface RouteParams {
  params: { id: string };
}

/** PATCH /api/plugins/[id] — enable/disable a plugin. */
export async function PATCH(req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const userId = session.user.id;

  let body: UpdatePluginRequest;
  try {
    body = (await req.json()) as UpdatePluginRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, { status: 400 });
  }
  if (typeof body?.enabled !== "boolean") {
    return Response.json(
      { error: "enabled (boolean) is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  const updated = await setPluginEnabled(userId, params.id, body.enabled);
  if (!updated) {
    return Response.json({ error: "Not found" } satisfies ApiError, { status: 404 });
  }
  return Response.json(updated);
}

/** DELETE /api/plugins/[id] — uninstall a plugin (removes bundled MCP + files). */
export async function DELETE(_req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const ok = await deletePlugin(session.user.id, params.id);
  if (!ok) {
    return Response.json({ error: "Not found" } satisfies ApiError, { status: 404 });
  }
  return Response.json({ success: true });
}
