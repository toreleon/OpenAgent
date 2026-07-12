/**
 * Phase 4 driver (main thread): a small worker_thread pool that executes Site
 * server functions in the QuickJS sandbox (fn-worker.mjs), plus the CAPABILITY
 * BOUNDARY (`runCap`) — the only place a sandboxed function reaches real data.
 *
 * Security model (docs/sites-phase4-design.md):
 *  - The guest has no ambient authority; every `Sites.*` call arrives here as a
 *    postMessage and is served by the already-hardened, tenant-scoped siteStore /
 *    invokeEndpoint. `siteId`/`scope` come from the main-thread invocation record
 *    (`inv`), NEVER from the worker — the guest can't name a tenant.
 *  - Poisoned / timed-out / crashed workers are terminated + respawned (blast
 *    radius = one worker); poisoned workers are never returned to the pool.
 *  - Every capability re-validates guest args exactly like the HTTP endpoints,
 *    routes only through tenant-scoped code, and enforces per-invocation budgets.
 *
 * Feature-gated: default OFF unless SITES_FUNCTIONS_ENABLED is set AND the live
 * DB kill-switch is off.
 */
import { Worker } from "node:worker_threads";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { siteStore, SiteQuotaExceededError } from "@/lib/sites/data-db";
import { invokeEndpoint } from "@/lib/sites/proxy";

// Keep in sync with fn-worker.mjs MSG.
const MSG = { RUN: "run", CAP: "cap", CAP_RESULT: "capResult", DONE: "done" } as const;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const WORKER_PATH = path.join(process.cwd(), "src/lib/sites/fn/fn-worker.mjs");

const LIMITS = {
  guestCpuMs: 500,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  wallClockMs: 4000,
  outputBytes: 128 * 1024,
};
const CAP_TIMEOUT_MS = 2500;
const HARD_BACKSTOP_MS = 4500;
const VALUE_MAX = 32 * 1024;
const STORE_OP_MAX = 50;
const EGRESS_MAX = 2;
const POOL_SIZE = Math.max(1, Number(process.env.SITES_FN_MAX_CONCURRENCY) || 4);
const QUEUE_MAX = 8;
const PER_SITE_MAX = 2;

export type FnOutcome =
  | { ok: true; value: { status?: number; body?: unknown } }
  | { ok: false; code: number; error: string };

type Who = { scope: string; account: { username: string } | null };
type FnRequest = {
  method: "POST";
  path: string;
  query: Record<string, string>;
  body: unknown;
  visitorId: string;
  account: { username: string } | null;
};
interface Invocation {
  id: string;
  siteId: string;
  scope: string;
  store: number;
  egress: number;
}
type Finish = (out: FnOutcome, kill: boolean) => void;
interface FnWorker extends Worker {
  __inflight?: ((out: FnOutcome, kill: boolean) => void) | null;
}

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

export function functionsEnabled(): boolean {
  const v = process.env.SITES_FUNCTIONS_ENABLED;
  return v === "1" || v === "true";
}

let killCache = { at: 0, off: false };
export async function functionsGloballyEnabled(): Promise<boolean> {
  if (!functionsEnabled()) return false;
  if (Date.now() - killCache.at > 5000) {
    killCache = { at: Date.now(), off: await siteStore.functionsGloballyDisabled() };
  }
  return !killCache.off;
}

// ---------------------------------------------------------------------------
// Worker pool (global-cached so dev hot-reload doesn't leak workers)
// ---------------------------------------------------------------------------

interface Pool {
  all: Set<FnWorker>;
  free: FnWorker[];
  q: Array<() => void>;
}
const g = globalThis as unknown as { __sitesFnPool?: Pool };
const pool: Pool = (g.__sitesFnPool ??= { all: new Set(), free: [], q: [] });

let deathCount = 0;
/** Pool observability (used by tests to assert no worker crash). */
export function fnPoolStats() {
  return { workers: pool.all.size, free: pool.free.length, deaths: deathCount };
}

function spawn(): FnWorker {
  const w = new Worker(WORKER_PATH, {
    env: { NODE_ENV: process.env.NODE_ENV ?? "production" }, // scrub: no secrets/DB urls reach the worker
    execArgv: [], // clean Node — never inherit a tsx/next loader for the plain .mjs worker
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 },
  }) as FnWorker;
  pool.all.add(w);
  w.on("exit", () => onWorkerDeath(w));
  w.on("error", () => onWorkerDeath(w));
  return w;
}

function onWorkerDeath(w: FnWorker) {
  deathCount++;
  pool.all.delete(w);
  const i = pool.free.indexOf(w);
  if (i >= 0) pool.free.splice(i, 1);
  const inflight = w.__inflight;
  w.__inflight = null;
  if (inflight) inflight({ ok: false, code: 500, error: "worker_error" }, true);
  const next = pool.q.shift();
  if (next) next();
  if (pool.all.size < POOL_SIZE) release(spawn());
}

function release(w: FnWorker) {
  if (!pool.all.has(w)) return;
  const next = pool.q.shift();
  if (next) {
    pool.free.push(w);
    next();
  } else {
    pool.free.push(w);
  }
}

