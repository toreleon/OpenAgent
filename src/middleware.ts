import { withAuth } from "next-auth/middleware";

/**
 * Protects the chat home ("/"), conversation pages ("/c/..."), and the
 * authenticated API routes (chat, conversations, upload). Unauthenticated
 * users are redirected to /login (configured via `pages.signIn`).
 *
 * Public routes (/login, /register, /api/auth/*, /api/register, /api/cron) and
 * static assets are excluded via the `matcher` below. /api/cron is public here
 * because it is guarded by CRON_SECRET (not a user session) — external schedulers
 * have no NextAuth cookie, so leaving it behind withAuth would 307 them to /login.
 */
export default withAuth({
  pages: {
    signIn: "/login",
  },
});

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     *  - /login, /register            (auth pages)
     *  - /api/auth/*                  (NextAuth)
     *  - /api/register                (public registration)
     *  - /api/cron                    (external trigger, guarded by CRON_SECRET)
     *  - /_next/*                     (Next.js internals)
     *  - /favicon.ico, /uploads/*     (static assets / served files)
     *  - common static file extensions
     */
    "/((?!login|register|api/auth|api/register|api/cron|_next/static|_next/image|favicon.ico|uploads|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|woff|woff2|ttf)$).*)",
  ],
};
