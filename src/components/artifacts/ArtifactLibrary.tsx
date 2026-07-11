"use client";

import { useEffect, useMemo, useState } from "react";
import { Boxes, FileText, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ArtifactLibraryItem, ArtifactType } from "@/lib/types";

const FILTER_OPTIONS: Array<{ value: "all" | ArtifactType; label: string }> = [
  { value: "all", label: "All artifacts" },
  { value: "react", label: "React" },
  { value: "html", label: "HTML" },
  { value: "image", label: "Image" },
  { value: "markdown", label: "Markdown" },
  { value: "code", label: "Code" },
  { value: "svg", label: "SVG" },
  { value: "mermaid", label: "Mermaid" },
];

function previewFor(artifact: ArtifactLibraryItem): string {
  const content = artifact.versions.at(-1)?.content ?? "";
  return content.replace(/\s+/g, " ").trim() || "No preview available";
}

function editedAt(iso: string): string {
  const difference = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(1, Math.floor(difference / 60_000));
  if (minutes < 60) return `Edited ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Edited ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Edited ${days}d ago`;
}

/** Full-page, Claude-style gallery for artifacts created in every chat. */
export function ArtifactLibrary() {
  const router = useRouter();
  const [artifacts, setArtifacts] = useState<ArtifactLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | ArtifactType>("all");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/artifacts", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load artifacts");
        return (await res.json()) as ArtifactLibraryItem[];
      })
      .then((items) => {
        if (!cancelled) setArtifacts(items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not load artifacts");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const visibleArtifacts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return artifacts.filter((artifact) => {
      const matchesType = type === "all" || artifact.type === type;
      const searchable = `${artifact.title} ${artifact.identifier} ${artifact.conversationTitle}`.toLowerCase();
      return matchesType && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
  }, [artifacts, query, type]);

  return (
    <main className="flex-1 overflow-y-auto bg-main">
      <div className="mx-auto w-full max-w-5xl px-6 py-10 sm:px-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-3xl font-semibold tracking-tight text-text-primary">Artifacts</h1>
          <label className="sr-only" htmlFor="artifact-type">Filter artifacts</label>
          <select
            id="artifact-type"
            value={type}
            onChange={(event) => setType(event.target.value as "all" | ArtifactType)}
            className="rounded-lg border border-border bg-hover px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent"
          >
            {FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="relative mt-5">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search artifacts…"
            className="w-full rounded-lg border border-border bg-hover py-2.5 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary outline-none transition-colors focus:border-accent"
          />
        </div>

        {loading ? (
          <p className="py-12 text-sm text-text-secondary">Loading artifacts…</p>
        ) : error ? (
          <p className="py-12 text-sm text-red-300">{error}</p>
        ) : visibleArtifacts.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-center">
            <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-hover text-text-secondary">
              <Boxes size={22} />
            </span>
            <h2 className="font-medium text-text-primary">No artifacts found</h2>
            <p className="mt-1 max-w-sm text-sm text-text-secondary">
              Artifacts you create in chats will appear here.
            </p>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visibleArtifacts.map((artifact) => {
              const latestVersion = artifact.versions.at(-1)?.version ?? 1;
              return (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => router.push(`/c/${artifact.conversationId}?artifact=${artifact.id}`)}
                  className="group overflow-hidden rounded-xl border border-border bg-sidebar text-left transition-colors hover:border-text-secondary/60 hover:bg-hover focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  <div className="h-36 overflow-hidden border-b border-border bg-[#171717] p-3">
                    <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                      <FileText size={12} /> {artifact.type}
                    </div>
                    <p className="max-h-24 overflow-hidden whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">
                      {previewFor(artifact)}
                    </p>
                  </div>
                  <div className="p-3">
                    <h2 className="h-10 overflow-hidden text-sm font-medium leading-5 text-text-primary">
                      {artifact.title}
                    </h2>
                    <p className="mt-1 truncate text-xs text-text-secondary">
                      {artifact.conversationTitle} · v{latestVersion}
                    </p>
                    <p className="mt-3 text-xs text-text-secondary">{editedAt(artifact.updatedAt)}</p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

export default ArtifactLibrary;
