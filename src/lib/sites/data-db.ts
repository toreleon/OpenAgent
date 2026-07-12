/**
 * Access layer for the ISOLATED Sites mini-app datastore (prisma/sites-data.prisma
 * → sites-data.db). See that schema for WHY this is a separate DB/client.
 *
 * Two things live here:
 *  1. `sitesDataDb` — a singleton client for the second SQLite file, opened WAL +
 *     busy_timeout so concurrent public writers wait briefly instead of erroring
 *     and reads don't block on writes.
 *  2. `siteStore` — a TENANT-SCOPED repository. Every method takes `siteId` as a
 *     required first argument and every query filters on it, so a forgotten
 *     tenant filter is a *type error*, never a cross-site data leak. Nothing
 *     outside this module should touch `sitesDataDb` directly.
 *
 * Quota is enforced ATOMICALLY: each write runs in an interactive transaction
 * that adjusts the denormalized `SiteUsage` counters and throws
 * `SiteQuotaExceededError` (rolling back) when a Site would exceed its byte
 * budget — no check-then-write race, no `SUM()` per write.
 */
import { createHash } from "crypto";
import { PrismaClient } from "@/generated/sites-data-client";
import { decryptSecret, encryptSecret } from "@/lib/sites/secrets";

// ---------------------------------------------------------------------------
// Client singleton (global-cached to survive Next.js dev hot-reload)
// ---------------------------------------------------------------------------

const globalForSitesData = globalThis as unknown as {
  sitesDataDb: PrismaClient | undefined;
  sitesDataInit: Promise<void> | undefined;
};

export const sitesDataDb: PrismaClient =
  globalForSitesData.sitesDataDb ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForSitesData.sitesDataDb = sitesDataDb;
}

/**
 * Apply per-connection pragmas once per process. WAL is persistent (stored in the
 * DB file) but harmless to re-assert; busy_timeout is per-connection. Callers
 * that do a write should `await ensureSitesData()` first. Cached on globalThis so
 * it runs once across hot-reloads.
 */
export function ensureSitesData(): Promise<void> {
  if (!globalForSitesData.sitesDataInit) {
    globalForSitesData.sitesDataInit = (async () => {
      // $queryRawUnsafe (not $executeRawUnsafe): these PRAGMAs return a row, and
      // SQLite's execute path rejects result-returning statements.
      await sitesDataDb.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
      await sitesDataDb.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
    })().catch((err) => {
      globalForSitesData.sitesDataInit = undefined; // allow a later retry
      throw err;
    });
  }
  return globalForSitesData.sitesDataInit;
}

// ---------------------------------------------------------------------------
// Errors + types
// ---------------------------------------------------------------------------

/** Thrown (rolling back the write) when a Site would exceed its byte quota. */
export class SiteQuotaExceededError extends Error {
  constructor(
    readonly siteId: string,
    readonly needed: number,
    readonly quota: number,
  ) {
    super(`Site ${siteId} data quota exceeded (need ${needed}B, quota ${quota}B)`);
    this.name = "SiteQuotaExceededError";
  }
}

export interface SiteBackendConfig {
  siteId: string;
  enabled: boolean;
  dataQuotaBytes: number;
}

