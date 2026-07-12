/**
 * PUBLIC (unauthenticated) serving of a deployed Site at /s/<slug>.
 *
 * SECURITY MODEL — the crux of this feature. The stored page content is
 * untrusted (model- or user-authored HTML/JS). It is served on the app's own
 * origin (the user chose path-based URLs over subdomains), so isolation is
 * enforced by response headers the document cannot override:
 *
 *  - `Content-Security-Policy: sandbox allow-scripts allow-popups` forces the
 *    document into an OPAQUE origin. It therefore cannot read the app's auth
 *    cookie (`document.cookie` is empty), cannot touch app localStorage, and
 *    cannot read same-origin responses. `allow-same-origin` is deliberately
 *    absent — this is the same isolation the in-app artifact iframe relies on.
 *  - `connect-src` is limited to the pinned CDNs (NOT 'self'), so untrusted JS
 *    cannot fetch/XHR the app's API with the visitor's cookie (blocks CSRF via
 *    fetch). `form-action 'none'` + no `allow-forms` blocks form-based CSRF, and
 *    no `allow-top-navigation` keeps it from driving the top frame.
 *  - `script-src`/`style-src`/`img-src`/`font-src` are pinned to the CDNs the
 *    sandbox builders use (see src/components/artifacts/sandbox.ts).
 *
 * This route bypasses `withAuth` (see the `s/` exclusion in src/middleware.ts)
 * and never gates on a session — it is public by design. It serves ONLY sites
 * whose visibility is `link` and that have a live deployment; every other case
 * (missing, private, undeployed, unknown slug) returns 404 so existence never
 * leaks.
 */
import prisma from "@/lib/db";
import { loadPublicSite } from "@/lib/sites";
import { sitesDomain, slugFromHost, siteCanonicalUrl } from "@/lib/sites/origin";
import { buildSiteSrcDoc, SITE_CDN_HOSTS } from "@/components/artifacts/sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CDN = SITE_CDN_HOSTS.join(" ");

/**
 * LEGACY CSP — opaques the document's origin and pins it to the sandbox CDNs.
 * Used only when subdomain serving is NOT configured (SITES_DOMAIN unset): the
 * page shares the app origin, so it must be forced into an opaque origin exactly
 * like the in-app artifact iframe.
 */
const OPAQUE_CSP = [
  "sandbox allow-scripts allow-popups",
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDN}`,
  `style-src 'unsafe-inline' ${CDN}`,
  "img-src * data: blob:",
  `font-src data: ${CDN}`,
  `connect-src ${CDN}`,
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * REAL-ORIGIN CSP — used when the Site is served on its OWN origin
 * (`<slug>.<SITES_DOMAIN>`). The `sandbox` directive is intentionally DROPPED so
 * the page is a normal document on its own origin (own storage, same-origin
 * `/api/*` in later phases, forms post to itself). Isolation from the APP comes
 * from the separate registrable domain (+ host-only app cookie); isolation from
 * OTHER sites comes from each site's distinct subdomain origin. `'self'` now
 * resolves to the site's own origin, so it is safe to allow.
 */
const REAL_ORIGIN_CSP = [
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${CDN}`,
  `style-src 'self' 'unsafe-inline' ${CDN}`,
  "img-src * data: blob:",
  `font-src data: ${CDN}`,
  `connect-src 'self' ${CDN}`,
  "frame-src 'none'",
  "form-action 'self'",
  "base-uri 'none'",
].join("; ");

function html(body: string, status: number, extraCsp?: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": extraCsp ?? OPAQUE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cache-Control": status === 200 ? "public, max-age=60" : "no-store",
    },
  });
}

const NOT_FOUND = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Site not found</title>
    <style>
      html, body { margin: 0; height: 100%; }
      body { display: grid; place-items: center; background: #0b0d10; color: #e6e8eb;
             font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
      .box { text-align: center; padding: 24px; }
      h1 { font-size: 3rem; margin: 0 0 .25em; }
      p { color: #9aa4af; margin: 0; }
    </style>
  </head>
  <body><div class="box"><h1>404</h1><p>This site isn't available.</p></div></body>
</html>`;

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const domain = sitesDomain();
  const viaSiteHost = slugFromHost(req.headers.get("host")) !== null;

  // Subdomain serving is configured, but this request arrived on the APP host via
  // the legacy /s/<slug> path → 301 to the site's own origin. We redirect BEFORE
  // any DB lookup, so a known and an unknown slug behave identically here (no
  // existence leak on the app host); the subdomain 404s unknown slugs.
  if (domain && !viaSiteHost) {
    const canonical = siteCanonicalUrl(params.slug, new URL(req.url).protocol, "/");
    if (canonical) return Response.redirect(canonical, 301);
  }

  const site = await loadPublicSite(prisma, params.slug);
  // 404 for missing / private / undeployed — never distinguish (no existence leak).
  // The not-found page carries a strict, no-CDN CSP of its own.
  if (!site) {
    return html(
      NOT_FOUND,
      404,
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
    );
  }
  // On its own origin (subdomain) → real-origin CSP (no sandbox). Legacy path
  // serving (SITES_DOMAIN unset) keeps the opaque-origin sandbox.
  return html(buildSiteSrcDoc(site.type, site.content), 200, viaSiteHost ? REAL_ORIGIN_CSP : OPAQUE_CSP);
}