function recycle(w: FnWorker) {
  w.__inflight = null;
  void w.terminate(); // exit handler evicts + refills
}

async function checkout(): Promise<FnWorker | null> {
  const ready = pool.free.pop();
  if (ready) return ready;
  if (pool.all.size < POOL_SIZE) return spawn();
  if (pool.q.length >= QUEUE_MAX) return null;
  return new Promise<FnWorker | null>((res) => {
    let settled = false;
    const to = setTimeout(() => {
      if (settled) return;
      settled = true;
      const i = pool.q.indexOf(give);
      if (i >= 0) pool.q.splice(i, 1);
      res(null);
    }, 2000);
    const give = () => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      res(pool.free.pop() ?? spawn());
    };
    pool.q.push(give);
  });
}

// ---------------------------------------------------------------------------
// Fairness, global admission, circuit breaker
// ---------------------------------------------------------------------------

const inFlight = new Map<string, number>();
const perSiteInFlight = (siteId: string) => inFlight.get(siteId) ?? 0;
const incInFlight = (siteId: string) => inFlight.set(siteId, perSiteInFlight(siteId) + 1);
const decInFlight = (siteId: string) => {
  const n = perSiteInFlight(siteId) - 1;
  if (n <= 0) inFlight.delete(siteId);
  else inFlight.set(siteId, n);
};

let bucket = { at: 0, n: 0 };
function admitGlobal(): boolean {
  const now = Date.now();
  if (now - bucket.at > 60_000) bucket = { at: now, n: 0 };
  if (bucket.n >= 60) return false;
  bucket.n++;
  return true;
}

