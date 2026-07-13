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
 * True only on the legacy SQLite path (a `file:` SITES_DATA_URL, or the explicit
 * SITES_DATA_IS_SQLITE=1 escape hatch on the rollback branch). The plane is
 * Postgres by default, where the WAL/busy_timeout PRAGMAs below are invalid SQL.
 */
const SITES_DATA_IS_SQLITE =
  (process.env.SITES_DATA_URL ?? "").startsWith("file:") ||
  process.env.SITES_DATA_IS_SQLITE === "1";

/**
 * One-time per-process init for the sites datastore. On SQLite it applies the
 * WAL + busy_timeout PRAGMAs (so concurrent public writers wait briefly instead
 * of erroring). On Postgres this is a no-op: WAL is always-on server-side and
 * MVCC means readers never block writers, so busy_timeout has no analogue.
 * Callers that do a write should `await ensureSitesData()` first. Cached on
 * globalThis so it runs once across hot-reloads.
 */
export function ensureSitesData(): Promise<void> {
  if (!globalForSitesData.sitesDataInit) {
    globalForSitesData.sitesDataInit = (async () => {
      if (!SITES_DATA_IS_SQLITE) return; // Postgres: nothing to assert.
      // SQLite-only. $queryRawUnsafe (not $executeRawUnsafe): these PRAGMAs
      // return a row, and SQLite's execute path rejects result-returning
      // statements.
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
      // Serialize all writers of THIS key first: the byte delta below is computed
      // from a baseline read, which under READ COMMITTED would otherwise be a
      // non-locking snapshot two concurrent same-key writers could share and both
      // subtract — drifting SiteUsage even though bumpUsage's increment is atomic.
      await lockKvKey(tx, siteId, collection, key, scope);
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
      // Same per-key serialization as kvPut, AND it fixes a lock-order inversion:
      // bumpUsage (SiteUsage row lock) must run BEFORE the SiteKV delete so both
      // put and delete take SiteUsage-then-SiteKV — otherwise a concurrent
      // put+delete of one key deadlocks (ABBA).
      await lockKvKey(tx, siteId, collection, key, scope);
      const existing = await tx.siteKV.findUnique({
        where: { siteId_collection_key_scope: { siteId, collection, key, scope } },
        select: { value: true },
      });
      if (!existing) return false;
      await bumpUsage(tx, siteId, -utf8Bytes(existing.value), -1, Number.MAX_SAFE_INTEGER);
      await tx.siteKV.delete({
        where: { siteId_collection_key_scope: { siteId, collection, key, scope } },
      });
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
    // Race-free consumption. The old read→compute-in-JS→absolute-SET was the same
    // lost-update the migration closed in bumpUsage: under READ COMMITTED two
    // concurrent proxy calls read the same callsToday and both wrote calls+1, so
    // the budget (a spend/abuse control on secret-injected outbound calls) could
    // be blown past. Here every counter mutation is an ATOMIC guarded updateMany
    // whose WHERE re-checks against the latest committed row under its lock.

    // 1. Roll the window over if the UTC day changed (only matches a stale row).
    await sitesDataDb.siteEndpoint.updateMany({
      where: { id: endpointId, siteId, dayStamp: { not: today } },
      data: { callsToday: 0, dayStamp: today },
    });

    const ep = await sitesDataDb.siteEndpoint.findFirst({
      where: { id: endpointId, siteId },
      select: { dailyBudget: true },
    });
    if (!ep) return false;

    // 2a. Unlimited budget (<=0): count best-effort, never gate.
    if (ep.dailyBudget <= 0) {
      await sitesDataDb.siteEndpoint.updateMany({
        where: { id: endpointId, siteId },
        data: { callsToday: { increment: 1 } },
      });
      return true;
    }

    // 2b. Consume one call IFF still under budget. The `callsToday < dailyBudget`
    // predicate + `{ increment: 1 }` ride the row lock, so callsToday can never
    // exceed dailyBudget no matter how many callers race. count===0 = spent.
    const res = await sitesDataDb.siteEndpoint.updateMany({
      where: { id: endpointId, siteId, dayStamp: today, callsToday: { lt: ep.dailyBudget } },
      data: { callsToday: { increment: 1 } },
    });
    return res.count > 0;
  },

  // ---- Owner-side data moderation (for the /sites/[id] dashboard) ----

  /** All KV rows for a Site (owner view). */
  async listKVRows(siteId: string) {
    return sitesDataDb.siteKV.findMany({
      where: { siteId },
      orderBy: [{ collection: "asc" }, { key: "asc" }],
      select: { collection: true, key: true, scope: true, value: true, updatedAt: true },
      take: 500,
    });
  },

  /** Recent document rows for a Site (owner view + moderation). */
  async listDocumentRows(siteId: string) {
    return sitesDataDb.siteDocument.findMany({
      where: { siteId },
      orderBy: { createdAt: "desc" },
      select: { id: true, collection: true, data: true, createdAt: true },
      take: 500,
    });
  },

  /** Delete one document by id (owner moderation). */
  async deleteDocument(siteId: string, id: string): Promise<boolean> {
    const res = await sitesDataDb.siteDocument.deleteMany({ where: { id, siteId } });
    return res.count > 0;
  },

  /** Account list for the owner (usernames + created), never password hashes. */
  async listAccounts(siteId: string) {
    return sitesDataDb.siteAccount.findMany({
      where: { siteId },
      orderBy: { createdAt: "desc" },
      select: { id: true, username: true, createdAt: true },
      take: 500,
    });
  },

  // ---- Server functions (Phase 4) ----

  /**
   * Model action: propose a function UNARMED. Re-proposing the SAME code is a
   * no-op; changed code updates it and re-disarms (owner must re-review), exactly
   * like proposeEndpoint's disarm-on-change.
   */
  async proposeFunction(siteId: string, input: { name: string; code: string }): Promise<void> {
    const ex = await sitesDataDb.siteFunction.findUnique({
      where: { siteId_name: { siteId, name: input.name } },
      select: { code: true },
    });
    if (!ex) {
      await sitesDataDb.siteFunction.create({ data: { siteId, name: input.name, code: input.code } });
      return;
    }
    if (ex.code !== input.code) {
      await sitesDataDb.siteFunction.update({
        where: { siteId_name: { siteId, name: input.name } },
        data: { code: input.code, armedHash: null },
      });
    }
  },

  /** The function row for the runner (code + armed hash). */
  async getFunction(
    siteId: string,
    name: string,
  ): Promise<{ code: string; armedHash: string | null } | null> {
    return sitesDataDb.siteFunction.findUnique({
      where: { siteId_name: { siteId, name } },
      select: { code: true, armedHash: true },
    });
  },

  /** All functions for the owner UI (includes source for the review surface). */
  async listFunctions(siteId: string) {
    return sitesDataDb.siteFunction.findMany({
      where: { siteId },
      orderBy: { name: "asc" },
      select: { name: true, code: true, armedHash: true, updatedAt: true },
      take: 200,
    });
  },

  async countFunctions(siteId: string): Promise<number> {
    return sitesDataDb.siteFunction.count({ where: { siteId } });
  },

  /**
   * Owner action: arm a function ONLY if the stored code still hashes to what the
   * owner reviewed (`expectedHash`). Rejects `stale` otherwise — closing the arm
   * TOCTOU (code changed between the owner reading it and clicking Arm).
   */
  async armFunction(
    siteId: string,
    name: string,
    expectedHash: string,
  ): Promise<{ ok: true } | { ok: false; reason: "not_found" | "stale" }> {
    const row = await sitesDataDb.siteFunction.findUnique({
      where: { siteId_name: { siteId, name } },
      select: { code: true },
    });
    if (!row) return { ok: false, reason: "not_found" };
    const h = createHash("sha256").update(row.code).digest("hex");
    if (h !== expectedHash) return { ok: false, reason: "stale" };
    await sitesDataDb.siteFunction.updateMany({ where: { siteId, name }, data: { armedHash: h } });
    return { ok: true };
  },

  /** Owner action: disarm a function (instant per-function live kill). */
  async disarmFunction(siteId: string, name: string): Promise<void> {
    await sitesDataDb.siteFunction.updateMany({ where: { siteId, name }, data: { armedHash: null } });
  },

  async deleteFunction(siteId: string, name: string): Promise<void> {
    await sitesDataDb.siteFunction.deleteMany({ where: { siteId, name } });
  },

  /** Operator live kill-switch for the whole function tier. */
  async functionsGloballyDisabled(): Promise<boolean> {
    const r = await sitesDataDb.siteFnRuntime.findUnique({ where: { id: "singleton" } });
    return !!r?.globalDisabled;
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
      sitesDataDb.siteFunction.deleteMany({ where: { siteId } }),
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
 * Serialize all mutations of ONE logical KV key (put + delete) within a
 * transaction via a Postgres transaction-scoped advisory lock. Two purposes:
 *  1. kvPut's byte delta comes from a baseline read; without this, two concurrent
 *     same-key writers share a READ COMMITTED snapshot and both subtract the same
 *     old value, drifting SiteUsage (bumpUsage's increment is atomic, its INPUT
 *     was not). The lock also covers the not-yet-existing-key case, which a row
 *     `FOR UPDATE` cannot (no row to lock yet).
 *  2. It removes the kvPut/kvDelete lock-order inversion by making same-key
 *     put/delete strictly serial.
 * The lock auto-releases at commit/rollback. No-op on the legacy SQLite path
 * (single-writer already serializes; pg_advisory_* is Postgres-only SQL).
 */
async function lockKvKey(
  tx: TxClient,
  siteId: string,
  collection: string,
  key: string,
  scope: string,
): Promise<void> {
  if (SITES_DATA_IS_SQLITE) return;
  const k = `${siteId}|${collection}|${key}|${scope}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
}

/**
 * Adjust the denormalized SiteUsage counters by (deltaBytes, deltaRows) inside a
 * transaction, throwing SiteQuotaExceededError (which rolls the tx back) when the
 * resulting byte total would exceed `quota`. Negative deltas (deletes) never
 * throw and floor at 0.
 *
 * ATOMICITY (Postgres): the counter is bumped with an ATOMIC INCREMENT, not a
 * read→compute-in-JS→absolute-SET. The old absolute pattern was a lost-update /
 * quota-BYPASS under Postgres READ COMMITTED — two concurrent public writes read
 * the same pre-write count via a non-locking snapshot and the second's absolute
 * write clobbers the first, so both can pass the cap. (SQLite masked this for
 * free: a snapshot txn that then wrote after another committed got
 * SQLITE_BUSY_SNAPSHOT and rolled back.) `{ increment }` compiles to
 * `INSERT ... ON CONFLICT (siteId) DO UPDATE SET bytes = "SiteUsage".bytes + $delta`,
 * and Postgres takes a FOR UPDATE row lock before the DO UPDATE, so concurrent
 * increments serialize; the RETURNed row therefore carries the true cumulative
 * total, making the post-increment quota check correct without SELECT FOR UPDATE
 * or SERIALIZABLE retries. Over-rejection (both roll back) is possible but safe.
 */
async function bumpUsage(
  tx: TxClient,
  siteId: string,
  deltaBytes: number,
  deltaRows: number,
  quota: number,
): Promise<void> {
  const row = await tx.siteUsage.upsert({
    where: { siteId },
    create: {
      siteId,
      bytes: Math.max(0, deltaBytes),
      rows: Math.max(0, deltaRows),
    },
    update: {
      bytes: { increment: deltaBytes },
      rows: { increment: deltaRows },
    },
  });
  if (deltaBytes > 0 && row.bytes > quota) {
    // Rolls the enclosing interactive transaction back — the write is undone.
    throw new SiteQuotaExceededError(siteId, row.bytes, quota);
  }
  // Deletes (negative deltas) never gate quota, but an atomic decrement can
  // transiently drive a counter below 0 under concurrency. Floor it so the
  // owner's usage display and future checks never see a negative — downward only.
  if ((deltaBytes < 0 && row.bytes < 0) || (deltaRows < 0 && row.rows < 0)) {
    await tx.siteUsage.update({
      where: { siteId },
      data: { bytes: Math.max(0, row.bytes), rows: Math.max(0, row.rows) },
    });
  }
}
