import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";

/**
 * GET /api/user/export — a JSON archive of the user's account + conversations
 * (with messages). Returned as a file download (Content-Disposition attachment),
 * mirroring a standard "Export data" flow (minus the email-a-link flow).
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const userId = session.user.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, createdAt: true },
  });

  const conversations = await prisma.conversation.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: { role: true, content: true, createdAt: true },
      },
    },
  });

  const archive = {
    exportedAt: new Date().toISOString(),
    user: {
      name: user?.name ?? null,
      email: user?.email ?? null,
      createdAt: user?.createdAt?.toISOString() ?? null,
    },
    conversations: conversations.map((c) => ({
      id: c.id,
      title: c.title,
      model: c.model,
      createdAt: c.createdAt.toISOString(),
      messages: c.messages.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    })),
  };

  return new Response(JSON.stringify(archive, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="chat-data-export.json"',
    },
  });
}
