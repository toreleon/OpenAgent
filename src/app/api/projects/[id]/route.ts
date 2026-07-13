import { unlink } from "fs/promises";
import path from "path";
import { getServerSession } from "next-auth";
import { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { toProjectDetail, toProjectSummary } from "@/lib/projects/dto";
import {
  type ApiError,
  isProjectIconName,
  type UpdateProjectRequest,
} from "@/lib/types";

export const runtime = "nodejs";

interface RouteParams {
  params: { id: string };
}

/** GET /api/projects/[id] — full project with knowledge files and member chats. */
export async function GET(_req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  const project = await prisma.project.findFirst({
    where: { id: params.id, userId },
  });
  if (!project) {
    return Response.json({ error: "Not found" } satisfies ApiError, {
      status: 404,
    });
  }

  const files = await prisma.projectFile.findMany({
    where: { projectId: params.id },
    orderBy: { createdAt: "desc" },
  });

  const conversations = await prisma.conversation.findMany({
    where: { projectId: params.id, userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      model: true,
      projectId: true,
      updatedAt: true,
    },
  });

  return Response.json(toProjectDetail(project, files, conversations));
}

/**
 * PATCH /api/projects/[id] — edit in place. Any subset of fields may be sent
 * (at least one required). `name` must stay non-empty; `description` and
 * `instructions` accept a string (trimmed, stored null when empty) or null to
 * clear the field.
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  let body: UpdateProjectRequest;
  try {
    body = (await req.json()) as UpdateProjectRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, {
      status: 400,
    });
  }

  const data: Prisma.ProjectUpdateInput = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return Response.json(
        { error: "Name must be a non-empty string" } satisfies ApiError,
        { status: 400 },
      );
    }
    data.name = name;
  }

  if (body.icon !== undefined) {
    if (!isProjectIconName(body.icon)) {
      return Response.json({ error: "Invalid project icon" } satisfies ApiError, {
        status: 400,
      });
    }
    data.icon = body.icon;
  }

  // description/instructions: null clears; a string is trimmed and stored null
  // when it collapses to empty.
  if (body.description !== undefined) {
    data.description =
      typeof body.description === "string"
        ? body.description.trim() || null
        : null;
  }

  if (body.instructions !== undefined) {
    data.instructions =
      typeof body.instructions === "string"
        ? body.instructions.trim() || null
        : null;
  }

  if (Object.keys(data).length === 0) {
    return Response.json(
      { error: "Provide at least one field to update" } satisfies ApiError,
      { status: 400 },
    );
  }

  // Ownership check to avoid leaking existence.
  const existing = await prisma.project.findFirst({
    where: { id: params.id, userId },
    select: { id: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" } satisfies ApiError, {
      status: 404,
    });
  }

  const updated = await prisma.project.update({
    where: { id: params.id },
    data,
    include: { _count: { select: { conversations: true, files: true } } },
  });

  return Response.json(
    toProjectSummary(updated, {
      conversations: updated._count.conversations,
      files: updated._count.files,
    }),
  );
}

/**
 * DELETE /api/projects/[id] — deleting a project deletes its chats. SQLite
 * enforces no FK on Conversation.projectId, so we
 * cascade the conversations manually FIRST (their messages/artifacts cascade via
 * real FKs), then delete the project (ProjectFile rows cascade via real FK).
 */
export async function DELETE(_req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  const existing = await prisma.project.findFirst({
    where: { id: params.id, userId },
    select: { id: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" } satisfies ApiError, {
      status: 404,
    });
  }

  // Capture the on-disk upload paths before the rows cascade away so we can
  // clean them up (matches the single-file delete route). Otherwise deleted
  // projects would leave publicly-served orphans under public/uploads.
  const files = await prisma.projectFile.findMany({
    where: { projectId: params.id },
    select: { url: true },
  });

  await prisma.conversation.deleteMany({
    where: { projectId: params.id, userId },
  });
  await prisma.project.delete({ where: { id: params.id } });

  // Best-effort removal of the persisted uploads; ignore failures (a missing
  // file is fine — the DB rows are already gone).
  await Promise.allSettled(
    files.map((f) => unlink(path.join(process.cwd(), "public", f.url))),
  );

  return Response.json({ success: true });
}
