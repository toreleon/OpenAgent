/**
 * The gate for the public Sites DATA plane (/s/<slug>/api/*).
 *
 * It MUST match the page-serving gate in loadPublicSite() exactly, plus require
 * the backend master switch: a Site's API is reachable only when the Site is
 * `link`-visible, has a live deployment, AND has its backend enabled. Every
 * other case resolves to null and the router returns a uniform 404 — so a
 * private / undeployed / backend-off Site never exposes a writable, readable API
 * and its existence never leaks. Unpublishing (nulling the live pointer) or
 * flipping the Site to private closes the data plane in the very same request.
 *
 * Kept in its own file (not appended to src/lib/sites.ts) so the mini-app feature
 * stays self-contained while the primary Sites module is concurrently edited.
 */
import prisma from "@/lib/db";
import { siteStore } from "@/lib/sites/data-db";

/** Resolve a slug to its siteId iff the public data plane may serve it. */
export async function resolveBackendSite(slug: string): Promise<{ siteId: string } | null> {
  const site = await prisma.site.findUnique({
    where: { slug },
    select: { id: true, visibility: true, liveVersionId: true },
  });
  if (!site) return null;
  // Same predicate as loadPublicSite: only exact `link` visibility + a live
  // deployment serve publicly. (loadPublicSite coerces unknown → private, which
  // this exact-match check mirrors for the pass case.)
  if (site.visibility !== "link" || site.liveVersionId == null) return null;
  if (!(await siteStore.isEnabled(site.id))) return null;
  return { siteId: site.id };
}
