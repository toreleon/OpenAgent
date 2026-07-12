import { withAuth } from "next-auth/middleware";
import type { NextRequestWithAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { slugFromHost } from "@/lib/sites/origin";

/**
 * Protects the chat home ("/"), conversation pages ("/c/..."), and the
 * authenticated API routes (chat, conversations, upload). Unauthenticated
 * users are redirected to /login (configured via `pages.signIn`).
 *
 * Public routes (/login, /register, /api/auth/*, /api/register, /api/cron, and
 * published Sites under /s/*) and static assets are excluded via the `matcher`
 * below. /api/cron is public here because it is guarded by CRON_SECRET (not a
 * user session) — external schedulers have no NextAuth cookie, so leaving it
 * behind withAuth would 307 them to /login. /s/* serves published Sites to
 * anonymous visitors (the route itself is public by design and enforces
 * link-visibility + a CSP sandbox — see src/app/s/[slug]/route.ts). The Sites
 * MANAGEMENT surface (/sites, /api/sites/*) is NOT excluded and stays protected.
 *
 * SUBDOMAIN SERVING (Phase 0/1): when a request arrives on a SITE host
 * (`<slug>.<SITES_DOMAIN>`, see src/lib/sites/origin.ts), it is a public visit to
 * a published Site on its own origin. We rewrite EVERY path to the internal
 * `/s/<slug>...` serving route and BYPASS auth entirely — a site visitor has no
 * app session and must never be bounced to /login. Rewriting *every* path (not
 * just "/") is what keeps a Site's own `/api/*` data plane on its origin AND
 * stops a site host from reaching the app's public endpoints (/api/auth, …): on
 * a site host those become /s/<slug>/api/auth → the site router's 404.
 *
 * On the APP host, the previously-"excluded" public paths (auth pages, NextAuth,
 * registration, cron, and legacy /s/* Site links) are allowed through WITHOUT
 * auth here in code; everything else goes through `withAuth`. When SITES_DOMAIN
 * is unset, `slugFromHost` always returns null and this reduces to the app host
 * branch (legacy behavior).
 */
const authMiddleware = withAuth({
  pages: {
    signIn: "/login",
  },
});

// APP-host paths that are public (no session required). Matched as an exact path
// or a path prefixed with the entry + "/". Legacy /s/* is handled separately.
const PUBLIC_APP_PATHS = ["/login", "/register", "/api/auth", "/api/register", "/api/cron"];

function isPublicAppPath(pathname: string): boolean {
  return PUBLIC_APP_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  const slug = slugFromHost(req.headers.get("host"));
  if (slug) {
    // SITE host → route the whole request to the published Site on its own origin.
    const url = req.nextUrl.clone();
    const rest = req.nextUrl.pathname === "/" ? "" : req.nextUrl.pathname;
    url.pathname = `/s/${slug}${rest}`;
    return NextResponse.rewrite(url);
  }
  // APP host.
  const { pathname } = req.nextUrl;
  // Legacy path-based Site serving stays public (the route 301s to the subdomain
  // when SITES_DOMAIN is set, else serves the opaque-origin page).
  if (pathname.startsWith("/s/")) return NextResponse.next();
  if (isPublicAppPath(pathname)) return NextResponse.next();
  return authMiddleware(req as NextRequestWithAuth, event);
}

export const config = {
  matcher: [
    /*
     * Run middleware on every path EXCEPT static assets, so it can (a) route all
     * site-host paths to the Site and (b) apply the app-host public/auth split in
     * code above. Excluded: /_next/*, /favicon.ico, /uploads/*, and common static
     * file extensions.
     */
    "/((?!_next/static|_next/image|favicon.ico|uploads|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|woff|woff2|ttf)$).*)",
  ],
};
