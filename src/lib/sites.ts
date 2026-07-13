/**
 * Server-side Site persistence, versioning, and publishing.
 *
 * A Site (Sites-style) is a first-class, USER-owned, publishable web
 * page. Unlike an Artifact it is not bound to a conversation — it survives chat
 * deletion (`createdInConversationId` is provenance only). Content lives on a
 * mutable `draft*` buffer; "Save a Version" snapshots the draft into an immutable
 * {@link SiteVersion}; "Deploy" flips the single `liveVersionId` pointer so the
 * public /s/<slug> page only changes on an explicit deploy.
 *
 * This module is the single source of truth for:
 *  - the model's site tool calls (create/update/deploy — intercepted by
 *    /api/chat, mirroring src/lib/artifacts.ts),
 *  - the management API (create / save-version / deploy / unpublish / delete),
 *  - the public serving route (loadPublicSite),
 *  - and the account-deletion cascade (deleteUserSites).
 */
import { createHash, randomBytes } from "crypto";
import type { PrismaClient } from "@prisma/client";
import {
  isSiteType,
  sitePublicPath,
  SITE_VISIBILITIES,
  type SiteCommand,
  type SiteDetail,
  type SiteRef,
  type SiteSnapshot,
  type SiteStatus,
  type SiteSummary,
  type SiteType,
  type SiteVersionInfo,
  type SiteVisibility,
} from "@/lib/types";
import { siteStore } from "@/lib/sites/data-db";
import { removeSiteBlobs } from "@/lib/sites/blob";

// ---------------------------------------------------------------------------
// Row shapes (a Site with its versions loaded)
// ---------------------------------------------------------------------------

interface SiteVersionRow {
  id: string;
  version: number;
  type: string;
  title: string;
  language: string | null;
  content: string;
  commit: string;
  label: string | null;
  createdAt: Date;
}

interface SiteRow {
  id: string;
  userId: string;
  slug: string;
  name: string;
  description: string | null;
  draftType: string;
  draftContent: string;
  draftLanguage: string | null;
  liveVersionId: string | null;
  deployedAt: Date | null;
  visibility: string;
  sourceType: string;
  sourceArtifactId: string | null;
  createdInConversationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  versions: SiteVersionRow[];
}

const SITE_INCLUDE = {
  versions: { orderBy: { version: "asc" } },
} as const;

// ---------------------------------------------------------------------------
// Small helpers
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

function coerceSiteType(v: string): SiteType {
  return isSiteType(v) ? v : "html";
}

const ENDPOINT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Apply a create_site `backend` manifest to a Site: flip the backend master
 * switch on when it declares any capability, and PROPOSE (unarmed) any endpoints
 * the model declared. Endpoints stay inert until the owner arms them out-of-band
 * — the model can never choose a secret's destination.
 */
async function applyBackendManifest(siteId: string, backendRaw: unknown): Promise<void> {
  const b = asRecord(backendRaw);
  if (!b) return;
  const cols = b["collections"];
  const eps = b["endpoints"];
  const fns = b["functions"];
  const wants =
    b["kv"] === true ||
    (Array.isArray(cols) && cols.length > 0) ||
    (Array.isArray(eps) && eps.length > 0) ||
    (Array.isArray(fns) && fns.length > 0);
  if (!wants) return;
  await siteStore.setConfig(siteId, { enabled: true });
  if (Array.isArray(eps)) {
    for (const raw of eps) {
      const e = asRecord(raw);
      const name = e && typeof e["name"] === "string" ? e["name"] : null;
      const urlTemplate = e && typeof e["urlTemplate"] === "string" ? e["urlTemplate"] : null;
      const methodRaw = e && typeof e["method"] === "string" ? e["method"].toUpperCase() : "GET";
      if (name && urlTemplate && ENDPOINT_NAME_RE.test(name)) {
        await siteStore.proposeEndpoint(siteId, {
          name,
          method: methodRaw === "POST" ? "POST" : "GET",
          urlTemplate,
        });
      }
    }
  }
  // Phase 4: propose server functions UNARMED (inert until the operator enables
  // the tier AND the owner approves the exact code). Capped at 20/site, 64 KiB each.
  if (Array.isArray(fns)) {
    const existing = await siteStore.countFunctions(siteId);
    let added = 0;
    for (const raw of fns) {
      if (existing + added >= 20) break;
      const f = asRecord(raw);
      const name = f && typeof f["name"] === "string" ? f["name"] : null;
      const code = f && typeof f["code"] === "string" ? f["code"] : null;
      if (name && code && ENDPOINT_NAME_RE.test(name) && code.length <= 64 * 1024) {
        await siteStore.proposeFunction(siteId, { name, code });
        added++;
      }
    }
  }
}