const breaker = new Map<string, { fails: number[]; openUntil: number }>();
function breakerOpen(siteId: string, name: string): boolean {
  const b = breaker.get(`${siteId}:${name}`);
  return !!b && b.openUntil > Date.now();
}
function recordFailure(siteId: string, name: string) {
  const key = `${siteId}:${name}`;
  const now = Date.now();
  const b = breaker.get(key) ?? { fails: [], openUntil: 0 };
  b.fails = b.fails.filter((t) => now - t < 60_000);
  b.fails.push(now);
  if (b.fails.length >= 3) b.openUntil = now + 60_000;
  breaker.set(key, b);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function runSiteFunction(
  siteId: string,
  name: string,
  who: Who,
  request: FnRequest,
): Promise<FnOutcome> {
  const fn = await siteStore.getFunction(siteId, name);
  if (!fn || !fn.armedHash || fn.armedHash !== sha256(fn.code)) {
    return { ok: false, code: 404, error: "not_found" };
  }
  if (breakerOpen(siteId, name)) return { ok: false, code: 404, error: "not_found" };
  // Per-site hourly compute budget — charged only AFTER confirming a real, armed
  // function, so non-existent/disarmed 404s can't drain it (was in the router).
  if (!(await siteStore.checkWriteRate(`fnbudget:${siteId}`, "site", { windowSec: 3600, max: 300 }))) {
    return { ok: false, code: 429, error: "rate_limited" };
  }
  // Per-site fairness BEFORE the global token so an over-limit tenant can't burn
  // process-wide admission without running; refund the token if no worker is free.
  if (perSiteInFlight(siteId) >= PER_SITE_MAX) return { ok: false, code: 503, error: "busy" };
  if (!admitGlobal()) return { ok: false, code: 503, error: "busy" };
  const w = await checkout();
  if (!w) {
    bucket.n = Math.max(0, bucket.n - 1);
    return { ok: false, code: 503, error: "busy" };
  }

  const invocationId = randomBytes(18).toString("base64url");
  const inv: Invocation = { id: invocationId, siteId, scope: who.scope, store: 0, egress: 0 };
  incInFlight(siteId);
  const started = Date.now();

  return await new Promise<FnOutcome>((resolve) => {
    let finished = false;
    const backstop = setTimeout(() => finish({ ok: false, code: 504, error: "timeout" }, true), HARD_BACKSTOP_MS);

    const onMessage = async (m: {
      t: string;
      invocationId?: string;
      callId?: number;
      cap?: string;
      args?: unknown[];
      _terminate?: boolean;
      _log?: string;
      ok?: boolean;
      code?: number;
      error?: string;
      value?: { status?: number; body?: unknown };
    }) => {
      if (m.t === MSG.CAP) {
        if (m.invocationId !== inv.id) return; // staleness guard (defense-in-depth)
        const res = await runCap(inv, m.cap ?? "", (m.args ?? []) as unknown[]);
        w.postMessage({ t: MSG.CAP_RESULT, callId: m.callId, ...res });
        return;
      }
      if (m.t === MSG.DONE) {
        if (m.invocationId !== inv.id) return; // ignore a stale/self-report DONE from a prior run
        if (m._log) auditDetail(siteId, name, m._log);
        const out: FnOutcome = m._terminate
          ? { ok: false, code: 504, error: "timeout" }
          : m.ok
            ? { ok: true, value: m.value ?? {} }
            : { ok: false, code: m.code ?? 500, error: m.error ?? "fn_error" };
        finish(out, !!m._terminate);
      }
    };

    const finish: Finish = (out, kill) => {
      if (finished) return;
      finished = true;
      clearTimeout(backstop);
      w.off("message", onMessage);
      w.__inflight = null;
      decInFlight(siteId);
      if (!out.ok && (out.code === 504 || kill)) recordFailure(siteId, name);
      audit(siteId, name, fn.armedHash, inv, out, Date.now() - started);
      if (kill) recycle(w);
      else release(w);
      resolve(out);
    };

    w.__inflight = finish;
    w.on("message", onMessage);
    w.postMessage({ t: MSG.RUN, invocationId, code: fn.code, request, limits: LIMITS });
  });
}

// ---------------------------------------------------------------------------
// The capability boundary — siteId from `inv`, guest args re-validated
// ---------------------------------------------------------------------------

type CapResult = { ok: true; value: unknown } | { ok: false; error: string };

export async function runCap(inv: Invocation, cap: string, args: unknown[]): Promise<CapResult> {
  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("cap_timeout")), CAP_TIMEOUT_MS))]);
  const bumpStore = () => { if (++inv.store > STORE_OP_MAX) throw new Error("op_budget"); };
  const bumpEgress = () => { if (++inv.egress > EGRESS_MAX) throw new Error("egress_budget"); };
  const nm = (s: unknown): string | null => (typeof s === "string" && NAME_RE.test(s) ? s : null);
  const sized = (v: unknown): string => {
    const s = JSON.stringify(v ?? null);
    if (s.length > VALUE_MAX) throw new Error("value_too_large");
    return s;
  };
  const { siteId, scope } = inv;

  try {
    switch (cap) {
      case "kv.get":
      case "me.get": {
        const c = nm(args[0]);
        const k = nm(args[1]);
        if (!c || !k) throw new Error("bad_name");
        bumpStore();
        const raw = await withTimeout(siteStore.kvGet(siteId, c, k, cap === "me.get" ? scope : "shared"));
        return { ok: true, value: raw == null ? null : safeParse(raw) };
      }
      case "kv.put":
      case "me.put": {
        const c = nm(args[0]);
        const k = nm(args[1]);
        if (!c || !k) throw new Error("bad_name");
        bumpStore();
        await withTimeout(siteStore.kvPut(siteId, c, k, sized(args[2]), cap === "me.put" ? scope : "shared"));
        return { ok: true, value: true };
      }
      case "kv.delete":
      case "me.delete": {
        const c = nm(args[0]);
        const k = nm(args[1]);
        if (!c || !k) throw new Error("bad_name");
        bumpStore();
        return { ok: true, value: await withTimeout(siteStore.kvDelete(siteId, c, k, cap === "me.delete" ? scope : "shared")) };
      }
      case "docs.append": {
        const c = nm(args[0]);
        if (!c) throw new Error("bad_name");
        bumpStore();
        return { ok: true, value: await withTimeout(siteStore.docAppend(siteId, c, sized(args[1]))) };
      }
      case "docs.list": {
        const c = nm(args[0]);
        if (!c) throw new Error("bad_name");
        bumpStore();
        const lim = Math.min(100, Math.max(1, Number(args[1]) || 100));
        const rows = await withTimeout(siteStore.docList(siteId, c, lim));
        return {
          ok: true,
          value: rows.map((d) => ({ id: d.id, data: safeParse(d.data), createdAt: d.createdAt.toISOString() })),
        };
      }
      case "call": {
        const n = nm(args[0]);
        if (!n) throw new Error("bad_name");
        bumpEgress();
        const p = args[1] && typeof args[1] === "object" ? (args[1] as Record<string, unknown>) : {};
        const res = await withTimeout(invokeEndpoint(siteId, n, p));
        return res.ok ? { ok: true, value: { status: res.status, body: res.body } } : { ok: false, error: res.error };
      }
      default:
        return { ok: false, error: "unknown_cap" };
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof SiteQuotaExceededError ? "quota_exceeded" : e instanceof Error ? e.message : "cap_error",
    };
  }
}

// ---------------------------------------------------------------------------
// Audit (server-side only)
// ---------------------------------------------------------------------------

function audit(
  siteId: string,
  name: string,
  armedHash: string | null,
  inv: Invocation,
  out: FnOutcome,
  durationMs: number,
) {
  console.log(
    "[sites.fn]",
    JSON.stringify({
      siteId,
      name,
      armedHash, // provenance: which owner-approved source ran
      // NEVER log the raw scope — for an anonymous visitor it is the unsigned `sv`
      // bearer token. Log a stable hash instead.
      visitorScope: sha256(inv.scope).slice(0, 16),
      durationMs,
      outcome: out.ok ? "ok" : out.error,
      storeOps: inv.store,
      egressOps: inv.egress,
      httpStatus: out.ok ? out.value.status ?? 200 : out.code,
    }),
  );
}
function auditDetail(siteId: string, name: string, detail: string) {
  console.log("[sites.fn.detail]", JSON.stringify({ siteId, name, detail: detail.slice(0, 500) }));
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