export interface SiteDocumentRow {
  id: string;
  data: string;
  createdAt: Date;
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

// ---------------------------------------------------------------------------
// Tenant-scoped repository — siteId is ALWAYS the first arg
// ---------------------------------------------------------------------------

export const siteStore = {
  /** The backend config for a Site, or null when it has never been enabled. */
  async getConfig(siteId: string): Promise<SiteBackendConfig | null> {
    const row = await sitesDataDb.siteBackendConfig.findUnique({ where: { siteId } });
    return row
      ? { siteId, enabled: row.enabled, dataQuotaBytes: row.dataQuotaBytes }
      : null;
  },

  /** True iff the Site's backend master switch is on. */
  async isEnabled(siteId: string): Promise<boolean> {
    const row = await sitesDataDb.siteBackendConfig.findUnique({
      where: { siteId },
      select: { enabled: true },
    });
    return row?.enabled ?? false;
  },

  /** Create/update a Site's backend config (owner action, from the app side). */
  async setConfig(
    siteId: string,
    patch: { enabled?: boolean; dataQuotaBytes?: number },
  ): Promise<SiteBackendConfig> {
    const row = await sitesDataDb.siteBackendConfig.upsert({
      where: { siteId },
      create: {
        siteId,
        enabled: patch.enabled ?? false,
        ...(patch.dataQuotaBytes != null ? { dataQuotaBytes: patch.dataQuotaBytes } : {}),
      },
      update: {
        ...(patch.enabled != null ? { enabled: patch.enabled } : {}),
        ...(patch.dataQuotaBytes != null ? { dataQuotaBytes: patch.dataQuotaBytes } : {}),
      },
    });
    return { siteId, enabled: row.enabled, dataQuotaBytes: row.dataQuotaBytes };
  },

  // ---- KV ----

  async kvGet(
    siteId: string,
    collection: string,
    key: string,
    scope = "shared",
  ): Promise<string | null> {
    const row = await sitesDataDb.siteKV.findUnique({
      where: { siteId_collection_key_scope: { siteId, collection, key, scope } },
      select: { value: true },
    });
    return row?.value ?? null;
  },

  /** Atomic quota-checked upsert of one KV entry. Returns the stored value. */
  async kvPut(
    siteId: string,
    collection: string,
    key: string,
    value: string,
    scope = "shared",
  ): Promise<string> {
    await this.assertQuota(siteId, value.length, async (tx, quota) => {
      const existing = await tx.siteKV.findUnique({
        where: { siteId_collection_key_scope: { siteId, collection, key, scope } },
        select: { value: true },
      });
      const oldBytes = existing ? utf8Bytes(existing.value) : 0;
      const delta = utf8Bytes(value) - oldBytes;
      await bumpUsage(tx, siteId, delta, existing ? 0 : 1, quota);
      await tx.siteKV.upsert({
        where: { siteId_collection_key_scope: { siteId, collection, key, scope } },
        create: { siteId, collection, key, value, scope },
        update: { value },
      });
    });
    return value;
  },

  async kvDelete(
    siteId: string,
    collection: string,
    key: string,
    scope = "shared",
  ): Promise<boolean> {
    return sitesDataDb.$transaction(async (tx) => {
      const existing = await tx.siteKV.findUnique({
        where: { siteId_collection_key_scope: { siteId, collection, key, scope } },
        select: { value: true },
      });
      if (!existing) return false;
      await tx.siteKV.delete({
        where: { siteId_collection_key_scope: { siteId, collection, key, scope } },
      });
      await bumpUsage(tx, siteId, -utf8Bytes(existing.value), -1, Number.MAX_SAFE_INTEGER);
      return true;
    });
  },

  // ---- Documents (append-only) ----

  /** Atomic quota-checked append of one document. Returns its id. */
  async docAppend(siteId: string, collection: string, data: string): Promise<string> {
    let id = "";
    await this.assertQuota(siteId, data.length, async (tx, quota) => {
      await bumpUsage(tx, siteId, utf8Bytes(data), 1, quota);
      const created = await tx.siteDocument.create({
        data: { siteId, collection, data },
        select: { id: true },
      });
      id = created.id;
    });
    return id;
  },

  /** Newest-first documents in a collection (owner/read-policy enforced upstream). */
  async docList(
    siteId: string,
    collection: string,
    limit = 100,
  ): Promise<SiteDocumentRow[]> {
    return sitesDataDb.siteDocument.findMany({
      where: { siteId, collection },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 500),
      select: { id: true, data: true, createdAt: true },
    });
  },

  /** Current usage counters for a Site (both 0 when it has never written). */
  async usage(siteId: string): Promise<{ bytes: number; rows: number }> {
    const row = await sitesDataDb.siteUsage.findUnique({ where: { siteId } });
    return { bytes: row?.bytes ?? 0, rows: row?.rows ?? 0 };
  },

  /**
   * Durable, bounded per-(site, ip-block, window) write limiter. Returns true
   * when the write is ALLOWED. Buckets live in SiteRateBucket (survive restart,
   * shared across workers) keyed by a hash so the raw IP is never stored. A
   * throttled sweep hard-evicts expired rows so the table stays bounded.
   */
  async checkWriteRate(
    siteId: string,
    ipBlock: string,
    opts: { windowSec: number; max: number },
  ): Promise<boolean> {
    await ensureSitesData();
    const now = Date.now();
    const windowIdx = Math.floor(now / (opts.windowSec * 1000));
    const key = createHash("sha256")
      .update(`${siteId}|${ipBlock}|${windowIdx}`)
      .digest("hex")
      .slice(0, 32);
    const expiresAt = new Date((windowIdx + 1) * opts.windowSec * 1000);
    await sweepRateBuckets(now);
    const row = await sitesDataDb.siteRateBucket.upsert({
      where: { key },
      create: { key, count: 1, expiresAt },
      update: { count: { increment: 1 } },
    });
    return row.count <= opts.max;
  },

  // ---- Named accounts (Phase 2b) ----

