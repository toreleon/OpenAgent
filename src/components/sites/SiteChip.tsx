"use client";

import { useRouter } from "next/navigation";
import { ExternalLink, Globe, Rocket } from "lucide-react";
import type { SiteCommand, SiteRef } from "@/lib/types";

const COMMAND_VERB: Record<SiteCommand, string> = {
  create: "Built site",
  update: "Updated site",
  deploy: "Published site",
};

export interface SiteChipProps {
  siteRef: SiteRef;
}

/**
 * Inline, clickable card rendered inside an assistant message when it built or
 * deployed a Site. Opens the Site's management page; when the site is live and
 * link-shared it also offers a direct "Open" link to the public page.
 */
export function SiteChip({ siteRef }: SiteChipProps) {
  const router = useRouter();
  const verb = siteRef.command === "deploy" ? "Published site" : COMMAND_VERB[siteRef.command];

  return (
    <div className="animate-scale-in origin-left flex w-full max-w-sm items-center gap-3 rounded-xl border border-border bg-sidebar/60 px-3 py-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/20 text-accent">
        {siteRef.deployed ? <Rocket size={18} /> : <Globe size={18} />}
      </span>
      <button
        type="button"
        onClick={() => router.push(`/sites/${siteRef.siteId}`)}
        className="motion-press flex min-w-0 flex-1 flex-col text-left"
      >
        <span className="truncate text-sm font-medium text-text-primary">{siteRef.name}</span>
        <span className="truncate text-[11px] text-text-secondary">
          {verb} · {siteRef.deployed ? "Live" : "Draft"} · Manage in Sites
        </span>
      </button>
      {siteRef.deployed && (
        <a
          href={siteRef.publicPath}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-accent hover:bg-hover"
        >
          <ExternalLink size={13} /> Open
        </a>
      )}
    </div>
  );
}

export default SiteChip;
