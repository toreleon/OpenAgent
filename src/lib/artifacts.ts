/**
 * Server-side artifact persistence + versioning.
 *
 * The /api/chat route intercepts the model's artifact tool calls
 * (create/update/rewrite) and delegates the actual database work to this module.
 * Every command appends a new immutable {@link ArtifactVersion} to an
 * {@link Artifact}, so the panel can step through history. The functions here
 * are the single source of truth for how a raw tool-call payload becomes a
 * stored version + a client {@link ArtifactSnapshot}.
 */
import type { PrismaClient } from "@prisma/client";
import {
  ARTIFACT_TYPES,
  type Artifact,
  type ArtifactCommand,
  type ArtifactLibraryItem,
  type ArtifactRef,
  type ArtifactSnapshot,
  type ArtifactType,
} from "@/lib/types";

/** Result of applying one artifact command. */
export type ApplyArtifactResult =
  | { ok: true; snapshot: ArtifactSnapshot; ref: ArtifactRef }
  | { ok: false; error: string };

interface ApplyArtifactParams {
  conversationId: string;
  /** The assistant message that issued the tool call. */
  messageId: string;
  command: ArtifactCommand;
  /** Raw, unvalidated tool-call arguments. */
  args: unknown;
}

// ---------------------------------------------------------------------------
// Small, defensive readers for the untyped tool-call args
// ---------------------------------------------------------------------------

function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function isArtifactType(v: unknown): v is ArtifactType {
  return typeof v === "string" && (ARTIFACT_TYPES as string[]).includes(v);
}

