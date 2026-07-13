"use client";

import { cn } from "@/components/ui/cn";
import { StatusBadge, AddDelCounts, PathLabel } from "./bits";
import type { WorkspaceFileChange } from "@/lib/workspace/types";

/**
 * Left-column list of changed files (Claude Code reviewer style). Selecting a
 * row focuses that file's diff card in the right column.
 */
export function ChangedFilesList({
  changes,
  selectedPath,
  onSelect,
}: {
  changes: WorkspaceFileChange[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (changes.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-text-secondary">
        No changes yet.
      </div>
    );
  }
  return (
    <ul className="py-1 stagger-children">
      {changes.map((c) => (
        <li key={c.path}>
          <button
            type="button"
            onClick={() => onSelect(c.path)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
              selectedPath === c.path ? "bg-hover" : "hover:bg-hover/50",
            )}
          >
            <StatusBadge status={c.status} />
            <PathLabel path={c.path} className="flex-1" />
            <AddDelCounts adds={c.adds} dels={c.dels} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export default ChangedFilesList;
