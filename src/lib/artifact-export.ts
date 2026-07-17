/**
 * Shared helpers for the artifact "export as a native project" routes
 * (src/app/api/artifacts/[id]/expo and .../capacitor). Both routes load a
 * user-owned artifact, derive a slug + reverse-DNS app id, and stream a zip; this
 * keeps that logic in one place so the two exports can't drift.
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { makeZip } from "@/lib/zip";
import type { ApiError } from "@/lib/types";

/** Normalize a name into a stable, safe kebab slug. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "app"
  );
}

// Java reserved words are illegal as an Android package segment (and expo
// prebuild rejects them), so a one-word app title like "Switch" must be escaped.
const JAVA_KEYWORDS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char",
  "class", "const", "continue", "default", "do", "double", "else", "enum",
  "extends", "final", "finally", "float", "for", "goto", "if", "implements",
  "import", "instanceof", "int", "interface", "long", "native", "new", "package",
  "private", "protected", "public", "return", "short", "static", "strictfp",
  "super", "switch", "synchronized", "this", "throw", "throws", "transient",
  "try", "void", "volatile", "while", "true", "false", "null",
]);

/**
 * A reverse-DNS application id under our namespace whose final segment is valid
 * for BOTH iOS bundle ids and Android packages: alphanumeric, not empty, not
 * starting with a digit, and not a Java keyword.
 */
export function bundleId(slug: string): string {
  let seg = slug.replace(/[^a-z0-9]/g, "");
  if (!seg || /^[0-9]/.test(seg) || JAVA_KEYWORDS.has(seg)) seg = `app${seg}`;
  return `com.openagent.${seg}`;
}

/** An artifact row (with its latest version content) owned by the caller. */
export interface OwnedArtifact {
  id: string;
  type: string;
  title: string;
  identifier: string;
  content: string;
}

type LoadResult =
  | { ok: true; artifact: OwnedArtifact }
  | { ok: false; res: Response };

function err(error: string, status: number): { ok: false; res: Response } {
  return { ok: false, res: Response.json({ error } satisfies ApiError, { status }) };
}

/**
 * Load the artifact `id` — only if it belongs to a conversation owned by the
 * session user — together with its latest version's content. Returns a ready-made
 * error Response for the unauthorized / missing / empty cases.
 */
export async function loadOwnedArtifactForExport(id: string): Promise<LoadResult> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return err("Unauthorized", 401);

  const row = await prisma.artifact.findFirst({
    where: { id, conversation: { userId: session.user.id } },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!row) return err("Artifact not found", 404);
  const version = row.versions[0];
  if (!version) return err("Artifact has no content yet", 400);

  return {
    ok: true,
    artifact: {
      id: row.id,
      type: row.type,
      title: row.title,
      identifier: row.identifier,
      content: version.content,
    },
  };
}

/** Build a downloadable zip Response from a `{ path: contents }` map. */
export function zipResponse(
  files: Record<string, string>,
  filename: string,
): Response {
  const zip = makeZip(files);
  // Uint8Array is a valid BodyInit at runtime (undici); the DOM lib's typed-array
  // generic is just conservative, so cast rather than copy the bytes.
  return new Response(zip as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