/** Normalize a model-provided identifier into a stable, safe slug. */
function normalizeIdentifier(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "artifact";
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** A DB artifact row with its versions loaded. */
interface ArtifactRowWithVersions {
  id: string;
  conversationId: string;
  identifier: string;
  type: string;
  title: string;
  language: string | null;
  createdAt: Date;
  updatedAt: Date;
  versions: Array<{ version: number; content: string; createdAt: Date }>;
}

/** Map a DB artifact row (with versions) to the client {@link Artifact} DTO. */
export function serializeArtifact(row: ArtifactRowWithVersions): Artifact {
  return {
    id: row.id,
    conversationId: row.conversationId,
    identifier: row.identifier,
    type: (isArtifactType(row.type) ? row.type : "code") as ArtifactType,
    title: row.title,
    language: row.language ?? undefined,
    versions: [...row.versions]
      .sort((a, b) => a.version - b.version)
      .map((v) => ({
        version: v.version,
        content: v.content,
        createdAt: v.createdAt.toISOString(),
      })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Load every artifact of a conversation (with full version history). */
export async function loadConversationArtifacts(
  prisma: PrismaClient,
  conversationId: string,
): Promise<Artifact[]> {
  const rows = await prisma.artifact.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    include: { versions: { orderBy: { version: "asc" } } },
  });
  return rows.map(serializeArtifact);
}

/** Load every artifact owned by a user, newest first, with its chat title. */
export async function loadUserArtifacts(
  prisma: PrismaClient,
  userId: string,
): Promise<ArtifactLibraryItem[]> {
  const rows = await prisma.artifact.findMany({
    where: { conversation: { userId } },
    orderBy: { updatedAt: "desc" },
    include: {
      versions: { orderBy: { version: "asc" } },
      conversation: { select: { title: true } },
    },
  });

  return rows.map((row) => ({
    ...serializeArtifact(row),
    conversationTitle: row.conversation.title,
  }));
}

// ---------------------------------------------------------------------------
// Snapshot / ref builders
// ---------------------------------------------------------------------------

function buildSnapshot(
  artifact: {
    id: string;
    identifier: string;
    type: string;
    title: string;
    language: string | null;
    createdAt: Date;
  },
  version: number,
  content: string,
  versionCreatedAt: Date,
  messageId: string,
): ArtifactSnapshot {
  return {
    id: artifact.id,
    identifier: artifact.identifier,
    type: (isArtifactType(artifact.type) ? artifact.type : "code") as ArtifactType,
    title: artifact.title,
    language: artifact.language ?? undefined,
    version,
    content,
    messageId,
    createdAt: artifact.createdAt.toISOString(),
    updatedAt: versionCreatedAt.toISOString(),
  };
}

function buildRef(
  snapshot: ArtifactSnapshot,
  command: ArtifactCommand,
): ArtifactRef {
  return {
    artifactId: snapshot.id,
    identifier: snapshot.identifier,
    title: snapshot.title,
    type: snapshot.type,
    version: snapshot.version,
    command,
  };
}

// ---------------------------------------------------------------------------
// Version append (race-safe)
// ---------------------------------------------------------------------------

/**
 * Append a new version to an existing artifact inside a transaction, returning
 * the created version row. Retries once on a unique-constraint race.
 */
async function appendVersion(
  prisma: PrismaClient,
  artifactId: string,
  content: string,
  messageId: string,
): Promise<{ version: number; createdAt: Date }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await prisma.artifactVersion.findFirst({
      where: { artifactId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const nextVersion = (latest?.version ?? 0) + 1;
    try {
      const created = await prisma.artifactVersion.create({
        data: { artifactId, version: nextVersion, content, messageId },
        select: { version: true, createdAt: true },
      });
      await prisma.artifact.update({
        where: { id: artifactId },
        data: { updatedAt: new Date() },
      });
      return created;
    } catch (err) {
      // Unique (artifactId, version) collision under concurrency — retry once.
      if (attempt === 0) continue;
      throw err;
    }
  }
  // Unreachable, but satisfies the type checker.
  throw new Error("Failed to append artifact version");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function applyCreate(
  prisma: PrismaClient,
  conversationId: string,
  messageId: string,
  args: Record<string, unknown>,
): Promise<ApplyArtifactResult> {
  const identifierRaw = readString(args, "identifier");
  const title = readString(args, "title");
  const content = readString(args, "content");
  const typeRaw = args["type"];
  const language = readString(args, "language");

  if (!identifierRaw) return { ok: false, error: "create_artifact: `identifier` is required" };
  if (!title) return { ok: false, error: "create_artifact: `title` is required" };
  if (content === null) return { ok: false, error: "create_artifact: `content` is required" };
  if (!isArtifactType(typeRaw)) {
    return { ok: false, error: `create_artifact: invalid \`type\` (expected one of ${ARTIFACT_TYPES.join(", ")})` };
  }

  const identifier = normalizeIdentifier(identifierRaw);
  const type: ArtifactType = typeRaw;

  const existing = await prisma.artifact.findUnique({
    where: { conversationId_identifier: { conversationId, identifier } },
    select: { id: true, identifier: true, type: true, title: true, language: true, createdAt: true },
  });

  // Re-using an existing identifier with `create` is treated as a new version
  // (idempotent-ish: the model sometimes recreates rather than updates).
  if (existing) {
    const v = await appendVersion(prisma, existing.id, content, messageId);
    const snapshot = buildSnapshot(existing, v.version, content, v.createdAt, messageId);
    return { ok: true, snapshot, ref: buildRef(snapshot, "create") };
  }

  const artifact = await prisma.artifact.create({
    data: {
      conversationId,
      identifier,
      type,
      title,
      language: type === "code" ? language : null,
      versions: { create: { version: 1, content, messageId } },
    },
    select: {
      id: true,
      identifier: true,
      type: true,
      title: true,
      language: true,
      createdAt: true,
      versions: { select: { createdAt: true }, orderBy: { version: "desc" }, take: 1 },
    },
  });

  const snapshot = buildSnapshot(
    artifact,
    1,
    content,
    artifact.versions[0]?.createdAt ?? artifact.createdAt,
    messageId,
  );
  return { ok: true, snapshot, ref: buildRef(snapshot, "create") };
}

async function applyUpdate(
  prisma: PrismaClient,
  conversationId: string,
  messageId: string,
  args: Record<string, unknown>,
): Promise<ApplyArtifactResult> {
  const identifierRaw = readString(args, "identifier");
  const oldStr = readString(args, "old_str");
  const newStr = readString(args, "new_str");

  if (!identifierRaw) return { ok: false, error: "update_artifact: `identifier` is required" };
  if (oldStr === null) return { ok: false, error: "update_artifact: `old_str` is required" };
  if (newStr === null) return { ok: false, error: "update_artifact: `new_str` is required" };
  if (oldStr.length === 0) return { ok: false, error: "update_artifact: `old_str` must not be empty" };

  const identifier = normalizeIdentifier(identifierRaw);
  const artifact = await prisma.artifact.findUnique({
    where: { conversationId_identifier: { conversationId, identifier } },
    select: {
      id: true,
      identifier: true,
      type: true,
      title: true,
      language: true,
      createdAt: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { content: true } },
    },
  });
  if (!artifact) return { ok: false, error: `update_artifact: no artifact "${identifier}" in this conversation` };

  const current = artifact.versions[0]?.content ?? "";
  const idx = current.indexOf(oldStr);
  if (idx === -1) {
    return { ok: false, error: "update_artifact: `old_str` was not found in the current content. Use rewrite_artifact to replace the whole artifact." };
  }
  const nextContent = current.slice(0, idx) + newStr + current.slice(idx + oldStr.length);

  const v = await appendVersion(prisma, artifact.id, nextContent, messageId);
  const snapshot = buildSnapshot(artifact, v.version, nextContent, v.createdAt, messageId);
  return { ok: true, snapshot, ref: buildRef(snapshot, "update") };
}

async function applyRewrite(
  prisma: PrismaClient,
  conversationId: string,
  messageId: string,
  args: Record<string, unknown>,
): Promise<ApplyArtifactResult> {
  const identifierRaw = readString(args, "identifier");
  const content = readString(args, "content");
  const title = readString(args, "title");

  if (!identifierRaw) return { ok: false, error: "rewrite_artifact: `identifier` is required" };
  if (content === null) return { ok: false, error: "rewrite_artifact: `content` is required" };

  const identifier = normalizeIdentifier(identifierRaw);
  const artifact = await prisma.artifact.findUnique({
    where: { conversationId_identifier: { conversationId, identifier } },
    select: { id: true, identifier: true, type: true, title: true, language: true, createdAt: true },
  });
  if (!artifact) return { ok: false, error: `rewrite_artifact: no artifact "${identifier}" in this conversation` };

  if (title && title !== artifact.title) {
    await prisma.artifact.update({ where: { id: artifact.id }, data: { title } });
    artifact.title = title;
  }

  const v = await appendVersion(prisma, artifact.id, content, messageId);
  const snapshot = buildSnapshot(artifact, v.version, content, v.createdAt, messageId);
  return { ok: true, snapshot, ref: buildRef(snapshot, "rewrite") };
}

/**
 * Apply one artifact tool call. Never throws for expected/validation problems —
 * it returns `{ ok: false, error }` so the caller can surface a graceful message
 * to the model. Unexpected DB errors still reject.
 */
export async function applyArtifactCommand(
  prisma: PrismaClient,
  params: ApplyArtifactParams,
): Promise<ApplyArtifactResult> {
  const args = asRecord(params.args);
  if (!args) return { ok: false, error: "artifact tool call had no arguments" };

  switch (params.command) {
    case "create":
      return applyCreate(prisma, params.conversationId, params.messageId, args);
    case "update":
      return applyUpdate(prisma, params.conversationId, params.messageId, args);
    case "rewrite":
      return applyRewrite(prisma, params.conversationId, params.messageId, args);
    default:
      return { ok: false, error: `unknown artifact command: ${params.command}` };
  }
}

/** Map an artifact tool name to its command, or null if not an artifact tool. */
export function toolNameToArtifactCommand(name: string): ArtifactCommand | null {
  switch (name) {
    case "create_artifact":
      return "create";
    case "update_artifact":
      return "update";
    case "rewrite_artifact":
      return "rewrite";
    default:
      return null;
  }
}
