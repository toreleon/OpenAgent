/**
 * SSRF-guarded HTTP fetch — the shared transport for every server-side tool that
 * retrieves a model/user-supplied URL (web_fetch, and every web_search backend).
 *
 * Threat model: this runs on our server, next to cloud metadata endpoints and
 * internal services. A naive `fetch(userUrl)` is a classic SSRF: the model could
 * be tricked into reading http://169.254.169.254/ (cloud IMDS), localhost admin
 * panels, or private-network hosts. We defend in two layers:
 *
 *   Layer 1 (pre-fetch): parse+normalize the URL, allow only http/https, strip
 *   credentials, cap length, and reject literal-IP hosts in reserved ranges plus
 *   denied hostnames (localhost/*.local/*.internal/metadata.google.internal).
 *   Literal IPs must be caught here because undici does NOT run connect.lookup
 *   for them.
 *
 *   Layer 2 (connect-time): for hostnames, an undici Agent whose connect.lookup
 *   resolves DNS and rejects if ANY resolved address is in the blocklist, then
 *   hands undici exactly the validated addresses. Because validation and the
 *   socket connect are atomic, this defeats DNS-rebinding / TOCTOU.
 *
 * Redirects are followed manually (capped) and re-validated on every hop, so a
 * public URL can't 302 into a private one. Total time and body size are bounded.
 *
 * SERVER-ONLY. Node.js runtime (uses node:dns/node:net + undici). We import
 * undici's OWN `fetch`, not the global one: a standalone-undici dispatcher passed
 * to Node's built-in fetch throws "invalid onRequestStart method" on version skew.
 */
import { fetch as undiciFetch, Agent, type Dispatcher } from "undici";
import dns from "node:dns";
import net from "node:net";
import ipaddr from "ipaddr.js";

/** Error codes mirror the Anthropic web_fetch tool's error taxonomy. */
export type SafeFetchCode =
  | "invalid_url"
  | "bad_scheme"
  | "url_too_long"
  | "url_not_allowed" // SSRF / denied host / blocked IP
  | "too_many_redirects"
  | "timeout"
  | "too_large"
  | "fetch_failed";

export class SafeFetchError extends Error {
  code: SafeFetchCode;
  constructor(code: SafeFetchCode, message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

const MAX_URL_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_REDIRECTS = 5;

/** Reserved / non-routable IPv4 CIDRs that must never be reachable. */
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local incl. 169.254.169.254 cloud IMDS
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

/** Reserved / non-routable IPv6 ranges. */
const BLOCKED_V6: [string, number][] = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["64:ff9b::", 96], // NAT64 (can embed IPv4)
];

let _blockList: net.BlockList | null = null;
function blockList(): net.BlockList {
  if (_blockList) return _blockList;
  const bl = new net.BlockList();
  for (const [addr, prefix] of BLOCKED_V4) bl.addSubnet(addr, prefix, "ipv4");
  for (const [addr, prefix] of BLOCKED_V6) bl.addSubnet(addr, prefix, "ipv6");
  _blockList = bl;
  return bl;
}

/**
 * Normalize an address (unmasking IPv4-mapped IPv6 like ::ffff:169.254.169.254)
 * and test it against the blocklist. Unparseable → treated as blocked.
 */
export function isBlockedIp(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6") {
      const v6 = parsed as ipaddr.IPv6;
      if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address();
    }
    const kind = parsed.kind(); // "ipv4" | "ipv6"
    return blockList().check(parsed.toString(), kind);
  } catch {
    return true;
  }
}

/** Hostnames we refuse regardless of DNS resolution. */
function isDeniedHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "metadata.google.internal"
  ) {
    return true;
  }
  // Literal IP host (WHATWG URL already normalizes encoded IPv4 like 2130706433
  // → 127.0.0.1 for http(s), so ipaddr sees the canonical form).
  const bare = h.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(bare) && isBlockedIp(bare)) return true;
  return false;
}

