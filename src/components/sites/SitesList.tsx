"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Globe, Search } from "lucide-react";
import type { SiteSummary } from "@/lib/types";
import { SitePreviewFrame } from "./SitePreviewFrame";
import { SiteStatusBadge, VisibilityBadge, editedAgo } from "./siteVisuals";

/** One site card in the dashboard grid. */
function SiteCard({ site }: { site: SiteSummary }) {
  const router = useRouter();
  const open = () => router.push(`/sites/${site.id}`);
  const isLive = site.status !== "draft";
  const canVisit = isLive && site.visibility === "link";

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="group cursor-pointer overflow-hidden rounded-xl border border-border bg-sidebar text-left transition-colors hover:border-text-secondary/60 hover:bg-hover focus:outline-none focus:ring-2 focus:ring-accent"
    >
      <div className="relative h-36 overflow-hidden border-b border-border bg-white">
        <div className="pointer-events-none h-full w-full">
          <SitePreviewFrame type={site.previewType} content={site.previewContent} title={site.name} />
        </div>
        <span className="pointer-events-none absolute left-2 top-2">
          <SiteStatusBadge status={site.status} />
        </span>
      </div>
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-sm font-medium text-text-primary">{site.name}</h2>
          <VisibilityBadge visibility={site.visibility} />
        </div>
        {canVisit ? (
          <a
            href={site.publicPath}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-1 inline-flex items-center gap-1 truncate text-xs text-accent hover:underline"
          >
            <ExternalLink size={11} className="shrink-0" />
            <span className="truncate">{site.publicPath}</span>
          </a>
        ) : (
          <p className="mt-1 truncate text-xs text-text-secondary">
            {site.status === "draft" ? "Not published yet" : "Not shared publicly"}
          </p>
        )}
        <p className="mt-3 text-xs text-text-secondary">{editedAgo(site.updatedAt)}</p>
      </div>
    </article>
  );
}

/** Full-page dashboard of the user's Sites (Sites-style "Sites list"). */
export function SitesList() {
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/sites", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load sites");
        return (await res.json()) as SiteSummary[];
      })
      .then((items) => {
        if (!cancelled) setSites(items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load sites");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sites;
    return sites.filter((s) => `${s.name} ${s.slug}`.toLowerCase().includes(q));
  }, [sites, query]);

  return (
    <main className="flex-1 overflow-y-auto bg-main">
      <div className="mx-auto w-full max-w-5xl px-6 py-10 sm:px-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-text-primary">Sites</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Publishable web pages you built in chat — review, deploy, and share them.
            </p>
          </div>
        </div>

        <div className="relative mt-5">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sites…"
            className="w-full rounded-lg border border-border bg-hover py-2.5 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary outline-none transition-colors focus:border-accent"
          />
        </div>

        {loading ? (
          <p className="py-12 text-sm text-text-secondary">Loading sites…</p>
        ) : error ? (
          <p className="py-12 text-sm text-danger">{error}</p>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-center">
            <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-hover text-text-secondary">
              <Globe size={22} />
            </span>
            <h2 className="font-medium text-text-primary">No sites yet</h2>
            <p className="mt-1 max-w-sm text-sm text-text-secondary">
              Ask the assistant to build a website or web app, or publish an artifact as a
              Site. Your sites will show up here.
            </p>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((site) => (
              <SiteCard key={site.id} site={site} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

export default SitesList;
