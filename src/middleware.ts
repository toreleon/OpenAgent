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
 * SUBDOMAIN SERVING (Phase 0): when a request arrives on a SITE host
 * (`<slug>.<SITES_DOMAIN>`, see src/lib/sites/origin.ts), it is a public visit to
 * a published Site on its own origin. We rewrite it to the internal `/s/<slug>`
 * serving route and BYPASS auth entirely — a site visitor has no app session and
 * must never be bounced to /login. All other hosts fall through to `withAuth`.
 * When SITES_DOMAIN is unset, `slugFromHost` always returns null and behavior is
 * unchanged (legacy path-based serving).
 */
const authMiddleware = withAuth({
  pages: {
    signIn: "/login",
  },
});

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  const slug = slugFromHost(req.headers.get("host"));
  if (slug) {
    const url = req.nextUrl.clone();
    const rest = req.nextUrl.pathname === "/" ? "" : req.nextUrl.pathname;
    url.pathname = `/s/${slug}${rest}`;
    return NextResponse.rewrite(url);
  }
  return authMiddleware(req as NextRequestWithAuth, event);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     *  - /login, /register            (auth pages)
     *  - /api/auth/*                  (NextAuth)
     *  - /api/register                (public registration)
     *  - /api/cron                    (external trigger, guarded by CRON_SECRET)
     *  - /s/*                          (public published Sites; CSP-sandboxed)
     *  - /_next/*                     (Next.js internals)
     *  - /favicon.ico, /uploads/*     (static assets / served files)
     *  - common static file extensions
     *
     * NOTE: the `s/` alternative uses a trailing slash so it matches only the
     * /s/<slug> namespace, never app routes that merely start with "s".
     */
    "/((?!login|register|api/auth|api/register|api/cron|s/|_next/static|_next/image|favicon.ico|uploads|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|woff|woff2|ttf)$).*)",
  ],
};