function coerceVisibility(v: string | null | undefined): SiteVisibility {
  return v && (SITE_VISIBILITIES as string[]).includes(v)
    ? (v as SiteVisibility)
    : "private";
}

/** Kebab-case base slug from a display name (no random suffix). */
function slugBase(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "site";
}

/** A short, URL-safe random suffix so link URLs are unguessable. */
function randomSuffix(): string {
  return randomBytes(4).toString("hex").slice(0, 6);
}

/** sha256(content) prefix — the pseudo "git commit" of a saved version. */
export function computeCommit(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
}

/**
 * Allocate a globally-unique slug `<base>-<rand>` for a new Site, retrying on the
 * (astronomically unlikely) collision.
 */
async function allocateSlug(prisma: PrismaClient, name: string): Promise<string> {
  const base = slugBase(name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = `${base}-${randomSuffix()}`;
    const existing = await prisma.site.findUnique({ where: { slug }, select: { id: true } });
    if (!existing) return slug;
  }
  // Extremely defensive fallback.
  return `${base}-${randomBytes(8).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Status + serialization
// ---------------------------------------------------------------------------

/** Derive a Site's lifecycle status from its live pointer + draft. */
function deriveStatus(site: SiteRow): SiteStatus {
  if (!site.liveVersionId) return "draft";
  const live = site.versions.find((v) => v.id === site.liveVersionId);
  if (!live) return "draft"; // dangling pointer — treated as not-yet-deployed
  const draftMatches =
    live.type === site.draftType && live.commit === computeCommit(site.draftContent);
  return draftMatches ? "deployed" : "deployed-stale";
}

function liveVersion(site: SiteRow): SiteVersionRow | null {
  if (!site.liveVersionId) return null;
  return site.versions.find((v) => v.id === site.liveVersionId) ?? null;
}

export function serializeSiteSummary(site: SiteRow): SiteSummary {
  const live = liveVersion(site);
  const previewSource = live ?? {
    type: site.draftType,
    content: site.draftContent,
    language: site.draftLanguage,
  };
  return {
    id: site.id,
    slug: site.slug,
    name: site.name,
    description: site.description ?? undefined,
    visibility: coerceVisibility(site.visibility),
    status: deriveStatus(site),
    publicPath: sitePublicPath(site.slug),
    previewType: coerceSiteType(previewSource.type),
    previewContent: previewSource.content,
    previewLanguage: previewSource.language ?? undefined,
    liveVersion: live?.version ?? null,
    versionCount: site.versions.length,
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
    deployedAt: site.deployedAt?.toISOString(),
  };
}

function serializeVersionInfo(v: SiteVersionRow, liveVersionId: string | null): SiteVersionInfo {
  return {
    id: v.id,
    version: v.version,
    type: coerceSiteType(v.type),
    title: v.title,
    commit: v.commit,
    label: v.label ?? undefined,
    createdAt: v.createdAt.toISOString(),
    isLive: v.id === liveVersionId,
  };
}

export function serializeSiteDetail(site: SiteRow): SiteDetail {
  return {
    ...serializeSiteSummary(site),
    draftType: coerceSiteType(site.draftType),
    draftContent: site.draftContent,
    draftLanguage: site.draftLanguage ?? undefined,
    liveVersionId: site.liveVersionId,
    versions: [...site.versions]
      .sort((a, b) => b.version - a.version)
      .map((v) => serializeVersionInfo(v, site.liveVersionId)),
    sourceType: site.sourceType,
    createdInConversationId: site.createdInConversationId ?? undefined,
    sourceArtifactId: site.sourceArtifactId ?? undefined,
  };
}

function serializeSnapshot(site: SiteRow, command: SiteCommand): SiteSnapshot {
  const summary = serializeSiteSummary(site);
  return {
    id: site.id,
    slug: site.slug,
    name: site.name,
    description: site.description ?? undefined,
    visibility: summary.visibility,
    status: summary.status,
    command,
    draftType: coerceSiteType(site.draftType),
    draftContent: site.draftContent,
    draftLanguage: site.draftLanguage ?? undefined,
    liveVersion: summary.liveVersion,
    publicPath: summary.publicPath,
    deployed: site.liveVersionId != null,
    updatedAt: site.updatedAt.toISOString(),
  };
}

function buildRef(site: SiteRow, command: SiteCommand): SiteRef {
  return {
    siteId: site.id,
    slug: site.slug,
    name: site.name,
    command,
    deployed: site.liveVersionId != null,
    publicPath: sitePublicPath(site.slug),
  };
}

async function reloadSite(prisma: PrismaClient, id: string): Promise<SiteRow> {
  const row = await prisma.site.findUnique({ where: { id }, include: SITE_INCLUDE });
  if (!row) throw new Error(`Site ${id} vanished`);
  return row as unknown as SiteRow;
}

// ---------------------------------------------------------------------------
// Queries (management)
// ---------------------------------------------------------------------------

/** Every Site owned by a user, newest-updated first, as list summaries. */
export async function loadUserSites(
  prisma: PrismaClient,
  userId: string,
): Promise<SiteSummary[]> {
  const rows = await prisma.site.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: SITE_INCLUDE,
  });
  return (rows as unknown as SiteRow[]).map(serializeSiteSummary);
}

/** Full detail for one Site the user owns, or null if missing/not owned. */
export async function loadSiteDetail(
  prisma: PrismaClient,
  userId: string,
  siteId: string,
): Promise<SiteDetail | null> {
  const row = await prisma.site.findFirst({
    where: { id: siteId, userId },
    include: SITE_INCLUDE,
  });
  return row ? serializeSiteDetail(row as unknown as SiteRow) : null;
}

/**
 * Look up a deployed, publicly-viewable Site by slug for the /s/<slug> route.
 * Returns the live version's renderable content, or null when the site does not
 * exist, is not `link`-visible, or has no live deployment. Never leaks existence
 * (the caller 404s in every null case).
 */
export async function loadPublicSite(
  prisma: PrismaClient,
  slug: string,
): Promise<{ type: SiteType; content: string; name: string } | null> {
  const site = await prisma.site.findUnique({
    where: { slug },
    include: SITE_INCLUDE,
  });
  if (!site) return null;
  const row = site as unknown as SiteRow;
  // v1 serves only `link` (anyone-with-the-URL) sites publicly; private +
  // workspace previewing happens in the authenticated dashboard (see the plan).
  if (coerceVisibility(row.visibility) !== "link") return null;
  const live = liveVersion(row);
  if (!live) return null;
  return { type: coerceSiteType(live.type), content: live.content, name: row.name };
}

// ---------------------------------------------------------------------------
// Version append (race-safe, dedup-by-commit)
// ---------------------------------------------------------------------------

/**
 * Snapshot the current draft into a new immutable SiteVersion. If the newest
 * version already has the same content (commit) and type, it is reused instead
 * of creating a duplicate — so repeated saves of an unchanged draft don't bloat
 * history. Returns the version row that is now "latest for this content".
 */
async function appendVersion(
  prisma: PrismaClient,
  site: SiteRow,
  messageId: string | null,
  label: string | null,
): Promise<SiteVersionRow> {
  const commit = computeCommit(site.draftContent);
  const newest = site.versions[site.versions.length - 1];
  if (newest && newest.commit === commit && newest.type === site.draftType) {
    return newest;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await prisma.siteVersion.findFirst({
      where: { siteId: site.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const nextVersion = (latest?.version ?? 0) + 1;
    try {
      const created = await prisma.siteVersion.create({
        data: {
          siteId: site.id,
          version: nextVersion,
          type: site.draftType,
          title: site.name,
          language: site.draftLanguage,
          content: site.draftContent,
          commit,
          label,
          sourceMessageId: messageId,
        },
      });
      await prisma.site.update({ where: { id: site.id }, data: { updatedAt: new Date() } });
      return created as unknown as SiteVersionRow;
    } catch (err) {
      if (attempt === 0) continue; // unique (siteId, version) race — retry once
      throw err;
    }
  }
  throw new Error("Failed to append site version");
}

/** Save the current draft as a new version (management API + auto-deploy). */
export async function saveSiteVersion(
  prisma: PrismaClient,
  userId: string,
  siteId: string,
  opts: { label?: string | null; messageId?: string | null } = {},
): Promise<SiteDetail | null> {
  const owned = await prisma.site.findFirst({
    where: { id: siteId, userId },
    include: SITE_INCLUDE,
  });
  if (!owned) return null;
  await appendVersion(prisma, owned as unknown as SiteRow, opts.messageId ?? null, opts.label ?? null);
  return serializeSiteDetail(await reloadSite(prisma, siteId));
}

/**
 * Deploy a saved version (default: the latest) to the live public URL. Saves the
 * current draft first if it isn't already a version, so "deploy" always has a
 * candidate. Setting `liveVersionId` is what makes /s/<slug> serve it.
 */
export async function deploySite(
  prisma: PrismaClient,
  userId: string,
  siteId: string,
  opts: { versionId?: string; messageId?: string | null } = {},
): Promise<SiteDetail | null> {
  const owned = await prisma.site.findFirst({
    where: { id: siteId, userId },
    include: SITE_INCLUDE,
  });
  if (!owned) return null;
  let row = owned as unknown as SiteRow;

  let target: SiteVersionRow | undefined;
  if (opts.versionId) {
    target = row.versions.find((v) => v.id === opts.versionId);
    if (!target) return null; // unknown/foreign version id
  } else {
    // Deploy the current draft: snapshot it (dedup-safe) and deploy that.
    target = await appendVersion(prisma, row, opts.messageId ?? null, null);
  }

  await prisma.site.update({
    where: { id: siteId },
    data: { liveVersionId: target.id, deployedAt: new Date() },
  });
  row = await reloadSite(prisma, siteId);
  return serializeSiteDetail(row);
}

/** Take a Site offline (null the live pointer) — /s/<slug> then 404s. */
export async function unpublishSite(
  prisma: PrismaClient,
  userId: string,
  siteId: string,
): Promise<SiteDetail | null> {
  const owned = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!owned) return null;
  await prisma.site.update({
    where: { id: siteId },
    data: { liveVersionId: null, deployedAt: null },
  });
  return serializeSiteDetail(await reloadSite(prisma, siteId));
}

// ---------------------------------------------------------------------------
// Create / update metadata (management API)
// ---------------------------------------------------------------------------

/** Create a blank/seeded Site owned by the user. */
export async function createSite(
  prisma: PrismaClient,
  userId: string,
  input: {
    name: string;
    draftType: SiteType;
    draftContent: string;
    draftLanguage?: string | null;
    visibility?: SiteVisibility;
    description?: string | null;
    sourceType?: string;
    sourceArtifactId?: string | null;
    createdInConversationId?: string | null;
  },
): Promise<SiteDetail> {
  const slug = await allocateSlug(prisma, input.name);
  const created = await prisma.site.create({
    data: {
      userId,
      slug,
      name: input.name,
      description: input.description ?? null,
      draftType: input.draftType,
      draftContent: input.draftContent,
      draftLanguage: input.draftLanguage ?? null,
      visibility: coerceVisibility(input.visibility),
      sourceType: input.sourceType ?? "manual",
      sourceArtifactId: input.sourceArtifactId ?? null,
      createdInConversationId: input.createdInConversationId ?? null,
    },
    select: { id: true },
  });
  // Persist the hosting.json manifest stub now that we have the id.
  await prisma.site.update({
    where: { id: created.id },
    data: { manifest: JSON.stringify({ project_id: created.id, d1: null, r2: null }) },
  });
  return serializeSiteDetail(await reloadSite(prisma, created.id));
}

/** Create a Site seeded from an existing Artifact's latest version. */
export async function createSiteFromArtifact(
  prisma: PrismaClient,
  userId: string,
  input: { artifactId: string; name?: string; visibility?: SiteVisibility },
): Promise<SiteDetail | { error: string }> {
  const artifact = await prisma.artifact.findFirst({
    where: { id: input.artifactId, conversation: { userId } },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!artifact) return { error: "Artifact not found" };
  if (!isSiteType(artifact.type)) {
    return { error: `Artifacts of type "${artifact.type}" can't be published as a Site.` };
  }
  const latest = artifact.versions[0];
  if (!latest) return { error: "Artifact has no content yet" };
  const detail = await createSite(prisma, userId, {
    name: input.name?.trim() || artifact.title,
    draftType: artifact.type,
    draftContent: latest.content,
    draftLanguage: artifact.language,
    visibility: input.visibility ?? "private",
    sourceType: "artifact",
    sourceArtifactId: artifact.id,
    createdInConversationId: artifact.conversationId,
  });
  return detail;
}

