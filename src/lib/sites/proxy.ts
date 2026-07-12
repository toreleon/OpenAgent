/**
 * The Site fetch PROXY (Phase 3): invoke an owner-armed endpoint, injecting a
 * server-held secret into the outbound request so a keyed 3rd-party API can be
 * called without the key ever reaching the client.
 *
 * Security (this is reachable by any visitor via POST /api/call/<name>):
 *  - Only ARMED endpoints run, and only against the OWNER-approved host — a
 *    visitor {param} can fill query VALUES but can never change the destination
 *    (the fully-resolved URL host must equal approvedHost).
 *  - Secrets are injected FIRST and URL-encoded (encoding also neutralizes any
 *    braces, so the later param pass can't reach into an injected secret), and
 *    params are URL-encoded too.
 *  - The call goes through safeFetch (connect-time SSRF guard) with NO redirects,
 *    so a secret in the URL is never re-sent to an upstream-chosen redirect
 *    target; body is size-capped and the whole call is time-bounded.
 *  - Each call is metered against the endpoint's per-day budget.
 */
import { safeFetch } from "@/lib/net/safe-fetch";
import { siteStore } from "@/lib/sites/data-db";

export type ProxyResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; code: number; error: string };

const MAX_PROXY_BYTES = 64 * 1024;

export async function invokeEndpoint(
  siteId: string,
  name: string,
  params: Record<string, unknown>,
): Promise<ProxyResult> {
  const ep = await siteStore.getEndpoint(siteId, name);
  if (!ep || !ep.armed || !ep.approvedHost) {
    return { ok: false, code: 403, error: "endpoint_not_available" };
  }
  if (!(await siteStore.consumeEndpointBudget(siteId, ep.id))) {
    return { ok: false, code: 429, error: "budget_exceeded" };
  }

  let url = ep.urlTemplate;

  // 1) Inject secrets (encoded first, so the param pass can't reach into them).
  let refs: string[] = [];
  try {
    const parsed = JSON.parse(ep.secretRefs);
    if (Array.isArray(parsed)) refs = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    refs = [];
  }
  for (const sname of refs) {
    const val = await siteStore.getDecryptedSecret(siteId, sname);
    if (val === null) return { ok: false, code: 500, error: "secret_unavailable" };
    url = url.split(`{{${sname}}}`).join(encodeURIComponent(val));
  }

  // 2) Inject visitor params (query values only), URL-encoded.
  url = url.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, k) =>
    encodeURIComponent(String((params ?? {})[k] ?? "")),
  );

  // 3) Parse + host re-validation — a param can never redirect the request.
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, code: 400, error: "bad_url" };
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return { ok: false, code: 400, error: "bad_scheme" };
  }
  if (target.host !== ep.approvedHost) {
    return { ok: false, code: 400, error: "host_not_approved" };
  }

  // 4) SSRF-guarded fetch, NO redirects, capped + timed.
  try {
    const res = await safeFetch(target.toString(), {
      method: ep.method,
      maxRedirects: 0,
      maxBytes: MAX_PROXY_BYTES,
      timeoutMs: 10_000,
    });
    const text = res.body.toString("utf8");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* return raw text when not JSON */
    }
    return { ok: true, status: res.status, body };
  } catch {
    return { ok: false, code: 502, error: "upstream_error" };
  }
}
