"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Globe } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import {
  SITE_VISIBILITIES,
  type SiteDetail,
  type SiteVisibility,
} from "@/lib/types";
import { VISIBILITY_LABEL, VISIBILITY_ICON } from "./siteVisuals";

export interface PublishSiteButtonProps {
  artifactId: string;
  title: string;
  /** Optional extra classes for the trigger button. */
  className?: string;
}

/**
 * "Publish as Site" — creates a first-class Site seeded from this artifact's
 * latest version (POST /api/sites { fromArtifactId }) and opens its management
 * page, where the user reviews and deploys it. Self-contained so the artifact
 * panel only needs to render this one component.
 */
export function PublishSiteButton({ artifactId, title, className }: PublishSiteButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(title);
  const [visibility, setVisibility] = useState<SiteVisibility>("link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromArtifactId: artifactId, name: name.trim() || title, visibility }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Could not publish");
      }
      const detail = (await res.json()) as SiteDetail;
      setOpen(false);
      router.push(`/sites/${detail.id}`);
    } catch (c) {
      setError(c instanceof Error ? c.message : "Could not publish");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "motion-press inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
        }
        title="Publish this artifact as a shareable Site"
      >
        <Globe size={14} /> Publish as Site
      </button>

      <Modal open={open} onClose={() => !busy && setOpen(false)} title="Publish as Site" className="max-w-md">
        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Site name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border bg-hover px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
            />
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-text-secondary">Who can visit</span>
            <div className="space-y-1.5">
              {SITE_VISIBILITIES.map((v) => {
                const Icon = VISIBILITY_ICON[v];
                const active = visibility === v;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVisibility(v)}
                    className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      active ? "border-accent bg-accent/10 text-text-primary" : "border-border text-text-secondary hover:bg-hover"
                    }`}
                  >
                    <Icon size={15} className={active ? "text-accent" : "text-text-secondary"} />
                    {VISIBILITY_LABEL[v]}
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-xs text-text-secondary">
            This creates a draft Site — you’ll review and deploy it to its public URL on the next screen.
          </p>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="rounded-lg px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={publish}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              <Globe size={14} /> {busy ? "Publishing…" : "Create Site"}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export default PublishSiteButton;