/** Update a Site's editable metadata / draft (rename, visibility, editor edits). */
export async function updateSiteMeta(
  prisma: PrismaClient,
  userId: string,
  siteId: string,
  patch: {
    name?: string;
    description?: string | null;
    visibility?: SiteVisibility;
    draftContent?: string;
    draftType?: SiteType;
    draftLanguage?: string | null;
  },
): Promise<SiteDetail | null> {
  const owned = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!owned) return null;
  const data: Record<string, unknown> = {};
  if (typeof patch.name === "string" && patch.name.trim()) data.name = patch.name.trim();
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.visibility && (SITE_VISIBILITIES as string[]).includes(patch.visibility)) {
    data.visibility = patch.visibility;
  }
  if (typeof patch.draftContent === "string") data.draftContent = patch.draftContent;
  if (patch.draftType && isSiteType(patch.draftType)) data.draftType = patch.draftType;
  if (patch.draftLanguage !== undefined) data.draftLanguage = patch.draftLanguage;
  if (Object.keys(data).length > 0) {
    await prisma.site.update({ where: { id: siteId }, data });
  }
  return serializeSiteDetail(await reloadSite(prisma, siteId));
}

// ---------------------------------------------------------------------------
// Deletion (emulated cascade — SQLite FK enforcement is off in this app)
// ---------------------------------------------------------------------------

