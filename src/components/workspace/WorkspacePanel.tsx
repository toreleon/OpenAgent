"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  FileDiff,
  FolderGit2,
  ListTree,
  MessagesSquare,
  RefreshCw,
  SendHorizonal,
  Sparkles,
  X,
} from "lucide-react";
import { useChatStore } from "@/store/chat";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/components/ui/cn";
import { ChangedFilesList } from "./ChangedFilesList";
import { DiffFileCard } from "./DiffFileCard";
import { FileTree } from "./FileTree";
import { highlightLine } from "./diffHighlight";
import { AddDelCounts } from "./bits";
import type { DiffCommentApi } from "./DiffView";
import type {
  DraftComment,
  WorkspaceFileContent,
  WorkspaceFileDiff,
  WorkspaceScope,
  WorkspaceStatus,
} from "@/lib/workspace/types";

type Mode = "changes" | "files";

/**
 * The coding-workspace review pane (Claude-Code-Desktop style). Reads the open
 * pane's scope from the chat store; fetches the changed-files list + diffs (and
 * the on-disk tree for browse mode) for the current conversation; renders a
 * changed-files list on the left and stacked unified-diff cards on the right.
 * Live-refreshes as the agent edits.
 */
export function WorkspacePanel() {
  const conversationId = useChatStore((s) => s.currentId);
  const view = useChatStore((s) => s.workspaceView);
  const closeWorkspace = useChatStore((s) => s.closeWorkspace);
  const setWorkspaceScope = useChatStore((s) => s.setWorkspaceScope);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sendMessage = useChatStore((s) => s.sendMessage);

  const scope: WorkspaceScope = view?.scope ?? "all";
  const messageId = view?.messageId ?? undefined;

  // Draft inline review comments (Claude-Code-style), submitted together to the
  // agent as a follow-up turn.
  const [comments, setComments] = useState<DraftComment[]>([]);

  const [mode, setMode] = useState<Mode>("changes");
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [diffs, setDiffs] = useState<WorkspaceFileDiff[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Files default to EXPANDED; we track only the ones the user explicitly
  // collapsed, so live-refresh polls can never wipe the user's state and newly
  // changed files appear open automatically.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [file, setFile] = useState<WorkspaceFileContent | null>(null);
  const [loading, setLoading] = useState(false);

  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Monotonic request id: only the latest load() applies its results, so a slow
  // response can't clobber a newer scope's data.
  const reqIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!conversationId) return;
    const myReq = ++reqIdRef.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ scope });
      if (scope === "lastTurn" && messageId) qs.set("messageId", messageId);
      const base = `/api/conversations/${conversationId}/workspace`;
      const [statusRes, diffRes] = await Promise.all([
        fetch(`${base}?${qs}`, { cache: "no-store" }),
        fetch(`${base}/diff?${qs}`, { cache: "no-store" }),
      ]);
      const statusJson = statusRes.ok
        ? ((await statusRes.json()) as WorkspaceStatus)
        : null;
      const diffJson = diffRes.ok
        ? ((await diffRes.json()) as { diffs: WorkspaceFileDiff[] })
        : null;
      // Drop stale responses (a newer load started while we awaited).
      if (reqIdRef.current !== myReq) return;
      if (statusJson) setStatus(statusJson);
      if (diffJson) {
        const d = diffJson.diffs;
        setDiffs(d);
        setSelectedPath((prev) =>
          prev && d.some((f) => f.path === prev) ? prev : (d[0]?.path ?? null),
        );
      }
    } finally {
      if (reqIdRef.current === myReq) setLoading(false);
    }
  }, [conversationId, scope, messageId]);

  // Start every file expanded again + drop draft comments when the
  // scope/conversation/turn changes.
  useEffect(() => {
    setCollapsed(new Set());
    setComments([]);
  }, [conversationId, scope, messageId]);

  // Load on open + scope change (via `load` identity) and on streaming flips
  // (so diffs refresh when a turn finishes); poll every 2s while streaming.
  useEffect(() => {
    void load();
    if (!isStreaming) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load, isStreaming]);

  // Fetch the selected file's content when browsing.
  useEffect(() => {
    if (mode !== "files" || !conversationId || !selectedPath) {
      setFile(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await fetch(
        `/api/conversations/${conversationId}/workspace/file?path=${encodeURIComponent(
          selectedPath,
        )}`,
        { cache: "no-store" },
      );
      if (!cancelled && res.ok)
        setFile((await res.json()) as WorkspaceFileContent);
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, conversationId, selectedPath]);

  const totals = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const c of status?.changes ?? []) {
      adds += c.adds;
      dels += c.dels;
    }
    return { adds, dels, files: status?.changes.length ?? 0 };
  }, [status]);

  const selectChangedFile = (path: string) => {
    setSelectedPath(path);
    setMode("changes");
    // Ensure the selected file is expanded.
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    // Scroll its card into view next frame (after any expand render).
    requestAnimationFrame(() => {
      cardRefs.current.get(path)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  };

  const toggleCard = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const canLastTurn = !!status?.lastTurnMessageId || scope === "lastTurn";

  // ---- inline review comments ----
  const commentApiFor = useCallback(
    (path: string): DiffCommentApi => ({
      byId: new Map(
        comments.filter((c) => c.path === path).map((c) => [c.id, c]),
      ),
      add: (anchor) =>
        setComments((prev) =>
          prev.some((c) => c.id === anchor.id)
            ? prev
            : [...prev, { ...anchor, path, text: "" }],
        ),
      update: (id, text) =>
        setComments((prev) =>
          prev.map((c) => (c.id === id ? { ...c, text } : c)),
        ),
      remove: (id) => setComments((prev) => prev.filter((c) => c.id !== id)),
    }),
    [comments],
  );

  const readyComments = comments.filter((c) => c.text.trim().length > 0);

  const submitComments = useCallback(() => {
    const ready = comments.filter((c) => c.text.trim().length > 0);
    if (ready.length === 0 || isStreaming) return;
    const byFile = new Map<string, DraftComment[]>();
    for (const c of ready) {
      const arr = byFile.get(c.path) ?? [];
      arr.push(c);
      byFile.set(c.path, arr);
    }
    let prompt =
      "Please revise your changes in the workspace to address these code-review comments:\n";
    for (const [path, cs] of byFile) {
      prompt += `\n**${path}**\n`;
      for (const c of cs) {
        prompt += `- ${c.lineLabel} \`${c.lineContent.trim()}\` — ${c.text.trim()}\n`;
      }
    }
    setComments([]);
    void sendMessage(prompt, []);
    // Show cumulative changes so the agent's revision is visible as it streams
    // (the pinned last-turn scope wouldn't include the new turn).
    setWorkspaceScope("all");
  }, [comments, isStreaming, sendMessage, setWorkspaceScope]);

  const reviewCode = useCallback(() => {
    if (isStreaming) return;
    const scopeText =
      scope === "lastTurn"
        ? "your most recent turn's changes"
        : "all your changes so far";
    void sendMessage(
      `Please review ${scopeText} in this workspace. Re-read the files you changed and critically check for correctness bugs, security issues, and missing edge cases. For each issue, cite the file and line and suggest a fix; if the code is solid, say so briefly. Then apply any high-confidence fixes.`,
      [],
    );
  }, [isStreaming, scope, sendMessage]);

  // ⌘/Ctrl+Enter submits the batch of comments.
  useEffect(() => {
    if (readyComments.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        submitComments();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readyComments.length, submitComments]);

  return (
    <div className="flex h-full w-full flex-col bg-main text-text-primary animate-slide-in-right">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <FolderGit2 size={16} className="shrink-0 text-text-secondary" />
        <span className="text-sm font-medium">Workspace</span>
        {totals.files > 0 && (
          <span className="flex items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5 text-[11px]">
            <span className="text-text-secondary">{totals.files} files</span>
            <AddDelCounts adds={totals.adds} dels={totals.dels} />
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Refresh" size="sm" onClick={() => void load()}>
            <RefreshCw size={14} className={cn(loading && "animate-spin")} />
          </IconButton>
          <IconButton label="Close workspace" size="sm" onClick={closeWorkspace}>
            <X size={16} />
          </IconButton>
        </div>
      </div>

      {/* Toolbar: scope + mode toggles + expand/collapse */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <Segmented>
          <Seg
            active={scope === "all"}
            onClick={() => setWorkspaceScope("all")}
          >
            All changes
          </Seg>
          <Seg
            active={scope === "lastTurn"}
            disabled={!canLastTurn}
            onClick={() =>
              setWorkspaceScope("lastTurn", status?.lastTurnMessageId ?? undefined)
            }
          >
            Last turn
          </Seg>
        </Segmented>

        <Segmented>
          <Seg active={mode === "changes"} onClick={() => setMode("changes")}>
            <FileDiff size={12} /> Changes
          </Seg>
          <Seg active={mode === "files"} onClick={() => setMode("files")}>
            <ListTree size={12} /> Files
          </Seg>
        </Segmented>

        {mode === "changes" && diffs.length > 0 && (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={reviewCode}
              disabled={isStreaming}
              title="Ask the agent to review its own changes"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Sparkles size={12} /> Review code
            </button>
            <IconButton
              label="Expand all"
              size="sm"
              onClick={() => setCollapsed(new Set())}
            >
              <ChevronsUpDown size={14} />
            </IconButton>
            <IconButton
              label="Collapse all"
              size="sm"
              onClick={() => setCollapsed(new Set(diffs.map((d) => d.path)))}
            >
              <ChevronsDownUp size={14} />
            </IconButton>
          </div>
        )}
      </div>

      {/* Body: file list/tree (left) + diffs/file view (right) */}
      <div className="flex min-h-0 flex-1">
        <div className="w-56 shrink-0 overflow-y-auto border-r border-border">
          {mode === "changes" ? (
            <ChangedFilesList
              changes={status?.changes ?? []}
              selectedPath={selectedPath}
              onSelect={selectChangedFile}
            />
          ) : (
            <FileTree
              files={status?.tree ?? []}
              selectedPath={selectedPath}
              onSelect={(p) => {
                setSelectedPath(p);
              }}
            />
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-auto">
          {mode === "changes" ? (
            diffs.length === 0 ? (
              <EmptyChanges loading={loading} />
            ) : (
              <div className="flex flex-col gap-2 p-2">
                {diffs.map((d) => (
                  <DiffFileCard
                    key={d.path}
                    diff={d}
                    expanded={!collapsed.has(d.path)}
                    onToggle={() => toggleCard(d.path)}
                    registerRef={(el) => {
                      if (el) cardRefs.current.set(d.path, el);
                      else cardRefs.current.delete(d.path);
                    }}
                    comments={commentApiFor(d.path)}
                  />
                ))}
              </div>
            )
          ) : (
            <FileContentView file={file} selectedPath={selectedPath} />
          )}
        </div>
      </div>

      {/* Submit-comments bar (Claude-Code inline-review round-trip) */}
      {comments.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-hover/30 px-3 py-2">
          <MessagesSquare size={15} className="shrink-0 text-text-secondary" />
          <span className="text-xs text-text-secondary">
            {readyComments.length} comment{readyComments.length === 1 ? "" : "s"}
            {comments.length > readyComments.length &&
              ` (${comments.length - readyComments.length} empty)`}
          </span>
          <button
            type="button"
            onClick={() => setComments([])}
            className="ml-auto rounded-md px-2 py-1 text-xs text-text-secondary transition-colors hover:text-text-primary"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={submitComments}
            disabled={readyComments.length === 0 || isStreaming}
            className="motion-press inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendHorizonal size={13} />
            Submit to agent
            <span className="opacity-70">⌘⏎</span>
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyChanges({ loading }: { loading: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-text-secondary">
      <FileDiff size={28} className="opacity-40" />
      <p className="text-sm">{loading ? "Loading changes…" : "No changes yet"}</p>
      <p className="max-w-xs text-xs">
        Diffs appear here as the coding agent creates and edits files in this
        conversation&apos;s workspace.
      </p>
    </div>
  );
}

/** Read-only highlighted view of a browsed file. */
function FileContentView({
  file,
  selectedPath,
}: {
  file: WorkspaceFileContent | null;
  selectedPath: string | null;
}) {
  if (!selectedPath) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-text-secondary">
        Select a file to view its contents.
      </div>
    );
  }
  if (!file) {
    return (
      <div className="p-4 text-xs text-text-secondary">Loading {selectedPath}…</div>
    );
  }
  if (file.tooLarge) {
    return (
      <div className="p-4 text-xs text-text-secondary">
        {selectedPath} is too large to preview.
      </div>
    );
  }
  if (file.binary) {
    return (
      <div className="p-4 text-xs text-text-secondary">
        {selectedPath} is a binary file and can&apos;t be displayed.
      </div>
    );
  }
  const lines = file.content.split("\n");
  return (
    <div className="overflow-x-auto font-mono text-xs leading-relaxed">
      <div className="min-w-full py-1">
        {lines.map((ln, i) => (
          <div key={i} className="flex w-max min-w-full">
            <span className="w-12 shrink-0 select-none px-2 text-right tabular-nums text-text-secondary/50">
              {i + 1}
            </span>
            <code
              className="whitespace-pre pr-4 text-text-primary"
              dangerouslySetInnerHTML={{
                __html: ln === "" ? " " : highlightLine(ln, file.language),
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function Segmented({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center rounded-lg border border-border p-0.5">
      {children}
    </div>
  );
}

function Seg({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "bg-hover text-text-primary"
          : "text-text-secondary hover:text-text-primary",
      )}
    >
      {children}
    </button>
  );
}

export default WorkspacePanel;