  /**
   * Create a per-Site account. Returns the new account, or null when the username
   * is already taken (unique [siteId, username] conflict). `passwordHash` is
   * pre-hashed by the caller (see lib/sites/account.ts).
   */
  async createAccount(
    siteId: string,
    username: string,
    passwordHash: string,
  ): Promise<{ id: string; username: string } | null> {
    try {
      const row = await sitesDataDb.siteAccount.create({
        data: { siteId, username, passwordHash },
        select: { id: true, username: true },
      });
      return row;
    } catch (e) {
      if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") return null;
      throw e;
    }
  },

  /** Look up an account by username within a Site (includes the hash for login). */
  async findAccountByUsername(
    siteId: string,
    username: string,
  ): Promise<{ id: string; username: string; passwordHash: string } | null> {
    return sitesDataDb.siteAccount.findUnique({
      where: { siteId_username: { siteId, username } },
      select: { id: true, username: true, passwordHash: true },
    });
  },

  /** Look up an account by id within a Site (for resolving a session cookie). */
  async getAccountById(
    siteId: string,
    id: string,
  ): Promise<{ id: string; username: string } | null> {
    const row = await sitesDataDb.siteAccount.findFirst({
      where: { id, siteId },
      select: { id: true, username: true },
    });
    return row;
  },

  // ---- Secrets + proxied endpoints (Phase 3) ----

  /** Owner action: store an encrypted secret. Returns false if secrets are off. */
  async setSecret(siteId: string, name: string, value: string): Promise<boolean> {
    const enc = encryptSecret(value, siteId, name);
    if (!enc) return false;
    await sitesDataDb.siteSecret.upsert({
      where: { siteId_name: { siteId, name } },
      create: { siteId, name, ciphertext: enc.ciphertext, nonce: enc.nonce },
      update: { ciphertext: enc.ciphertext, nonce: enc.nonce },
    });
    return true;
  },

