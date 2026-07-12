/**
 * Site ORIGIN helpers — the Phase-0 foundation for serving each published Site
 * on its OWN origin at `<slug>.<SITES_DOMAIN>` instead of the shared, opaque-
 * origin path `/s/<slug>`.
 *
 * WHY a separate origin (and ideally a separate REGISTRABLE domain from the app):
 *  - The app's auth cookie is unreachable from a site origin (cross-site), so
 *    untrusted site JS can never read a visitor's app session. With a distinct
 *    registrable domain this is structural; the app cookie is also pinned
 *    host-only as defense-in-depth (see src/lib/auth.ts).
 *  - Each site gets its own real origin, so (from Phase 2) it can hold its own
 *    per-visitor cookie / localStorage / same-origin `/api/*` — the capability a
 *    static Artifact can never have. Sites are isolated from EACH OTHER by their
 *    distinct per-subdomain origin.
 *
 * This module is intentionally dependency-free and edge-safe: it is imported by
 * `src/middleware.ts` (Edge runtime), so it must use only `process.env` + string
 * ops — no Node APIs, no Prisma.
 *
 * FEATURE FLAG: everything keys off `SITES_DOMAIN`. When it is unset, Sites fall
 * back to the legacy path-based, opaque-origin serving (nothing changes) — so a
 * deployment that has not configured a wildcard domain keeps working.
 *
 *   dev:  SITES_DOMAIN=localtest.me:3000   (*.localtest.me resolves to 127.0.0.1)
 *   prod: SITES_DOMAIN=mysites.app         (wildcard DNS + TLS for *.mysites.app;
 *                                           a DIFFERENT registrable domain than
 *                                           the app — the Cloudflare-Pages model)
 */

/** The configured sites domain (host[:port]), lowercased, or null when unset. */
export function sitesDomain(): string | null {
  const raw = process.env.SITES_DOMAIN?.trim().toLowerCase();
  return raw ? raw : null;
}

/** True when subdomain serving is configured. */
export function isSitesDomainEnabled(): boolean {
  return sitesDomain() !== null;
}

/** A site slug is our own kebab slug shape: lowercase alphanumerics + dashes. */
function isSlugLabel(label: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);
}

/**
 * Extract the site slug from a request `Host` header, or null when the host is
 * not a `<slug>.<SITES_DOMAIN>` site host (e.g. it's the app host, or the
 * feature is disabled). The comparison includes the port, so `SITES_DOMAIN`
 * must carry the dev port (`localtest.me:3000`) to match `abc.localtest.me:3000`.
 * Only a SINGLE leading label is accepted — `a.b.<domain>` is rejected so nested
 * hosts can't smuggle a slug.
 */
export function slugFromHost(host: string | null | undefined): string | null {
  const domain = sitesDomain();
  if (!domain || !host) return null;
  const h = host.trim().toLowerCase();
  const suffix = `.${domain}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  if (!label || label.includes(".") || !isSlugLabel(label)) return null;
  return label;
}

/** The canonical site host `<slug>.<SITES_DOMAIN>`, or null when disabled. */
export function siteHost(slug: string): string | null {
  const domain = sitesDomain();
  return domain ? `${slug}.${domain}` : null;
}

/**
 * The canonical absolute URL for a site on its own origin, or null when
 * disabled. `protocol` should be taken from the current request
 * (`new URL(req.url).protocol` → "http:" | "https:") so local http and prod
 * https both redirect correctly. `path` is appended verbatim (default "/").
 */
export function siteCanonicalUrl(slug: string, protocol: string, path = "/"): string | null {
  const host = siteHost(slug);
  if (!host) return null;
  const proto = protocol.endsWith(":") ? protocol : `${protocol}:`;
  return `${proto}//${host}${path}`;
}