/** Delete one Site and all its versions. */
export async function deleteSite(
  prisma: PrismaClient,
  userId: string,
  siteId: string,
): Promise<boolean> {
  const owned = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!owned) return false;
  await prisma.siteVersion.deleteMany({ where: { siteId } });
  await prisma.site.delete({ where: { id: siteId } });
  // Also drop the Site's mini-app data (isolated sites-data.db): config, KV,
  // documents, usage, rate buckets, secrets, endpoints — no cross-DB FK — plus
  // its on-disk blobs.
  await siteStore.purgeSite(siteId);
  await removeSiteBlobs(siteId);
  return true;
}

/**
 * Delete every Site (and its versions) owned by a user. MUST be called from the
 * account-deletion path — otherwise a deleted account leaves live public sites
 * serving its content.
 */
export async function deleteUserSites(prisma: PrismaClient, userId: string): Promise<void> {
  const sites = await prisma.site.findMany({ where: { userId }, select: { id: true } });
  await prisma.siteVersion.deleteMany({ where: { site: { userId } } });
  await prisma.site.deleteMany({ where: { userId } });
  // Drop each Site's mini-app data (isolated sites-data.db) + on-disk blobs too.
  for (const s of sites) {
    await siteStore.purgeSite(s.id);
    await removeSiteBlobs(s.id);
  }
}

