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
import { buildSiteSrcDoc, SITE_CDN_HOSTS } from "@/components/artifacts/sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CDN = SITE_CDN_HOSTS.join(" ");

/** CSP that opaques the document's origin and pins it to the sandbox CDNs. */
const CSP = [
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

function html(body: string, status: number, extraCsp?: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": extraCsp ?? CSP,
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

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
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
  return html(buildSiteSrcDoc(site.type, site.content), 200);
}
