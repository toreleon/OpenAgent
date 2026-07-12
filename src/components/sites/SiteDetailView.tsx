"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  MessageSquare,
  Rocket,
  Save,
  Trash2,
} from "lucide-react";
import {
  SITE_VISIBILITIES,
  type SiteDetail,
  type SiteVisibility,
} from "@/lib/types";
import { SitePreviewFrame } from "./SitePreviewFrame";
import { SiteStatusBadge, VISIBILITY_LABEL, VISIBILITY_ICON } from "./siteVisuals";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.max(1, Math.floor(diff / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function SiteDetailView({ siteId }: { siteId: string }) {
  const router = useRouter();
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/sites/${siteId}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "Site not found" : "Could not load site");
        return (await res.json()) as SiteDetail;
      })
      .then((detail) => {
        if (cancelled) return;
        setSite(detail);
        setDraft(detail.draftContent);
      })
      .catch((c: unknown) => !cancelled && setError(c instanceof Error ? c.message : "Error"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  const mutate = useCallback(
    async (url: string, init: RequestInit, label: string): Promise<SiteDetail | null> => {
      setBusy(label);
      setError(null);
      try {
        const res = await fetch(url, init);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || "Request failed");
        }
        const detail = (await res.json()) as SiteDetail;
        setSite(detail);
        if (!editing) setDraft(detail.draftContent);
        return detail;
      } catch (c) {
        setError(c instanceof Error ? c.message : "Request failed");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [editing],
  );

  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const saveVersion = () => mutate(`/api/sites/${siteId}/versions`, { method: "POST" }, "save");
  const deployDraft = () => mutate(`/api/sites/${siteId}/deploy`, json({}), "deploy");
  const deployVersion = (versionId: string) =>
    mutate(`/api/sites/${siteId}/deploy`, json({ versionId }), `deploy-${versionId}`);
  const unpublish = () => mutate(`/api/sites/${siteId}/deploy`, { method: "DELETE" }, "unpublish");
  const setVisibility = (visibility: SiteVisibility) =>
    mutate(`/api/sites/${siteId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visibility }) }, "visibility");
  const saveDraft = async () => {
    const detail = await mutate(
      `/api/sites/${siteId}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftContent: draft }) },
      "draft",
    );
    if (detail) setEditing(false);
  };

  const del = async () => {
    setBusy("delete");
    const res = await fetch(`/api/sites/${siteId}`, { method: "DELETE" });
    if (res.ok) router.push("/sites");
    else {
      setError("Could not delete the site");
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="flex h-screen items-center justify-center bg-main text-sm text-text-secondary">Loading…</div>;
  }
  if (!site) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-main">
        <p className="text-sm text-danger">{error ?? "Site not found"}</p>
        <button onClick={() => router.push("/sites")} className="text-sm text-accent hover:underline">
          Back to Sites
        </button>
      </div>
    );
  }

  const publicUrl =
    typeof window !== "undefined" ? `${window.location.origin}${site.publicPath}` : site.publicPath;
  const canVisit = site.status !== "draft" && site.visibility === "link";

  const copyUrl = () => {
    void navigator.clipboard.writeText(publicUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <main className="flex-1 overflow-y-auto bg-main">
      <div className="mx-auto w-full max-w-4xl px-6 py-8 sm:px-10">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => router.push("/sites")}
            className="inline-flex items-center gap-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary"
          >
            <ArrowLeft size={16} /> Sites
          </button>
          <span className="text-text-secondary">/</span>
          <h1 className="text-xl font-semibold text-text-primary">{site.name}</h1>
          <SiteStatusBadge status={site.status} />
          <div className="ml-auto flex items-center gap-2">
            {site.createdInConversationId && (
              <button
                onClick={() => router.push(`/c/${site.createdInConversationId}`)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-hover"
              >
                <MessageSquare size={15} /> Refine in chat
              </button>
            )}
            <button
              onClick={saveVersion}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-hover disabled:opacity-50"
            >
              <Save size={15} /> {busy === "save" ? "Saving…" : "Save version"}
            </button>
            <button
              onClick={deployDraft}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Rocket size={15} /> {busy === "deploy" ? "Deploying…" : "Deploy"}
            </button>
          </div>
        </div>

        {error && <p className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        {site.status === "deployed-stale" && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-500">
            <span>You have undeployed changes — the live page still shows the last deployed version.</span>
            <button onClick={deployDraft} disabled={busy !== null} className="shrink-0 font-medium hover:underline disabled:opacity-50">
              Deploy now
            </button>
          </div>
        )}

        {/* Preview */}
        <div className="mt-5 h-[460px] overflow-hidden rounded-xl border border-border bg-white">
          <SitePreviewFrame type={site.draftType} content={site.draftContent} title={site.name} />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-text-secondary">
          <span>Preview of the current draft ({site.draftType})</span>
          <button onClick={() => setEditing((v) => !v)} className="hover:text-text-primary">
            {editing ? "Close editor" : "Edit content"}
          </button>
        </div>

        {editing && (
          <div className="mt-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="h-64 w-full rounded-lg border border-border bg-code-bg p-3 font-mono text-xs text-text-primary outline-none focus:border-accent"
            />
            <div className="mt-2 flex justify-end gap-2">
              <button onClick={() => { setDraft(site.draftContent); setEditing(false); }} className="rounded-lg px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary">
                Cancel
              </button>
              <button onClick={saveDraft} disabled={busy !== null} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
                {busy === "draft" ? "Saving…" : "Save draft"}
              </button>
            </div>
          </div>
        )}

        {/* Share */}
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-text-primary">Share</h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Sharing grants visit access only — visitors can never edit your site.
          </p>
          <div className="mt-3 space-y-2">
            {SITE_VISIBILITIES.map((v) => {
              const Icon = VISIBILITY_ICON[v];
              const active = site.visibility === v;
              return (
                <button
                  key={v}
                  onClick={() => !active && setVisibility(v)}
                  disabled={busy !== null}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-60 ${
                    active ? "border-accent bg-accent/10" : "border-border hover:bg-hover"
                  }`}
                >
                  <Icon size={16} className={active ? "text-accent" : "text-text-secondary"} />
                  <span className="flex-1">
                    <span className="block text-sm text-text-primary">{VISIBILITY_LABEL[v]}</span>
                    {v === "workspace" && (
                      <span className="block text-xs text-text-secondary">
                        Signed-in members (public serving to other users coming soon)
                      </span>
                    )}
                    {v === "link" && (
                      <span className="block text-xs text-text-secondary">Anyone with the URL can open it — no sign-in</span>
                    )}
                    {v === "private" && (
                      <span className="block text-xs text-text-secondary">Only you can preview it here</span>
                    )}
                  </span>
                  {active && <Check size={16} className="text-accent" />}
                </button>
              );
            })}
          </div>

          {canVisit && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-hover px-3 py-2">
              <span className="flex-1 truncate font-mono text-xs text-text-primary">{publicUrl}</span>
              <button onClick={copyUrl} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-main hover:text-text-primary">
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
              </button>
              <a href={site.publicPath} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent hover:bg-main">
                <ExternalLink size={13} /> Open
              </a>
            </div>
          )}
          {site.status !== "draft" && (
            <button onClick={unpublish} disabled={busy !== null} className="mt-3 text-xs text-text-secondary hover:text-danger disabled:opacity-50">
              {busy === "unpublish" ? "Taking offline…" : "Take offline"}
            </button>
          )}
        </section>

        {/* Versions */}
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-text-primary">Versions</h2>
          {site.versions.length === 0 ? (
            <p className="mt-2 text-xs text-text-secondary">No versions saved yet. Click “Save version” to snapshot the current draft.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border">
              {site.versions.map((v) => (
                <li key={v.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="font-mono text-xs text-text-secondary">v{v.version}</span>
                  <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">{v.commit}</code>
                  <span className="text-xs text-text-secondary">{timeAgo(v.createdAt)}</span>
                  {v.isLive && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-current" /> Live
                    </span>
                  )}
                  {!v.isLive && (
                    <button
                      onClick={() => deployVersion(v.id)}
                      disabled={busy !== null}
                      className="ml-auto text-xs text-accent hover:underline disabled:opacity-50"
                    >
                      {busy === `deploy-${v.id}` ? "Deploying…" : "Deploy this version"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Danger */}
        <section className="mt-8 border-t border-border pt-5">
          {confirmDelete ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-text-primary">Delete this site permanently?</span>
              <button onClick={del} disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
                <Trash2 size={14} /> {busy === "delete" ? "Deleting…" : "Delete"}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-sm text-text-secondary hover:text-text-primary">
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-danger">
              <Trash2 size={14} /> Delete site
            </button>
          )}
        </section>
      </div>
    </main>
  );
}

export default SiteDetailView;
