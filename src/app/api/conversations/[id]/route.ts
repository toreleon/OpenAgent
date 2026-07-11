import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { loadConversationArtifacts } from "@/lib/artifacts";
import {
  type ApiError,
  type ArtifactRef,
  type Attachment,
  type ChatMessage,
  type ChatRole,
  type ConversationDetail,
  type ConversationSummary,
  type ToolCallRecord,
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
    artifactRefs: decodeJsonArray<ArtifactRef>(m.artifactRefs),
    createdAt: m.createdAt.toISOString(),
  }));

  const artifacts = await loadConversationArtifacts(prisma, conversation.id);

  const detail: ConversationDetail = {
    id: conversation.id,
    title: conversation.title,
    model: conversation.model,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    messages,
    artifacts,
  };

  return Response.json(detail);
}

/** PATCH /api/conversations/[id] — rename. */
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

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) {
    return Response.json(
      { error: "Title must be a non-empty string" } satisfies ApiError,
      { status: 400 },
    );
  }

  // Ownership check via updateMany count to avoid leaking existence.
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
    data: { title },
    select: { id: true, title: true, model: true, updatedAt: true },
  });

  const summary: ConversationSummary = {
    id: updated.id,
    title: updated.title,
    model: updated.model,
    updatedAt: updated.updatedAt.toISOString(),
  };

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
