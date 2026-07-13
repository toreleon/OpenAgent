"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, History, Loader2, X } from "lucide-react";
import { useChatStore } from "@/store/chat";
import { cn } from "@/components/ui/cn";
import type { RewindScope, RewindResult } from "@/lib/workspace/types";

interface Preview {
  overwrite: string[];
  delete: string[];
  untrackedLeftAlone: string[];
  hasSnapshot: boolean;
}

const SCOPES: { value: RewindScope; label: string; hint: string }[] = [
  {
    value: "both",
    label: "Restore code + conversation",
    hint: "Roll back the files AND the chat to this point.",
  },
  {
    value: "conversation",
    label: "Restore conversation only",
    hint: "Go back in the chat; leave the current files untouched.",
  },
  {
    value: "code",
    label: "Restore code only",
    hint: "Roll back the files; keep the current conversation.",
  },
];

/**
 * Confirmation modal for "rewind code state" (Claude-Code style). Reads the open
 * target from the store, previews the affected files, lets the user pick a scope
 * (code / conversation / both), warns about data loss + non-snapshotted shell
 * files, and on confirm performs the restore. Rendered once at the app level.
 */
export function RewindDialog() {
  const targetId = useChatStore((s) => s.rewindTargetId);
  const conversationId = useChatStore((s) => s.currentId);
  const closeRewind = useChatStore((s) => s.closeRewind);
  const rewindTo = useChatStore((s) => s.rewindTo);

  const [scope, setScope] = useState<RewindScope>("both");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RewindResult | null>(null);

  // Reset + fetch the preview whenever a new target opens.
  useEffect(() => {
    if (!targetId || !conversationId) return;
    setScope("both");
    setResult(null);
    setPreview(null);
    setLoadingPreview(true);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/conversations/${conversationId}/workspace/restore/preview?messageId=${encodeURIComponent(
            targetId,
          )}`,
          { cache: "no-store" },
        );
        if (!cancelled && res.ok) setPreview((await res.json()) as Preview);
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetId, conversationId]);

  if (!targetId) return null;

  const touchesCode = scope === "both" || scope === "code";

  const onConfirm = async () => {
    setSubmitting(true);
    const r = await rewindTo(targetId, scope);
    setSubmitting(false);
    if (r && (r.degraded || r.error || touchesCode)) {
      setResult(r); // show a summary/warning before closing
    } else {
      closeRewind();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-main text-text-primary shadow-2xl animate-scale-in origin-center">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <History size={16} className="text-text-secondary" />
          <span className="text-sm font-semibold">Rewind code state</span>
          <button
            type="button"
            onClick={closeRewind}
            aria-label="Close"
            className="ml-auto rounded-md p-1 text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>

        {result ? (
          <ResultView result={result} onClose={closeRewind} />
        ) : (
          <div className="px-4 py-3">
            <p className="mb-3 text-xs text-text-secondary">
              Restore this conversation&apos;s workspace to how it was at the
              selected turn. This overwrites and deletes files.
            </p>

            {/* Scope radios */}
            <div className="flex flex-col gap-1.5">
              {SCOPES.map((s) => (
                <label
                  key={s.value}
                  className={cn(
                    "flex cursor-pointer gap-2 rounded-lg border px-3 py-2 transition-colors",
                    scope === s.value
                      ? "border-accent bg-accent/10"
                      : "border-border hover:bg-hover",
                  )}
                >
                  <input
                    type="radio"
                    name="rewind-scope"
                    checked={scope === s.value}
                    onChange={() => setScope(s.value)}
                    className="mt-0.5 accent-accent"
                  />
                  <span className="flex flex-col">
                    <span className="text-xs font-medium">{s.label}</span>
                    <span className="text-[11px] text-text-secondary">
                      {s.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            {/* Preview + caveats (only relevant when code is restored) */}
            {touchesCode && (
              <div className="mt-3 rounded-lg border border-border bg-hover/30 px-3 py-2 text-xs">
                {loadingPreview ? (
                  <span className="text-text-secondary">Computing changes…</span>
                ) : preview ? (
                  <div className="flex flex-col gap-1">
                    <span>
                      <span className="font-medium text-green-500">
                        {preview.overwrite.length}
                      </span>{" "}
                      file{preview.overwrite.length === 1 ? "" : "s"} restored ·{" "}
                      <span className="font-medium text-red-500">
                        {preview.delete.length}
                      </span>{" "}
                      removed
                    </span>
                    {!preview.hasSnapshot && (
                      <span className="flex items-start gap-1 text-amber-500">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                        No snapshot for this turn — a best-effort restore from the
                        edit log; run_shell-created files won&apos;t be rolled
                        back.
                      </span>
                    )}
                    {preview.hasSnapshot &&
                      preview.untrackedLeftAlone.length > 0 && (
                        <span className="text-text-secondary">
                          Installed deps / build output aren&apos;t rolled back.
                        </span>
                      )}
                  </div>
                ) : (
                  <span className="text-text-secondary">
                    Couldn&apos;t compute a preview.
                  </span>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeRewind}
                className="rounded-lg px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={submitting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {submitting && <Loader2 size={13} className="animate-spin" />}
                Rewind
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultView({
  result,
  onClose,
}: {
  result: RewindResult;
  onClose: () => void;
}) {
  return (
    <div className="px-4 py-4 text-xs">
      {result.error ? (
        <p className="flex items-start gap-1.5 text-red-500">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {result.error}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="text-text-primary">
            Rewound the workspace —{" "}
            <span className="text-green-500">{result.restored}</span> file
            {result.restored === 1 ? "" : "s"} restored,{" "}
            <span className="text-red-500">{result.deleted}</span> removed.
          </p>
          {result.degraded && (
            <p className="flex items-start gap-1 text-amber-500">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              Degraded restore (no snapshot): run_shell-created files were not
              rolled back.
            </p>
          )}
          {result.skipped.length > 0 && (
            <p className="text-text-secondary">
              {result.skipped.length} path
              {result.skipped.length === 1 ? "" : "s"} skipped.
            </p>
          )}
          <p className="text-text-secondary">
            This rewind was itself snapshotted, so it can be undone.
          </p>
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
        >
          Done
        </button>
      </div>
    </div>
  );
}

export default RewindDialog;
