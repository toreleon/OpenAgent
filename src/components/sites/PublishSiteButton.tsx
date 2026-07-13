"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Globe } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { SiteDetail } from "@/lib/types";

export interface PublishSiteButtonProps {
  artifactId: string;
  title: string;
  /** Optional extra classes for the trigger button. */
  className?: string;
}

/**
 * "Publish" — the unified-Artifacts publish action. One click makes this artifact
 * a live, shareable page at a public URL (POST /api/artifacts/publish create-or-
 * reuses its shadow Site, makes it link-visible, and deploys) and shows the link
 * IN PLACE — matching Claude's "same window, now with a live link", instead of
 * navigating away to a separate Sites dashboard.
 */
export function PublishSiteButton({ artifactId, title, className }: PublishSiteButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<SiteDetail | null>(null);
  const { copied, copy } = useCopyToClipboard();

  const publicUrl =
    published && typeof window !== "undefined"
      ? `${window.location.origin}${published.publicPath}`
      : "";

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/artifacts/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Could not publish");
      }
      setPublished((await res.json()) as SiteDetail);
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
        title="Publish this artifact to a shareable public link"
      >
        <Globe size={14} /> Publish
      </button>

      <Modal open={open} onClose={() => !busy && setOpen(false)} title="Publish artifact" className="max-w-md">
        <div className="space-y-4 px-5 py-4">
          {published ? (
            <>
              <p className="text-sm text-text-primary">
                <span className="font-medium">{title}</span> is live. Anyone with this link can open it.
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-hover px-3 py-2">
                <Globe size={15} className="shrink-0 text-accent" />
                <a
                  href={publicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-sm text-text-primary hover:underline"
                >
                  {publicUrl}
                </a>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => copy(publicUrl)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-hover hover:text-text-primary"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Copied" : "Copy link"}
                </button>
                <a
                  href={publicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
                >
                  <ExternalLink size={14} /> Open
                </a>
              </div>
              <p className="text-xs text-text-secondary">
                Re-publishing updates this same link to the latest version.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-text-secondary">
                Publishing creates a public link to <span className="font-medium text-text-primary">{title}</span> that
                anyone with the URL can open. Don’t publish anything with secrets or private data.
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
                  <Globe size={14} /> {busy ? "Publishing…" : "Publish"}
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}

export default PublishSiteButton;
