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
  type SiteRef,
  type SubagentState,
  type BrowserState,
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

/** Decode the parallel-subagents JSON column so the panel rehydrates on reload. */
function decodeSubagents(value: string | null): SubagentState | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as SubagentState;
    return parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.agents) &&
      parsed.agents.length > 0
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Decode the browser-control JSON column so the panel rehydrates on reload. */
function decodeBrowser(value: string | null): BrowserState | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as BrowserState;
    return parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.activities) &&
      parsed.activities.length > 0
      ? parsed
      : undefined;
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
    parentId: m.parentId ?? null,
    content: m.content,
    attachments: decodeJsonArray<Attachment>(m.attachments),
    toolCalls: decodeJsonArray<ToolCallRecord>(m.toolCalls),
    // Re-hydrate the Thinking trace so it survives a reload: the reasoning
    // summary, its frozen duration, and the ordered interleaved timeline.
    reasoning: m.reasoning ?? undefined,
    reasoningMs: m.reasoningMs ?? undefined,
    timeline: decodeJsonArray<TraceItem>(m.timeline),
    artifactRefs: decodeJsonArray<ArtifactRef>(m.artifactRefs),
    siteRefs: decodeJsonArray<SiteRef>(m.siteRefs),
    research: decodeResearch(m.research),
    subagents: decodeSubagents(m.subagents),
    browser: decodeBrowser(m.browser),
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
    activeLeafId: conversation.activeLeafId ?? null,
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

  const data: {
    title?: string;
    projectId?: string | null;
    activeLeafId?: string;
  } = {};

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

  // Branch switch: `activeLeafId` must name a message in this conversation
  // (validated below, after the ownership check, so we never leak existence).
  const switchLeafId =
    body.activeLeafId !== undefined
      ? typeof body.activeLeafId === "string" && body.activeLeafId
        ? body.activeLeafId
        : null
      : undefined;
  if (switchLeafId === null) {
    return Response.json(
      { error: "activeLeafId must be a non-empty message id" } satisfies ApiError,
      { status: 400 },
    );
  }

  if (
    data.title === undefined &&
    data.projectId === undefined &&
    switchLeafId === undefined
  ) {
    return Response.json(
      {
        error: "Provide a title, projectId, and/or activeLeafId to update",
      } satisfies ApiError,
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

  // Verify the target leaf belongs to this conversation before pointing at it.
  if (switchLeafId !== undefined) {
    const leaf = await prisma.message.findFirst({
      where: { id: switchLeafId, conversationId: params.id },
      select: { id: true },
    });
    if (!leaf) {
      return Response.json({ error: "Not found" } satisfies ApiError, {
        status: 404,
      });
    }
    data.activeLeafId = leaf.id;
  }

  // A pure version-switch (only activeLeafId changes) is read-only navigation, so
  // it must NOT bump updatedAt — otherwise merely paging message versions would
  // reorder the chat to the top of the sidebar. Prisma applies @updatedAt on every
  // .update(), so persist the leaf with a raw UPDATE that leaves updatedAt intact.
  // Any title/project edit uses the normal path (which does bump updatedAt).
  const onlyLeafSwitch =
    data.title === undefined &&
    data.projectId === undefined &&
    data.activeLeafId !== undefined;

  if (onlyLeafSwitch) {
    await prisma.$executeRaw`UPDATE "Conversation" SET "activeLeafId" = ${data.activeLeafId} WHERE "id" = ${params.id}`;
  } else {
    await prisma.conversation.update({ where: { id: params.id }, data });
  }

  const updated = await prisma.conversation.findUniqueOrThrow({
    where: { id: params.id },
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
