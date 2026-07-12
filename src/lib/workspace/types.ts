/**
 * Types for the coding-workspace review UI (file tree + diff viewer).
 * Kept in their own module (not src/lib/types.ts) so the feature adds no churn
 * to that hot, concurrently-edited file.
 */
import type { DiffHunk } from "@/lib/diff/lineDiff";

export type { DiffHunk, DiffLine, DiffLineType } from "@/lib/diff/lineDiff";

/** git-style single-letter status of a changed file. */
export type FileStatus = "A" | "M" | "D";

/** One entry in the changed-files list (left column of the review pane). */
export interface WorkspaceFileChange {
  path: string;
  status: FileStatus;
  adds: number;
  dels: number;
}

/** A single file's full diff (right column / per-file card). */
export interface WorkspaceFileDiff {
  path: string;
  status: FileStatus;
  adds: number;
  dels: number;
  /** Detected highlight.js language (from the extension), for coloring. */
  language?: string;
  hunks: DiffHunk[];
}

/** Review scope: everything since the empty baseline, or just one turn. */
export type WorkspaceScope = "all" | "lastTurn";

/** A draft inline review comment anchored to one diff line, before it's
 *  submitted to the agent as a follow-up turn (Claude-Code-style). */
export interface DraftComment {
  /** Stable anchor id: `${path}::${hunkIndex}::${lineIndex}`. */
  id: string;
  path: string;
  /** Human line label for the prompt, e.g. "L2". */
  lineLabel: string;
  /** The diff line's text, quoted back to the agent for context. */
  lineContent: string;
  /** The reviewer's comment text. */
  text: string;
}

/** GET /api/conversations/[id]/workspace response. */
export interface WorkspaceStatus {
  changes: WorkspaceFileChange[];
  /** Full on-disk file tree for browse mode (flat, sorted paths). */
  tree: WorkspaceTreeFile[];
  scope: WorkspaceScope;
  /** Whether any tool calls touched files at all in this conversation. */
  hasChanges: boolean;
  /** The most recent assistant message that changed files (the "Last turn"
   *  target), or null when none. */
  lastTurnMessageId: string | null;
}

/** A tracked file on disk, for the browse-mode tree. */
export interface WorkspaceTreeFile {
  path: string;
  /** File size in bytes. */
  size: number;
}

/** GET /api/conversations/[id]/workspace/file response (browse a file). */
export interface WorkspaceFileContent {
  path: string;
  content: string;
  language?: string;
  /** True when the file is binary / not shown as text. */
  binary: boolean;
  /** True when the file exceeds the read cap and was not loaded. */
  tooLarge: boolean;
}