  /** Secret NAMES for a Site (never values) — for the owner UI. */
  async listSecretNames(siteId: string): Promise<string[]> {
    const rows = await sitesDataDb.siteSecret.findMany({
      where: { siteId },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    return rows.map((r) => r.name);
  },

  /** Delete a secret. */
  async deleteSecret(siteId: string, name: string): Promise<void> {
    await sitesDataDb.siteSecret.deleteMany({ where: { siteId, name } });
  },

  /** Decrypt a secret for the proxy (server-side only). */
  async getDecryptedSecret(siteId: string, name: string): Promise<string | null> {
    const row = await sitesDataDb.siteSecret.findUnique({
      where: { siteId_name: { siteId, name } },
      select: { ciphertext: true, nonce: true },
    });
    if (!row) return null;
    return decryptSecret(row.ciphertext, row.nonce, siteId, name);
  },

  /**
   * Model action: propose an endpoint UNARMED. If it already exists and the
   * template/method changed, it is re-disarmed (the owner must re-approve the new
   * destination); an unchanged re-propose preserves the owner's arming.
   */
  async proposeEndpoint(
    siteId: string,
    input: { name: string; method: string; urlTemplate: string },
  ): Promise<void> {
    const existing = await sitesDataDb.siteEndpoint.findUnique({
      where: { siteId_name: { siteId, name: input.name } },
      select: { urlTemplate: true, method: true },
    });
    if (!existing) {
      await sitesDataDb.siteEndpoint.create({
        data: { siteId, name: input.name, method: input.method, urlTemplate: input.urlTemplate },
      });
      return;
    }
    const changed =
      existing.urlTemplate !== input.urlTemplate || existing.method !== input.method;
    if (changed) {
      await sitesDataDb.siteEndpoint.update({
        where: { siteId_name: { siteId, name: input.name } },
        data: { method: input.method, urlTemplate: input.urlTemplate, armed: false, approvedHost: null },
      });
    }
  },

  /** Owner action: arm an endpoint by approving its host + secret injections. */
  async armEndpoint(
    siteId: string,
    name: string,
    input: { approvedHost: string; secretRefs: string[]; dailyBudget?: number },
  ): Promise<boolean> {
    const res = await sitesDataDb.siteEndpoint.updateMany({
      where: { siteId, name },
      data: {
        approvedHost: input.approvedHost,
        secretRefs: JSON.stringify(input.secretRefs),
        armed: true,
        ...(input.dailyBudget != null ? { dailyBudget: input.dailyBudget } : {}),
      },
    });
    return res.count > 0;
  },

  /** Full endpoint row (proxy use). */
  async getEndpoint(siteId: string, name: string) {
    return sitesDataDb.siteEndpoint.findUnique({
      where: { siteId_name: { siteId, name } },
    });
  },

  /** Endpoints for the owner UI (no secret values exist on the row anyway). */
  async listEndpoints(siteId: string) {
    return sitesDataDb.siteEndpoint.findMany({
      where: { siteId },
      orderBy: { name: "asc" },
      select: {
        name: true,
        method: true,
        urlTemplate: true,
        approvedHost: true,
        secretRefs: true,
        armed: true,
        dailyBudget: true,
      },
    });
  },

  /**
   * Atomically consume one call against an endpoint's daily budget (resetting the
   * window when the UTC day rolls over). Returns false when the budget is spent.
   */
  async consumeEndpointBudget(siteId: string, endpointId: string): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    return sitesDataDb.$transaction(async (tx) => {
      const ep = await tx.siteEndpoint.findFirst({
        where: { id: endpointId, siteId },
        select: { callsToday: true, dayStamp: true, dailyBudget: true },
      });
      if (!ep) return false;
      const calls = ep.dayStamp === today ? ep.callsToday : 0;
      if (ep.dailyBudget > 0 && calls >= ep.dailyBudget) return false;
      await tx.siteEndpoint.update({
        where: { id: endpointId },
        data: { callsToday: calls + 1, dayStamp: today },
      });
      return true;
    });
  },

  /** Delete ALL data for a Site (called from the app-side Site delete cascade). */
  async purgeSite(siteId: string): Promise<void> {
    await sitesDataDb.$transaction([
      sitesDataDb.siteKV.deleteMany({ where: { siteId } }),
      sitesDataDb.siteDocument.deleteMany({ where: { siteId } }),
      sitesDataDb.siteUsage.deleteMany({ where: { siteId } }),
      sitesDataDb.siteBackendConfig.deleteMany({ where: { siteId } }),
      sitesDataDb.siteAccount.deleteMany({ where: { siteId } }),
      sitesDataDb.siteSecret.deleteMany({ where: { siteId } }),
      sitesDataDb.siteEndpoint.deleteMany({ where: { siteId } }),
    ]);
  },

  /**
   * Run `body` inside a transaction after loading the Site's quota. `body`
   * receives the tx client and the quota; it must call `bumpUsage` to record its
   * byte/row delta (which throws SiteQuotaExceededError past the cap).
   */
  async assertQuota(
    siteId: string,
    _hint: number,
    body: (tx: TxClient, quota: number) => Promise<void>,
  ): Promise<void> {
    await ensureSitesData();
    const cfg = await sitesDataDb.siteBackendConfig.findUnique({
      where: { siteId },
      select: { dataQuotaBytes: true },
    });
    const quota = cfg?.dataQuotaBytes ?? 0;
    await sitesDataDb.$transaction(async (tx) => body(tx as TxClient, quota));
  },
};

// Hard-evict expired rate buckets so the table stays bounded, but at most once
// per minute per process (a full deleteMany on every write would double the
// write load). The last-sweep timestamp rides globalThis to survive hot-reload.
async function sweepRateBuckets(now: number): Promise<void> {
  const g = globalForSitesData as unknown as { lastRateSweep?: number };
  if (g.lastRateSweep && now - g.lastRateSweep < 60_000) return;
  g.lastRateSweep = now;
  try {
    await sitesDataDb.siteRateBucket.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
  } catch {
    // best-effort GC; a failed sweep must never block a write
  }
}

// Prisma's interactive-transaction client type (the client minus the tx-control
// members). Kept local so the repository is the only place that sees it.
type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * Adjust the denormalized SiteUsage counters by (deltaBytes, deltaRows) inside a
 * transaction, throwing SiteQuotaExceededError (which rolls the tx back) when the
 * resulting byte total would exceed `quota`. Negative deltas (deletes) never
 * throw and floor at 0.
 */
async function bumpUsage(
  tx: TxClient,
  siteId: string,
  deltaBytes: number,
  deltaRows: number,
  quota: number,
): Promise<void> {
  const current = await tx.siteUsage.findUnique({ where: { siteId } });
  const bytes = current?.bytes ?? 0;
  const rows = current?.rows ?? 0;
  const nextBytes = bytes + deltaBytes;
  if (deltaBytes > 0 && nextBytes > quota) {
    throw new SiteQuotaExceededError(siteId, nextBytes, quota);
  }
  const clampedBytes = Math.max(0, nextBytes);
  const clampedRows = Math.max(0, rows + deltaRows);
  await tx.siteUsage.upsert({
    where: { siteId },
    create: { siteId, bytes: clampedBytes, rows: clampedRows },
    update: { bytes: clampedBytes, rows: clampedRows },
  });
}
