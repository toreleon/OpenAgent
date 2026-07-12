/**
 * PUBLIC (unauthenticated) DATA-PLANE for a deployed Site's mini-app backend,
 * served at  <slug>.<SITES_DOMAIN>/api/*  (the middleware rewrites a site-host
 * request to /s/<slug>/api/*, which lands here).
 *
 * SECURITY MODEL — these are ordinary, directly-`curl`-able app-origin URLs, so
 * they are treated as HOSTILE app-origin content and made safe against
 * unauthenticated direct calls (the sandbox CSP on the page is NOT the boundary):
 *  - Every response ships `Content-Security-Policy: sandbox; default-src 'none'`
 *    + `X-Content-Type-Options: nosniff` and a forced `application/json` type, so
 *    a response can never be navigated-to and rendered as an active document on
 *    the app origin (the stored-XSS → account-takeover class).
 *  - The data plane resolves the Site through the SAME gate as the page
 *    (link-visibility + live deployment) plus the backend master switch
 *    (resolveBackendSite); every miss is a uniform 404 (no existence oracle).
 *  - The API is served ONLY on the Site's own origin: when SITES_DOMAIN is set,
 *    a request whose Host is not this slug's site host 404s. Because page and API
 *    then share one origin, the site's own fetches are same-origin (no CORS), and
 *    NO `Access-Control-Allow-Origin` is emitted — so another origin cannot read
 *    a Site's data or drive a JSON write through a victim's browser (the
 *    application/json body forces a CORS preflight that this route never allows).
 *  - Writes are size-capped (Content-Length pre-check + body cap), name-validated,
 *    per-(site, /24 IP block) rate-limited via a durable bucket, and quota-checked
 *    atomically (413 on overflow). Reads/writes go only through the tenant-scoped
 *    siteStore, so every query is bound to the resolved siteId.
 *
 * Capabilities (Phase 1):
 *   GET    /api/kv/<collection>/<key>      → { value }        (value=null if absent)
 *   PUT    /api/kv/<collection>/<key>      { value } → { ok }  (write)
 *   DELETE /api/kv/<collection>/<key>      → { ok, deleted }   (write)
 *   GET    /api/docs/<collection>          → { documents:[…] } (newest-first)
 *   POST   /api/docs/<collection>          { data } → { ok, id }(write)
 */
import { resolveBackendSite } from "@/lib/sites/gate";
import { siteStore, SiteQuotaExceededError } from "@/lib/sites/data-db";
import { sitesDomain, slugFromHost } from "@/lib/sites/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024; // hard cap on a request body
const MAX_VALUE_BYTES = 32 * 1024; // hard cap on a single stored value/document
const WRITE_WINDOW_SEC = 60;
const WRITE_MAX_PER_WINDOW = 60; // per (site, /24 IP block) per minute
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/; // collection / key shape

type Params = { params: { slug: string; path?: string[] } };

// ---------------------------------------------------------------------------
// Response helper — the hardened header contract on EVERY response
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-security-policy": "sandbox; default-src 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}
const notFound = () => json({ error: "not_found" }, 404);

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** Coarse client identifier for rate limiting: the /24 block, never stored raw. */
function ipBlock(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const ip = (xff.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim();
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : ip;
}

/**
 * Resolve the Site for this request or return a Response to send back. Enforces
 * "API only on the Site's own origin" when SITES_DOMAIN is set, then the shared
 * visibility + backend gate.
 */
async function resolve(
  req: Request,
  params: Params["params"],
): Promise<{ siteId: string } | { deny: Response }> {
  if (sitesDomain()) {
    // The middleware only rewrites site-host requests to this slug, so a Host
    // that doesn't resolve to this exact slug means a direct app-host hit — the
    // data plane lives on the site origin only.
    if (slugFromHost(req.headers.get("host")) !== params.slug) return { deny: notFound() };
  }
  const site = await resolveBackendSite(params.slug);
  return site ? site : { deny: notFound() };
}

/** Read + validate a JSON request body under the size caps. */
async function readJsonBody(req: Request): Promise<{ value: unknown } | { deny: Response }> {
  const cl = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) return { deny: json({ error: "too_large" }, 413) };
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { deny: json({ error: "too_large" }, 413) };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { deny: json({ error: "bad_json" }, 400) };
  }
}