// ---------------------------------------------------------------------------
// Model tool commands (create_site / update_site / deploy_site)
// ---------------------------------------------------------------------------

export type ApplySiteResult =
  | { ok: true; snapshot: SiteSnapshot; ref: SiteRef }
  | { ok: false; error: string };

interface ApplySiteParams {
  userId: string;
  conversationId: string;
  /** The assistant message that issued the tool call. */
  messageId: string;
  command: SiteCommand;
  /** Raw, unvalidated tool-call arguments. */
  args: unknown;
  /** True when the user has opted into model auto-deploy (User.sitesAutoDeploy). */
  canDeploy: boolean;
}

/** Find the Site this conversation is currently building (most recently touched). */
async function conversationSite(
  prisma: PrismaClient,
  userId: string,
  conversationId: string,
): Promise<SiteRow | null> {
  const row = await prisma.site.findFirst({
    where: { userId, createdInConversationId: conversationId },
    orderBy: { updatedAt: "desc" },
    include: SITE_INCLUDE,
  });
  return row ? (row as unknown as SiteRow) : null;
}

async function applyCreate(
  prisma: PrismaClient,
  userId: string,
  conversationId: string,
  args: Record<string, unknown>,
): Promise<ApplySiteResult> {
  const name = readString(args, "name");
  const content = readString(args, "content");
  const typeRaw = readString(args, "type");
  const language = readString(args, "language");

  if (!name) return { ok: false, error: "create_site: `name` is required" };
  if (content === null) return { ok: false, error: "create_site: `content` is required" };
  if (!typeRaw || !isSiteType(typeRaw)) {
    return { ok: false, error: "create_site: invalid `type` (use html, react, markdown, svg, or mermaid)" };
  }
  const type: SiteType = typeRaw;

  // Reuse the current conversation Site when the model re-issues create for the
  // same name (idempotent-ish); otherwise start a fresh Site.
  const existing = await conversationSite(prisma, userId, conversationId);
  if (existing && slugBase(existing.name) === slugBase(name)) {
    await prisma.site.update({
      where: { id: existing.id },
      data: { name, draftType: type, draftContent: content, draftLanguage: language },
    });
    // Turn the backend on + propose endpoints when the model declares them.
    // Public exposure is still gated by an explicit deploy, and endpoints stay
    // UNARMED until the owner approves them — so this publishes nothing on its own.
    await applyBackendManifest(existing.id, args["backend"]);
    const row = await reloadSite(prisma, existing.id);
    return { ok: true, snapshot: serializeSnapshot(row, "create"), ref: buildRef(row, "create") };
  }

  const detail = await createSite(prisma, userId, {
    name,
    draftType: type,
    draftContent: content,
    draftLanguage: language,
    visibility: "private",
    sourceType: "tool",
    createdInConversationId: conversationId,
  });
  await applyBackendManifest(detail.id, args["backend"]);
  const row = await reloadSite(prisma, detail.id);
  return { ok: true, snapshot: serializeSnapshot(row, "create"), ref: buildRef(row, "create") };
}

