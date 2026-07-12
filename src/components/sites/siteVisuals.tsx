"use client";

import { Globe, Lock, Users, type LucideIcon } from "lucide-react";
import type { SiteStatus, SiteVisibility } from "@/lib/types";

/** Human label for a visibility level. */
export const VISIBILITY_LABEL: Record<SiteVisibility, string> = {
  private: "Private",
  link: "Anyone with the link",
  workspace: "Workspace",
};

/** Short label used on compact badges. */
export const VISIBILITY_SHORT: Record<SiteVisibility, string> = {
  private: "Private",
  link: "Unlisted",
  workspace: "Workspace",
};

export const VISIBILITY_ICON: Record<SiteVisibility, LucideIcon> = {
  private: Lock,
  link: Globe,
  workspace: Users,
};

/** Small pill showing a site's visibility. */
export function VisibilityBadge({ visibility }: { visibility: SiteVisibility }) {
  const Icon = VISIBILITY_ICON[visibility];
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-hover px-2 py-0.5 text-[11px] font-medium text-text-secondary">
      <Icon size={11} />
      {VISIBILITY_SHORT[visibility]}
    </span>
  );
}

const STATUS_STYLE: Record<SiteStatus, { label: string; className: string }> = {
  draft: {
    label: "Draft",
    className: "border-border bg-hover text-text-secondary",
  },
  deployed: {
    label: "Live",
    className: "border-emerald-500/30 bg-emerald-500/15 text-emerald-500",
  },
  "deployed-stale": {
    label: "Undeployed changes",
    className: "border-amber-500/30 bg-amber-500/15 text-amber-500",
  },
};

/** Small pill showing a site's deploy status (draft / live / undeployed-changes). */
export function SiteStatusBadge({ status }: { status: SiteStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${s.className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {s.label}
    </span>
  );
}

/** "Edited Nm/h/d ago" relative label. */
export function editedAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(1, Math.floor(diff / 60_000));
  if (minutes < 60) return `Edited ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Edited ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Edited ${days}d ago`;
}