/** Validate scheme, length, credentials, and Layer-1 host safety. Throws SafeFetchError. */
function validateUrl(raw: string, allowPrivate: boolean): URL {
  if (raw.length > MAX_URL_LENGTH) {
    throw new SafeFetchError("url_too_long", `URL exceeds ${MAX_URL_LENGTH} characters.`);
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeFetchError("invalid_url", `Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SafeFetchError("bad_scheme", `Only http/https URLs are allowed (got ${u.protocol}).`);
  }
  if (u.username || u.password) {
    throw new SafeFetchError("url_not_allowed", "URLs with embedded credentials are not allowed.");
  }
  if (!allowPrivate && isDeniedHostname(u.hostname)) {
    throw new SafeFetchError(
      "url_not_allowed",
      `Refusing to fetch a private, loopback, or link-local address (${u.hostname}).`,
    );
  }
  return u;
}

// Cached dispatchers. The guarded one rejects private IPs at connect time; the
// permissive one is only used when WEBFETCH_ALLOW_PRIVATE_NETWORK=1 (local dev).
let _guarded: Agent | null = null;
let _permissive: Agent | null = null;

function guardedDispatcher(): Agent {
  if (_guarded) return _guarded;
  _guarded = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
          if (err) return callback(err, "", 0);
          const addrs = addresses as unknown as { address: string; family: number }[];
          for (const a of addrs) {
            if (isBlockedIp(a.address)) {
              return callback(
                new SafeFetchError(
                  "url_not_allowed",
                  `Refusing to connect to blocked address ${a.address} for host ${hostname}.`,
                ),
                "",
                0,
              );
            }
          }
          // Hand undici the validated address set (array form).
          callback(null, addrs as never, 0 as never);
        });
      },
    },
  });
  return _guarded;
}

function permissiveDispatcher(): Agent {
  if (_permissive) return _permissive;
  _permissive = new Agent();
  return _permissive;
}

/** Fully-read, size-capped result of a safe fetch (after any redirects). */
export interface SafeResponse {
  ok: boolean;
  status: number;
  /** Final URL after redirects. */
  finalUrl: string;
  requestedUrl: string;
  redirected: boolean;
  /** Lowercased content-type without parameters (e.g. "text/html"). */
  contentType: string;
  /** Raw content-type header (with charset), for charset sniffing. */
  contentTypeRaw: string;
  headers: Headers;
  /** Body bytes, truncated to maxBytes. */
  body: Buffer;
  /** True when the body was cut off at maxBytes. */
  truncated: boolean;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Override the WEBFETCH_ALLOW_PRIVATE_NETWORK env for this call. */
  allowPrivateNetwork?: boolean;
}

const DEFAULT_UA =
  "agent-app-template-webfetch/1.0 (+https://github.com/; automated agent tool)";

function envAllowPrivate(): boolean {
  return process.env.WEBFETCH_ALLOW_PRIVATE_NETWORK === "1";
}

/** Read a web ReadableStream body, aborting once it exceeds `maxBytes`. */
async function readCapped(
  res: Awaited<ReturnType<typeof undiciFetch>>,
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { body: buf.subarray(0, maxBytes), truncated: true };
    return { body: buf, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        const remaining = maxBytes - (total - value.byteLength);
        if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)));
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Stop the download; ignore cancel errors.
    try {
      await reader.cancel();
    } catch {
      /* noop */
    }
  }
  return { body: Buffer.concat(chunks), truncated };
}

/**
 * SSRF-guarded fetch with manual redirect handling, a total-time budget, and a
 * body-size cap. Reads and returns the (capped) body. Throws {@link SafeFetchError}
 * on any policy violation or transport failure.
 */
export async function safeFetch(
  requestedUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeResponse> {
  const allowPrivate = opts.allowPrivateNetwork ?? envAllowPrivate();
  const timeoutMs =
    opts.timeoutMs ?? (Number(process.env.WEBFETCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const maxBytes = opts.maxBytes ?? (Number(process.env.WEBFETCH_MAX_BYTES) || DEFAULT_MAX_BYTES);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const dispatcher: Dispatcher = allowPrivate ? permissiveDispatcher() : guardedDispatcher();

  // One deadline shared across every redirect hop.
  const signal = AbortSignal.timeout(timeoutMs);

  let currentUrl = validateUrl(requestedUrl, allowPrivate).toString();
  let redirected = false;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(currentUrl, {
        method: opts.method ?? "GET",
        headers: {
          "user-agent": DEFAULT_UA,
          accept: "text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.8",
          ...opts.headers,
        },
        body: opts.body,
        redirect: "manual",
        dispatcher,
        signal,
      });
    } catch (err) {
      if (err instanceof SafeFetchError) throw err;
      // The connect.lookup rejection surfaces as the abort/cause chain.
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof SafeFetchError) throw cause;
      if (signal.aborted) {
        throw new SafeFetchError("timeout", `Request timed out after ${timeoutMs}ms.`);
      }
      const msg = err instanceof Error ? err.message : "fetch failed";
      throw new SafeFetchError("fetch_failed", `Fetch failed: ${msg}`);
    }

    // Manual redirect handling: re-validate every hop.
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      // Drain/cancel the redirect body so the socket can be reused.
      try {
        await res.body?.cancel();
      } catch {
        /* noop */
      }
      if (hop >= maxRedirects) {
        throw new SafeFetchError("too_many_redirects", `Exceeded ${maxRedirects} redirects.`);
      }
      const location = res.headers.get("location") as string;
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        throw new SafeFetchError("invalid_url", `Invalid redirect target: ${location}`);
      }
      currentUrl = validateUrl(next.toString(), allowPrivate).toString();
      redirected = true;
      continue;
    }

    const contentTypeRaw = res.headers.get("content-type") ?? "";
    const contentType = contentTypeRaw.split(";")[0]!.trim().toLowerCase();
    const { body, truncated } = await readCapped(res, maxBytes);

    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      finalUrl: currentUrl,
      requestedUrl,
      redirected,
      contentType,
      contentTypeRaw,
      headers: res.headers as unknown as Headers,
      body,
      truncated,
    };
  }

  // Unreachable: the loop returns or throws.
  throw new SafeFetchError("too_many_redirects", `Exceeded ${maxRedirects} redirects.`);
}