async function applyUpdate(
  prisma: PrismaClient,
  userId: string,
  conversationId: string,
  args: Record<string, unknown>,
): Promise<ApplySiteResult> {
  const oldStr = readString(args, "old_str");
  const newStr = readString(args, "new_str");
  if (oldStr === null) return { ok: false, error: "update_site: `old_str` is required" };
  if (newStr === null) return { ok: false, error: "update_site: `new_str` is required" };
  if (oldStr.length === 0) return { ok: false, error: "update_site: `old_str` must not be empty" };

  const site = await conversationSite(prisma, userId, conversationId);
  if (!site) return { ok: false, error: "update_site: no site in this conversation yet — call create_site first" };

  const current = site.draftContent;
  const idx = current.indexOf(oldStr);
  if (idx === -1) {
    return { ok: false, error: "update_site: `old_str` was not found in the current draft. Use create_site to replace the whole page." };
  }
  const nextContent = current.slice(0, idx) + newStr + current.slice(idx + oldStr.length);
  await prisma.site.update({ where: { id: site.id }, data: { draftContent: nextContent } });
  const row = await reloadSite(prisma, site.id);
  return { ok: true, snapshot: serializeSnapshot(row, "update"), ref: buildRef(row, "update") };
}

async function applyDeploy(
  prisma: PrismaClient,
  userId: string,
  conversationId: string,
  messageId: string,
  canDeploy: boolean,
): Promise<ApplySiteResult> {
  const site = await conversationSite(prisma, userId, conversationId);
  if (!site) return { ok: false, error: "deploy_site: no site in this conversation yet — call create_site first" };

  if (!canDeploy) {
    // Auto-deploy is off: save a deployable candidate but do NOT publish. The
    // user deploys from the Sites panel. (The tool ack tells the model this.)
    await appendVersion(prisma, site, messageId, null);
    const row = await reloadSite(prisma, site.id);
    return { ok: true, snapshot: serializeSnapshot(row, "deploy"), ref: buildRef(row, "deploy") };
  }

  const detail = await deploySite(prisma, userId, site.id, { messageId });
  if (!detail) return { ok: false, error: "deploy_site: failed to deploy" };
  const row = await reloadSite(prisma, site.id);
  return { ok: true, snapshot: serializeSnapshot(row, "deploy"), ref: buildRef(row, "deploy") };
}

/**
 * Apply one site tool call. Never throws for expected/validation problems — it
 * returns `{ ok: false, error }` so the caller can log gracefully. Unexpected DB
 * errors still reject. Ownership is implicit: `userId`/`conversationId` come from
 * the RunContext, never from model args.
 */
export async function applySiteCommand(
  prisma: PrismaClient,
  params: ApplySiteParams,
): Promise<ApplySiteResult> {
  switch (params.command) {
    case "create": {
      const args = asRecord(params.args);
      if (!args) return { ok: false, error: "create_site tool call had no arguments" };
      return applyCreate(prisma, params.userId, params.conversationId, args);
    }
    case "update": {
      const args = asRecord(params.args);
      if (!args) return { ok: false, error: "update_site tool call had no arguments" };
      return applyUpdate(prisma, params.userId, params.conversationId, args);
    }
    case "deploy":
      return applyDeploy(prisma, params.userId, params.conversationId, params.messageId, params.canDeploy);
    default:
      return { ok: false, error: `unknown site command: ${params.command}` };
  }
}

/** Map a site tool name to its command, or null if not a site tool. */
export function toolNameToSiteCommand(name: string): SiteCommand | null {
  switch (name) {
    case "create_site":
      return "create";
    case "update_site":
      return "update";
    case "deploy_site":
      return "deploy";
    default:
      return null;
  }
}
