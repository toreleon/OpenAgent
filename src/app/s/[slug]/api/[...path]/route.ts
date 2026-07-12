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
import { createHash } from "crypto";
import { resolveBackendSite } from "@/lib/sites/gate";
import { siteStore, SiteQuotaExceededError } from "@/lib/sites/data-db";
import { invokeEndpoint } from "@/lib/sites/proxy";
import { functionsGloballyEnabled, runSiteFunction } from "@/lib/sites/fn/pool";
import {
  contentTypeForKey,
  deleteBlob,
  getBlob,
  MAX_BLOB_BYTES,
  putBlob,
  validBlobKey,
} from "@/lib/sites/blob";
import { sitesDomain, slugFromHost } from "@/lib/sites/origin";
import {
  newVisitorToken,
  readVisitorToken,
  visitorScope,
  visitorSetCookie,
} from "@/lib/sites/visitor";
import {
  accountClearCookie,
  accountSetCookie,
  dummyVerify,
  hashPassword,
  readAccountId,
  verifyPassword,
} from "@/lib/sites/account";

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

function json(body: unknown, status = 200, setCookie?: string): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
  if (setCookie) headers["set-cookie"] = setCookie;
  return new Response(JSON.stringify(body), { status, headers });
}
const notFound = () => json({ error: "not_found" }, 404);

/**
 * Serve stored blob bytes with the hostile-content header contract: nosniff +
 * sandbox CSP always, an inert image type served inline, everything else forced
 * to octet-stream + attachment (so a stored file can never render as an active
 * document on the app origin).
 */
