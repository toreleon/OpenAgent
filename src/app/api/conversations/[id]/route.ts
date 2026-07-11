import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { loadConversationArtifacts } from "@/lib/artifacts";
import { toConversationSummary } from "@/lib/conversations";
import {
  type ApiError,
  type ArtifactRef,
  type Attachment,
  type ChatMessage,
  type ChatRole,
  type ConversationDetail,
  type ConversationSummary,
  type ResearchState,
  type ToolCallRecord,
  type TraceItem,
  type UpdateConversationRequest,
} from "@/lib/types";

export const runtime = "nodejs";

interface RouteParams {
  params: { id: string };
}

/** Decode a JSON-string DB column into a typed array, tolerating bad data. */
function decodeJsonArray<T>(value: string | null): T[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed as T[];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Decode the Deep Research JSON column so the activity block rehydrates on reload. */
function decodeResearch(value: string | null): ResearchState | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as ResearchState;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** GET /api/conversations/[id] — full conversation with messages (oldest first). */
export async function GET(_req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  const conversation = await prisma.conversation.findFirst({
    where: { id: params.id, userId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!conversation) {
    return Response.json({ error: "Not found" } satisfies ApiError, {
      status: 404,
    });
  }

  const messages: ChatMessage[] = conversation.messages.map((m) => ({
    id: m.id,
    role: m.role as ChatRole,
    content: m.content,
    attachments: decodeJsonArray<Attachment>(m.attachments),
    toolCalls: decodeJsonArray<ToolCallRecord>(m.toolCalls),
    // Re-hydrate the Thinking trace so it survives a reload: the reasoning
    // summary, its frozen duration, and the ordered interleaved timeline.
    reasoning: m.reasoning ?? undefined,
    reasoningMs: m.reasoningMs ?? undefined,
    timeline: decodeJsonArray<TraceItem>(m.timeline),
    artifactRefs: decodeJsonArray<ArtifactRef>(m.artifactRefs),
    research: decodeResearch(m.research),
    createdAt: m.createdAt.toISOString(),
  }));

  const artifacts = await loadConversationArtifacts(prisma, conversation.id);

  const detail: ConversationDetail = {
    id: conversation.id,
    title: conversation.title,
    model: conversation.model,
    projectId: conversation.projectId,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    messages,
    artifacts,
  };

  return Response.json(detail);
}

/**
 * PATCH /api/conversations/[id] — edit-in-place. Supports renaming (`title`)
 * and/or moving the conversation into a project (`projectId: "<id>"`) or out of
 * one (`projectId: null`). At least one field must be provided.
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  let body: UpdateConversationRequest;
  try {
    body = (await req.json()) as UpdateConversationRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, {
      status: 400,
    });
  }

  const data: { title?: string; projectId?: string | null } = {};

  // Rename: when `title` is present it must be a non-empty string.
  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return Response.json(
        { error: "Title must be a non-empty string" } satisfies ApiError,
        { status: 400 },
      );
    }
    data.title = title;
  }

  // Move/remove: `projectId` null removes from a project; a string moves into a
  // project the user owns (unknown/unowned → 404 so we never leak existence).
  if (body.projectId !== undefined) {
    if (body.projectId === null) {
      data.projectId = null;
    } else if (typeof body.projectId === "string" && body.projectId) {
      const project = await prisma.project.findFirst({
        where: { id: body.projectId, userId },
        select: { id: true },
      });
      if (!project) {
        return Response.json({ error: "Not found" } satisfies ApiError, {
          status: 404,
        });
      }
      data.projectId = project.id;
    } else {
      return Response.json(
        { error: "projectId must be a project id or null" } satisfies ApiError,
        { status: 400 },
      );
    }
  }

  if (data.title === undefined && data.projectId === undefined) {
    return Response.json(
      { error: "Provide a title and/or projectId to update" } satisfies ApiError,
      { status: 400 },
    );
  }

  // Ownership check to avoid leaking existence.
  const existing = await prisma.conversation.findFirst({
    where: { id: params.id, userId },
    select: { id: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" } satisfies ApiError, {
      status: 404,
    });
  }

  const updated = await prisma.conversation.update({
    where: { id: params.id },
    data,
    select: {
      id: true,
      title: true,
      model: true,
      projectId: true,
      updatedAt: true,
    },
  });

  const summary: ConversationSummary = toConversationSummary(updated);

  return Response.json(summary);
}

/** DELETE /api/conversations/[id] — delete (cascades to messages). */
export async function DELETE(_req: Request, { params }: RouteParams) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, {
      status: 401,
    });
  }
  const userId = session.user.id;

  const existing = await prisma.conversation.findFirst({
    where: { id: params.id, userId },
    select: { id: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" } satisfies ApiError, {
      status: 404,
    });
  }

  await prisma.conversation.delete({ where: { id: params.id } });

  return Response.json({ success: true });
}
