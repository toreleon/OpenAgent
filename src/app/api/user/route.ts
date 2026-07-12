import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { deleteUserSites } from "@/lib/sites";
import { parseCustomInstructions } from "@/lib/user/prompt";
import {
  type ApiError,
  type CustomInstructions,
  type UpdateUserRequest,
  type UserProfile,
} from "@/lib/types";

export const runtime = "nodejs";

interface UserRow {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  customInstructions: string | null;
}

function toProfile(u: UserRow): UserProfile {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    image: u.image,
    customInstructions: parseCustomInstructions(u.customInstructions),
  };
}

const SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
  customInstructions: true,
} as const;

/** GET /api/user — the signed-in user's profile + settings. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: SELECT,
  });
  if (!user) {
    return Response.json({ error: "Not found" } satisfies ApiError, { status: 404 });
  }
  return Response.json(toProfile(user));
}

/** Coerce an arbitrary body value to a full CustomInstructions. */
function sanitizeInstructions(v: unknown): CustomInstructions {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === "string" ? x.slice(0, 4000) : "");
  return {
    nickname: s(o.nickname),
    occupation: s(o.occupation),
    traits: s(o.traits),
    about: s(o.about),
    enabled: o.enabled !== false,
  };
}

/** PATCH /api/user — update display name and/or custom instructions. */
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }

  let body: UpdateUserRequest;
  try {
    body = (await req.json()) as UpdateUserRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" } satisfies ApiError, { status: 400 });
  }

  const data: { name?: string | null; customInstructions?: string } = {};
  if (body.name !== undefined) {
    data.name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  }
  if (body.customInstructions !== undefined) {
    data.customInstructions = JSON.stringify(sanitizeInstructions(body.customInstructions));
  }
  if (Object.keys(data).length === 0) {
    return Response.json(
      { error: "Provide name and/or customInstructions" } satisfies ApiError,
      { status: 400 },
    );
  }

  const updated = await prisma.user.update({
    where: { id: session.user.id },
    data,
    select: SELECT,
  });
  return Response.json(toProfile(updated));
}

/** DELETE /api/user — permanently delete the account and all its data. */
export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
  }
  // Sites are user-owned and published to public URLs, so remove them (and their
  // versions) explicitly FIRST — never leave a deleted account's sites live.
  await deleteUserSites(prisma, session.user.id);
  // Cascades conversations/messages/artifacts, projects/files, schedules/runs,
  // connectors, accounts, and sessions via their FKs.
  await prisma.user.delete({ where: { id: session.user.id } });
  return Response.json({ success: true });
}