function blobResponse(key: string, data: Buffer): Response {
  const { type, inline } = contentTypeForKey(key);
  const headers: Record<string, string> = {
    "content-type": type,
    "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
  if (!inline) headers["content-disposition"] = "attachment";
  return new Response(new Uint8Array(data), { status: 200, headers });
}

/**
 * Resolve the per-visitor identity from the `sv` cookie, minting a fresh token +
 * Set-Cookie when the visitor is new. The token scopes private data; the caller
 * threads `setCookie` into its response so the browser stores the identity.
 */
function getVisitor(req: Request): { token: string; setCookie?: string } {
  const existing = readVisitorToken(req);
  if (existing) return { token: existing };
  const token = newVisitorToken();
  return { token, setCookie: visitorSetCookie(token) };
}

/**
 * The EFFECTIVE identity for private data: a logged-in account (scope
 * `account:<id>`) when a valid `sa` cookie is present and the account still
 * exists, else the anonymous visitor (scope `visitor:<token>`, minting the `sv`
 * cookie when new). Private data follows the account across devices.
 */
async function getIdentity(
  req: Request,
  siteId: string,
): Promise<{ scope: string; setCookie?: string; account: { id: string; username: string } | null }> {
  const accountId = readAccountId(req);
  if (accountId) {
    const acct = await siteStore.getAccountById(siteId, accountId);
    if (acct) return { scope: `account:${acct.id}`, account: acct };
    // Stale session (account deleted) → fall through to anonymous.
  }
  const v = getVisitor(req);
  return { scope: visitorScope(v.token), setCookie: v.setCookie, account: null };
}

/** A stable, non-secret public id for the current identity scope. */
function identityPublicId(scope: string): string {
  return createHash("sha256").update(scope).digest("hex").slice(0, 16);
}

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

/**
 * Resolve a kv write/delete target from the path: shared `kv/<c>/<k>` or private
 * per-visitor `me/kv/<c>/<k>`. Returns null when the path isn't a kv target.
 */
function kvTarget(
  path: string[],
): { collection: string; key: string; private: boolean } | null {
  if (path[0] === "kv" && path.length === 3) {
    return { collection: path[1], key: path[2], private: false };
  }
  if (path[0] === "me" && path[1] === "kv" && path.length === 4) {
    return { collection: path[2], key: path[3], private: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function GET(req: Request, { params }: Params) {
  const r = await resolve(req, params);
  if ("deny" in r) return r.deny;
  const path = params.path ?? [];

  // Blob download (hardened content-type; never rendered as a document). The key
  // is a QUERY param, not a path segment, so an image-extension key like
  // "photo.png" doesn't hit the middleware's static-asset matcher exclusion.
  if (path[0] === "blob" && path.length === 1) {
    const key = new URL(req.url).searchParams.get("key") ?? "";
    if (!validBlobKey(key)) return json({ error: "bad_key" }, 400);
    const data = await getBlob(r.siteId, key);
    if (!data) return notFound();
    return blobResponse(key, data);
  }

  // Current account (null when anonymous).
  if (path[0] === "account" && path.length === 1) {
    const id = await getIdentity(req, r.siteId);
    return json({ account: id.account?.username ?? null }, 200, id.setCookie);
  }

  // Per-visitor identity + private read (scoped to account when logged in).
  if (path[0] === "me") {
    const id = await getIdentity(req, r.siteId);
    if (path.length === 1) {
      return json(
        { id: identityPublicId(id.scope), account: id.account?.username ?? null },
        200,
        id.setCookie,
      );
    }
    if (path[1] === "kv" && path.length === 4) {
      if (!validName(path[2]) || !validName(path[3])) return json({ error: "bad_name" }, 400);
      const raw = await siteStore.kvGet(r.siteId, path[2], path[3], id.scope);
      return json({ value: raw === null ? null : safeParse(raw) }, 200, id.setCookie);
    }
    return notFound();
  }

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

  // Blob upload: PUT /api/blob?key=<key> with the raw file bytes as the body.
  if (path[0] === "blob" && path.length === 1) {
    const key = new URL(req.url).searchParams.get("key") ?? "";
    if (!validBlobKey(key)) return json({ error: "bad_key" }, 400);
    const cl = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(cl) && cl > MAX_BLOB_BYTES) return json({ error: "too_large" }, 413);
    const limited = await rateGuard(req, r.siteId);
    if (limited) return limited;
    const buf = Buffer.from(await req.arrayBuffer());
    const res = await putBlob(r.siteId, key, buf);
    if (!res.ok) return json({ error: res.error }, res.code);
    return json({ ok: true, url: `/api/blob?key=${encodeURIComponent(key)}` });
  }

  // Resolve target: shared kv (/kv/c/k) or private per-visitor kv (/me/kv/c/k).
  const target = kvTarget(path);
  if (!target) return notFound();
  if (!validName(target.collection) || !validName(target.key)) {
    return json({ error: "bad_name" }, 400);
  }

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

  const identity = target.private ? await getIdentity(req, r.siteId) : null;
  const scope = identity ? identity.scope : "shared";
  try {
    await siteStore.kvPut(r.siteId, target.collection, target.key, serialized, scope);
  } catch (e) {
    if (e instanceof SiteQuotaExceededError) return json({ error: "quota_exceeded" }, 413);
    throw e;
  }
  return json({ ok: true }, 200, identity?.setCookie);
}

export async function DELETE(req: Request, { params }: Params) {
  const r = await resolve(req, params);
  if ("deny" in r) return r.deny;
  const path = params.path ?? [];

  // Blob delete: DELETE /api/blob?key=<key>.
  if (path[0] === "blob" && path.length === 1) {
    const key = new URL(req.url).searchParams.get("key") ?? "";
    if (!validBlobKey(key)) return json({ error: "bad_key" }, 400);
    const limited = await rateGuard(req, r.siteId);
    if (limited) return limited;
    const deleted = await deleteBlob(r.siteId, key);
    return json({ ok: true, deleted });
  }

  const target = kvTarget(path);
  if (!target) return notFound();
  if (!validName(target.collection) || !validName(target.key)) {
    return json({ error: "bad_name" }, 400);
  }

  const limited = await rateGuard(req, r.siteId);
  if (limited) return limited;

  const identity = target.private ? await getIdentity(req, r.siteId) : null;
  const scope = identity ? identity.scope : "shared";
  const deleted = await siteStore.kvDelete(r.siteId, target.collection, target.key, scope);
  return json({ ok: true, deleted }, 200, identity?.setCookie);
}

/** Account auth: POST /api/account/{signup,login,logout}. */
async function handleAccount(req: Request, siteId: string, path: string[]): Promise<Response> {
  const action = path[1];
  const limited = await rateGuard(req, siteId);
  if (limited) return limited;

  if (action === "logout" && path.length === 2) {
    return json({ ok: true }, 200, accountClearCookie());
  }
  if ((action === "signup" || action === "login") && path.length === 2) {
    const body = await readJsonBody(req);
    if ("deny" in body) return body.deny;
    const rec = body.value as Record<string, unknown> | null;
    const username = typeof rec?.username === "string" ? rec.username.trim() : "";
    const password = typeof rec?.password === "string" ? rec.password : "";
    if (!validName(username)) return json({ error: "bad_username" }, 400);
    if (password.length < 8 || password.length > 200) return json({ error: "weak_password" }, 400);

    if (action === "signup") {
      const acct = await siteStore.createAccount(siteId, username, await hashPassword(password));
      if (!acct) return json({ error: "username_taken" }, 409);
      return json({ ok: true, username: acct.username }, 200, accountSetCookie(acct.id));
    }
    // login
    const acct = await siteStore.findAccountByUsername(siteId, username);
    let ok = false;
    if (acct) ok = await verifyPassword(password, acct.passwordHash);
    else await dummyVerify(password);
    if (!acct || !ok) return json({ error: "invalid_credentials" }, 401);
    return json({ ok: true, username: acct.username }, 200, accountSetCookie(acct.id));
  }
  return notFound();
}

export async function POST(req: Request, { params }: Params) {
  const r = await resolve(req, params);
  if ("deny" in r) return r.deny;
  const path = params.path ?? [];

  if (path[0] === "account") return handleAccount(req, r.siteId, path);

  // Owner-armed fetch proxy: POST /api/call/<name> { params }.
  if (path[0] === "call" && path.length === 2) {
    if (!validName(path[1])) return json({ error: "bad_name" }, 400);
    const limited = await rateGuard(req, r.siteId);
    if (limited) return limited;
    const body = await readJsonBody(req);
    if ("deny" in body) return body.deny;
    const rec = body.value as Record<string, unknown> | null;
    const params =
      rec && typeof rec.params === "object" && rec.params !== null
        ? (rec.params as Record<string, unknown>)
        : {};
    const result = await invokeEndpoint(r.siteId, path[1], params);
    if (!result.ok) return json({ error: result.error }, result.code);
    return json({ status: result.status, body: result.body });
  }

  // Phase 4 — sandboxed server function: POST /api/fn/<name> { input }.
  // Gated: operator flag + live kill (functionsGloballyEnabled) + the same
  // link/deploy/backend gate as everything else, then per-function arm inside
  // runSiteFunction. Every miss is a uniform 404 (no oracle).
  if (path[0] === "fn" && path.length === 2) {
    if (!(await functionsGloballyEnabled())) return notFound();
    if (!validName(path[1])) return json({ error: "bad_name" }, 400);
    // Per-IP flood guard here; the per-site hourly compute BUDGET is charged
    // inside runSiteFunction (only for a real, armed function) so 404s can't drain it.
    if (!(await siteStore.checkWriteRate(`fn:${r.siteId}`, ipBlock(req), { windowSec: 60, max: 20 }))) {
      return json({ error: "rate_limited" }, 429);
    }
    const parsed = await readJsonBody(req);
    if ("deny" in parsed) return parsed.deny;
    const rec = parsed.value;
    // Guard the shape: a JSON primitive body (42, "x", true) makes `"input" in rec` throw.
    const isObj = rec !== null && typeof rec === "object" && !Array.isArray(rec);
    const input = isObj && "input" in (rec as Record<string, unknown>) ? (rec as Record<string, unknown>).input : rec;
    const id = await getIdentity(req, r.siteId);
    const account = id.account ? { username: id.account.username } : null;
    const fnRequest = {
      method: "POST" as const,
      path: "/",
      query: Object.fromEntries(new URL(req.url).searchParams),
      body: input,
      visitorId: identityPublicId(id.scope),
      account,
    };
    const out = await runSiteFunction(r.siteId, path[1], { scope: id.scope, account }, fnRequest);
    if (!out.ok) return json({ error: out.error }, out.code, id.setCookie);
    try {
      // Guest fully controls status/body — clamp to a valid Response status and
      // ensure the hardened json() contract always wins even on a weird value.
      const n = Number(out.value.status);
      const status = Number.isFinite(n) ? Math.min(599, Math.max(200, Math.trunc(n))) : 200;
      return json(out.value.body ?? null, status, id.setCookie);
    } catch {
      return json({ error: "fn_error" }, 500, id.setCookie);
    }
  }

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