/** Enforce the per-(site, ip) write rate limit; returns a 429 Response if over. */
async function rateGuard(req: Request, siteId: string): Promise<Response | null> {
  const allowed = await siteStore.checkWriteRate(siteId, ipBlock(req), {
    windowSec: WRITE_WINDOW_SEC,
    max: WRITE_MAX_PER_WINDOW,
  });
  return allowed ? null : json({ error: "rate_limited" }, 429);
}

function validName(s: string | undefined): s is string {
  return typeof s === "string" && NAME_RE.test(s);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function GET(req: Request, { params }: Params) {
  const r = await resolve(req, params);
  if ("deny" in r) return r.deny;
  const path = params.path ?? [];

  if (path[0] === "kv" && path.length === 3) {
    if (!validName(path[1]) || !validName(path[2])) return json({ error: "bad_name" }, 400);
    const raw = await siteStore.kvGet(r.siteId, path[1], path[2]);
    return json({ value: raw === null ? null : safeParse(raw) });
  }

  if (path[0] === "docs" && path.length === 2) {
    if (!validName(path[1])) return json({ error: "bad_name" }, 400);
    const docs = await siteStore.docList(r.siteId, path[1]);
    return json({
      documents: docs.map((d) => ({
        id: d.id,
        data: safeParse(d.data),
        createdAt: d.createdAt.toISOString(),
      })),
    });
  }

  return notFound();
}

export async function PUT(req: Request, { params }: Params) {
  const r = await resolve(req, params);
  if ("deny" in r) return r.deny;
  const path = params.path ?? [];
  if (path[0] !== "kv" || path.length !== 3) return notFound();
  if (!validName(path[1]) || !validName(path[2])) return json({ error: "bad_name" }, 400);

  const limited = await rateGuard(req, r.siteId);
  if (limited) return limited;

  const body = await readJsonBody(req);
  if ("deny" in body) return body.deny;
  const rec = body.value as Record<string, unknown> | null;
  if (!rec || typeof rec !== "object" || !("value" in rec)) {
    return json({ error: "missing_value" }, 400);
  }
  const serialized = JSON.stringify(rec.value);
  if (serialized.length > MAX_VALUE_BYTES) return json({ error: "value_too_large" }, 413);

  try {
    await siteStore.kvPut(r.siteId, path[1], path[2], serialized);
  } catch (e) {
    if (e instanceof SiteQuotaExceededError) return json({ error: "quota_exceeded" }, 413);
    throw e;
  }
  return json({ ok: true });
}

export async function DELETE(req: Request, { params }: Params) {
  const r = await resolve(req, params);
  if ("deny" in r) return r.deny;
  const path = params.path ?? [];
  if (path[0] !== "kv" || path.length !== 3) return notFound();
  if (!validName(path[1]) || !validName(path[2])) return json({ error: "bad_name" }, 400);

  const limited = await rateGuard(req, r.siteId);
  if (limited) return limited;

  const deleted = await siteStore.kvDelete(r.siteId, path[1], path[2]);
  return json({ ok: true, deleted });
}

export async function POST(req: Request, { params }: Params) {
  const r = await resolve(req, params);
  if ("deny" in r) return r.deny;
  const path = params.path ?? [];
  if (path[0] !== "docs" || path.length !== 2) return notFound();
  if (!validName(path[1])) return json({ error: "bad_name" }, 400);

  const limited = await rateGuard(req, r.siteId);
  if (limited) return limited;

  const body = await readJsonBody(req);
  if ("deny" in body) return body.deny;
  const rec = body.value as Record<string, unknown> | null;
  if (!rec || typeof rec !== "object" || !("data" in rec)) {
    return json({ error: "missing_data" }, 400);
  }
  const serialized = JSON.stringify(rec.data);
  if (serialized.length > MAX_VALUE_BYTES) return json({ error: "data_too_large" }, 413);

  let id: string;
  try {
    id = await siteStore.docAppend(r.siteId, path[1], serialized);
  } catch (e) {
    if (e instanceof SiteQuotaExceededError) return json({ error: "quota_exceeded" }, 413);
    throw e;
  }
  return json({ ok: true, id });
}

/** Parse stored JSON, falling back to the raw string if it isn't valid JSON. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
