import fsp from "fs/promises";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  installFromSource,
  persistInstall,
  listPlugins,
  PluginInstallError,
  GitCloneError,
} from "@/lib/plugins";
import type {
  ApiError,
  InstallPluginRequest,
  InstallPluginResponse,
  PluginSourceType,
} from "@/lib/types";

// Needs Node APIs (child_process/git, fs) — never the edge runtime.
export const runtime = "nodejs";

/** GET /api/plugins — list the current user's installed plugins, newest first. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const plugins = await listPlugins(session.user.id);
  return Response.json(plugins);
}

/** POST /api/plugins — install a plugin from a git repo or local folder. */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const userId = session.user.id;

  let body: InstallPluginRequest;
  try {
    body = (await req.json()) as InstallPluginRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, { status: 400 });
  }

  const sourceType = body?.sourceType;
  if (sourceType !== "git" && sourceType !== "local") {
    return Response.json(
      { error: 'sourceType must be "git" or "local"' } satisfies ApiError,
      { status: 400 },
    );
  }
  const source = typeof body?.source === "string" ? body.source.trim() : "";
  if (!source) {
    return Response.json(
      { error: "A source (git URL or local path) is required" } satisfies ApiError,
      { status: 400 },
    );
  }
  const ref = typeof body?.ref === "string" && body.ref.trim() ? body.ref.trim() : undefined;
  if (body?.trusted !== true) {
    return Response.json(
      {
        error:
          "You must trust the plugin to install it — its skill instructions run in the assistant's prompt.",
      } satisfies ApiError,
      { status: 400 },
    );
  }

  let result;
  try {
    result = await installFromSource({
      userId,
      sourceType: sourceType as PluginSourceType,
      source,
      ref,
    });
  } catch (err) {
    if (err instanceof PluginInstallError || err instanceof GitCloneError) {
      return Response.json({ error: err.message } satisfies ApiError, { status: 400 });
    }
    console.error("[plugins] install failed:", err);
    return Response.json(
      { error: "Plugin installation failed." } satisfies ApiError,
      { status: 500 },
    );
  }

  try {
    const plugins = await persistInstall(userId, result, {
      sourceType: sourceType as PluginSourceType,
      sourceUrl: source,
      gitRef: ref ?? null,
    });
    const response: InstallPluginResponse = { plugins, warnings: result.warnings };
    return Response.json(response, { status: 201 });
  } catch (err) {
    // Persist failed after files were copied — clean up the orphaned install dirs.
    console.error("[plugins] persist failed:", err);
    for (const p of result.plugins) {
      await fsp.rm(p.installPath, { recursive: true, force: true }).catch(() => {});
    }
    return Response.json(
      { error: "Failed to save the installed plugin." } satisfies ApiError,
      { status: 500 },
    );
  }
}
